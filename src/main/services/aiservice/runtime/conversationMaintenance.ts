import { loadPersonaState, savePersonaState } from '../agentrsystem/manager/personal/personalManager'
import { interactionObservationService } from '../agentrsystem/manager/personal/interactionObservationService'
import { memorySlotService } from '../agentrsystem/manager/memory/memorySlotService'
import { memoryManager } from '../agentrsystem/manager/memory/MemoryManager'
import { agentLifeStateService } from '../agentrsystem/manager/selfmodel/agentLifeStateService'
import { selfCoreAuthorityService } from '../agentrsystem/manager/selfmodel/selfCoreAuthorityService'
import { createTurnWorkspace } from '../agentrsystem/state/turnWorkspace'
import { personaNode } from '../agentrsystem/node/personanode/personanode'
import type { MessagesState } from '../agentrsystem/state/messageState'
import { PersonaStateRecord } from '@share/entity/database/PersonaStateRecord'
import { MemorySlotRecord } from '@share/entity/database/MemorySlotRecord'
import { Message } from '@share/entity/database/Message'
import { AppDataSource } from '../../../database'
import { inferConversationContinuity } from './conversationContinuity'
import { NEUTRAL_IDENTITY_PROMPT } from '../prompt/main_agent/persona/neutralIdentity'

/** One bounded worker. Durable observation IDs are the restart cursor, not this timer. */
class ConversationMaintenance {
  private timer?: ReturnType<typeof setTimeout>
  private running?: Promise<void>
  private requested = false
  private stopping = false
  private failures = 0
  private conflicts = 0
  private lastObservationId = 0
  getStatus() { return { running: Boolean(this.running), pending: this.requested, failures: this.failures,
    conflicts: this.conflicts, lastObservationId: this.lastObservationId } }

  request(): void {
    if (this.stopping || process.env.FAMILA_CHAT_MODE === 'legacy') return
    this.requested = true
    if (!this.timer && !this.running) this.timer = setTimeout(() => {
      this.timer = undefined
      this.start()
    }, 25)
  }

  private start(): void {
    this.requested = false
    this.running = this.runBatch().catch(() => {
      this.failures++
      // No raw model response / credentials in operational logs. Cursor remains durable.
      console.warn('Conversation maintenance failed; unprocessed observations remain for retry.')
    }).finally(() => {
      this.running = undefined
      if (this.requested && !this.stopping) this.request()
    })
  }

  async close(): Promise<void> {
    this.stopping = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    // Finish one bounded batch. Remaining observations recover on the next start.
    if (!this.running && this.requested) this.start()
    await this.running
  }

  private async runBatch(): Promise<void> {
    const persona = await loadPersonaState()
    if (!persona) return
    // Compare persisted versions, not the normalized state's default timestamp.
    const personaBase = await AppDataSource.getRepository(PersonaStateRecord).findOneBy({ id: 1 })
    const observations = await interactionObservationService.listSince(persona.last_observation_id, 4)
    if (observations.length) {
      const slotBase = await AppDataSource.getRepository(MemorySlotRecord).findOneBy({ id: 1 })
      const slots = await memorySlotService.getSnapshot()
      const workspace = createTurnWorkspace({ eventId: 'maintenance', turnId: 0,
        sessionId: 'default', runId: 'maintenance', persona, memorySlots: slots,
        selfCore: await selfCoreAuthorityService.load(), lifeState: await agentLifeStateService.load() })
      const latest = observations.at(-1)!
      const text = String(latest.payload.text ?? latest.summary ?? '')
      const state = { messages: [], turnWorkspace: workspace } as unknown as typeof MessagesState.State
      const patch = await personaNode(state, { currentEventText: text, source: 'user', recentHistory: [] }, observations,
        NEUTRAL_IDENTITY_PROMPT)
      const exchanges = await Promise.all(observations.filter(item => item.type === 'user_message').map(async item => {
        const reply = await AppDataSource.getRepository(Message).findOne({
          where: { eventId: String(item.payload.eventId ?? ''), role: 'ai', status: 'committed' }, order: { id: 'DESC' }
        })
        return { user: String(item.payload.text ?? ''), reply: reply?.content ?? '', turnId: reply?.turnId }
      }))
      // A continuity failure does not discard successful mood/preference inference.
      let narrative = ''
      try { if (exchanges.length) narrative = await inferConversationContinuity(workspace.base.lifeState.narrative, exchanges) }
      catch { this.failures++ }
      // Serialize with foreground memory commits; model inference is entirely outside this lock.
      let committed = false
      await memoryManager.commitTurnAtomically([], async manager => {
        const current = await manager.findOneBy(PersonaStateRecord, { id: 1 })
        const currentSlots = await manager.findOneBy(MemorySlotRecord, { id: 1 })
        if (!current || current.lastUpdated !== personaBase?.lastUpdated ||
            current.lastObservationId !== persona.last_observation_id ||
            currentSlots?.payloadJson !== slotBase?.payloadJson ||
            currentSlots?.lastObservationId !== slotBase?.lastObservationId) {
          this.conflicts++
          return
        }
        const draft = patch.turnWorkspace?.draft
        if (draft?.persona && draft.memorySlots) {
          await savePersonaState({ ...draft.persona, last_observation_id: latest.id }, manager)
          committed = true
          this.lastObservationId = latest.id
          // Only update mood fields; slot reconciliation owns its independent observation cursor.
          await memorySlotService.saveSnapshotWithManager({ ...slots,
            ai_mood: draft.memorySlots.ai_mood, user_mood: draft.memorySlots.user_mood }, manager)
          const sourceTurnId = exchanges.at(-1)?.turnId
          if (narrative && sourceTurnId) await agentLifeStateService.commitCandidateWithManager(
            { narrative, sourceTurnId }, workspace.base.lifeState.revision, manager)
        }
      })
      if (committed && observations.length === 4) this.requested = true
    }
    await memoryManager.archivePendingIfNeeded()
  }
}

export const conversationMaintenance = new ConversationMaintenance()
