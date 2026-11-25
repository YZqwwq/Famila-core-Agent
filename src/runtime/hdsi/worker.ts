import { familaStoryDefaults } from './persona'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from 'koishi'
import { FamilaPostgresDriver, postgresConfig } from './postgres'
import { SQLiteDriver } from '@minatojs/driver-sqlite'
import { HTTP } from '@cordisjs/plugin-http'

let upstream: any
const rawSend = process.send!.bind(process)
const accepted = new Set<string>()
const incoming = new Set<string>()
const recoveryReceipts = new Map<string, (ids: string[]) => void>()
let app: Context, service: any, dispose: (() => void) | undefined, timer: ReturnType<typeof setInterval>
let ready = false, stopping = false
let drainRequested = false
let evaluationEnabled = false, pageObservationEnabled = false, evaluationBusy = 0
const publish = (message: unknown) => { if (process.connected) rawSend(message) }

// Observe upstream bridge acknowledgements; retain its protocol and delivery path.
process.send = ((frame: any, ...args: any[]) => {
  if (frame?.event === 'inbound-result') {
    incoming.delete(frame.payload.requestId)
    if (frame.payload.accepted) accepted.add(frame.payload.requestId)
  }
  return (rawSend as any)(frame, ...args)
}) as typeof process.send

function status() {
  return { ready, pendingTurns: evaluationBusy + incoming.size + (service?.turnEngine.pendingTurnCount() ?? 0),
    backgroundTails: service?.familaDetachedTails ?? 0 }
}
function heartbeat() {
  const state = status()
  publish({ type: 'famila-status', state })
  if (ready && !state.pendingTurns && !state.backgroundTails && accepted.size) {
    publish({ type: 'famila-settled', ids: [...accepted] })
    accepted.clear()
  }
  if (drainRequested && ready && !state.pendingTurns && !state.backgroundTails) {
    drainRequested = false
    publish({ type: 'famila-drained' })
  }
}

async function start(input: any) {
  if (app) throw new Error('Worker already started.')
  const execution = input.execution ?? {}
  upstream = require(execution.upstreamBundle ?? resolve(__dirname, '../../hdsi/upstream.cjs'))
  evaluationEnabled = execution.evaluation === true
  if (evaluationEnabled && (execution.databaseStage === 'prod' || process.env.NODE_ENV === 'production')) {
    throw new Error('Evaluation is unavailable in production.')
  }
  pageObservationEnabled = evaluationEnabled && execution.databaseStage === 'test'
  const fast = execution.mode === 'fast'
  const normalizedTransport = evaluationEnabled && execution.normalizedTransport === true
  const model = input.model
  if (!model?.model || !model.baseURL) throw new Error('Missing HDSI model configuration.')
  app = new Context()
  app.baseDir = input.dataDirectory
  app.plugin(HTTP)
  if (execution.databaseStage) app.plugin(FamilaPostgresDriver as any, postgresConfig(execution.databaseStage))
  else app.plugin(SQLiteDriver as any, { path: resolve(input.dataDirectory, 'conversation.sqlite') })
  const config = upstream.Config({
    model: { providers: [{ id: 'famila', label: 'Famila model', mode: 'openai-compatible', enabled: true,
      model: model.model, endpoint: model.baseURL.replace(/\/$/, '') + '/chat/completions', apiKey: model.modelKey ?? '',
      useForMain: true, useForCompaction: true, useForAlter: true,
      extraBody: JSON.stringify({ enable_thinking: false }) }],
      mainMaxTokens: 2048, mainTimeout: execution.sceneActionsEnabled ? 120000 : 30000, mainStreamingMode: fast ? 'experimental' : 'off',
      failover: { enabled: false, maxAttemptsPerProvider: 1 } },
    runtime: { autoCreate: true, autoAdvanceEnabled: false,
      ...(fast || normalizedTransport ? { userMessageDebounceSeconds: 0.1, typingBaseDelaySeconds: 0,
        typingMaxDelaySeconds: 0, typingJitterRatio: 0, splitReplyMessages: false } : {}),
      narrativeRetryMaxAttempts: 0, sweepIntervalMinutes: 60 },
    memory: { backgroundIntervalMinutes: 60 },
    storyDefaults: familaStoryDefaults,
    logging: { level: 'warn' }
  })
  let initialized!: () => void
  const initialization = new Promise<void>(resolvePromise => { initialized = resolvePromise })
  app.inject(['database', 'http'], ctx => {
    ctx.model.extend('famila_hdsi_tail' as any, { id: 'string(255)', storyId: 'string(255)',
      sourceEntryId: 'unsigned', status: 'string(32)', script: 'text', updatedAt: 'timestamp' } as any, { primary: 'id' })
    if (fast) config.familaFastChat = { maxDetached: 2,
      onVisibleCommitted: (id: string) => publish({ type: 'famila-visible-committed', id }),
      onTail: async (entry: any) => {
      await ctx.database.upsert('famila_hdsi_tail' as any, [{ ...entry, script: entry.script ?? '', updatedAt: new Date() }])
      heartbeat()
    } }
    service = new upstream.InterludeService(ctx, config)
    dispose = upstream.installDesktopBridge(service)
    initialized()
  })
  await app.start()
  await initialization
  await app.database.set('famila_hdsi_tail' as any, { status: 'pending' }, { status: 'interrupted', updatedAt: new Date() })
  // The transport journal is durable before ACK. Repair the small crash window
  // between that ACK and HDSI's own visible-message checkpoint without re-sending.
  for (const delivered of input.delivered ?? []) {
    const rows = await app.database.get('interlude_script_entry' as any, {
      kind: 'user-message', 'metadata.messageId': delivered.id
    }) as any[]
    let source = rows[0]
    if (!source) {
      const event = { transport: 'sandbox', accountKey: 'sandbox:famila', platform: 'sandbox', selfId: 'famila',
        senderId: 'user', kind: 'private', content: delivered.text, occurredAt: new Date(delivered.created).toISOString(), rawMessageId: delivered.id }
      const session = upstream.desktopSession(event, async () => { throw new Error('Recovery must not deliver.') })
      const story = await service.createStory(session)
      const participant = await service.ensureParticipant(story, session)
      source = await service.appendEntry(story.id, { kind: 'user-message', actor: 'user', content: delivered.text,
        occurredAt: event.occurredAt, metadata: { messageId: delivered.id, platform: 'sandbox', selfId: 'famila', recoveredFromOutbox: true } }, new Date(delivered.created), participant.id)
    }
    const recorded = await app.database.get('interlude_script_entry' as any, { storyId: source.storyId,
      kind: 'character-message', 'metadata.familaRequestId': delivered.id }) as any[]
    if (!recorded.length) {
      const candidates = await app.database.get('interlude_script_entry' as any, {
        storyId: source.storyId, participantId: source.participantId, kind: 'character-message', id: { $gt: source.id }
      }) as any[]
      const matching = candidates.find(row => row.content.replace(/<sep\s*\/?>/g, '\n') === delivered.content)
      if (matching) await app.database.set('interlude_script_entry' as any, { id: matching.id }, {
        metadata: { ...matching.metadata, familaRequestId: delivered.id }
      })
      else await service.appendEntry(source.storyId, { kind: 'character-message', actor: 'character', content: delivered.content,
        occurredAt: new Date(delivered.created).toISOString(), metadata: { visible: true, recoveredFromOutbox: true, familaRequestId: delivered.id } }, new Date(delivered.created), source.participantId)
    }
  }
  // Process timers disappear on shutdown. Re-arm the native delivery timer for
  // persisted split messages; HDSI still owns their contents, timing and cancellation.
  const pendingSegments = await app.database.get('interlude_intent' as any, { status: 'pending', type: 'split-message' }, ['storyId']) as { storyId: string }[]
  if (pendingSegments.length) {
    await service.ensureEndpointRegistry()
    service.noteEndpointConnection('sandbox:famila', true)
  }
  for (const storyId of new Set(pendingSegments.map(row => row.storyId))) await service.scheduleNextSplitWake(storyId)
  ready = true
  timer = setInterval(heartbeat, 50)
  heartbeat()
}

async function inbound(input: any) {
  if (!ready || stopping) return
  incoming.add(input.id)
  heartbeat()
  const event = { transport: 'sandbox', accountKey: 'sandbox:famila', platform: 'sandbox', selfId: 'famila',
    senderId: 'user', senderName: '用户', kind: 'private', content: input.text,
    rawMessageId: input.id, traceId: input.id, occurredAt: new Date().toISOString() }
  if (input.recovering) {
    const rows = await app.database.get('interlude_script_entry' as any, {
      kind: 'user-message', 'metadata.messageId': input.id
    }) as any[]
    if (rows.length) {
      const entry = rows[0]
      const session = upstream.desktopSession(event, (payload: any) => new Promise<string[]>(resolvePromise => {
        const deliveryId = randomUUID()
        recoveryReceipts.set(deliveryId, resolvePromise)
        publish({ type: 'hdsi-desktop', event: 'delivery', payload: { ...payload, traceId: input.id,
          deliveryId, occurredAt: new Date().toISOString(), intentKey: `recovery:${input.id}` } })
      }))
      const story = await service.getStory(entry.storyId)
      const participant = await service.getParticipant(entry.participantId)
      service.bufferUserNarrative(story, participant, session, new Date(entry.occurredAt), [], entry.content, [], [], undefined)
      incoming.delete(input.id); accepted.add(input.id)
      publish({ type: 'hdsi-desktop', event: 'inbound-result', payload: { requestId: input.id, accepted: true, ok: true } })
      heartbeat()
      return
    }
  }
  process.emit('message', { type: 'hdsi-desktop', command: 'inbound', value: { requestId: input.id, event } }, undefined)
}

process.on('message', (message: any) => {
  if (message?.type === 'famila-workbench') {
    void workbench(message.patch).then(value => publish({ type: 'famila-evaluation-result', id: message.id, value }),
      () => publish({ type: 'famila-evaluation-result', id: message.id, error: '工作台读取或保存失败。' }))
  }
  if (message?.type === 'famila-evaluation' && evaluationEnabled) {
    evaluationBusy++
    heartbeat()
    void (async () => {
      if (message.command === 'restrict-context') {
        service.config.runtime.contextEntryLimit = 1
        service.config.runtime.contextTimeWindowMinutes = 0
        return { contextEntryLimit: 1, contextTimeWindowMinutes: 0 }
      }
      if (message.command === 'page-observation') {
        if (!pageObservationEnabled) throw new Error('Page observation requires famila_test.')
        const [source] = await app.database.get('interlude_script_entry' as any, {
          kind: 'user-message', 'metadata.messageId': message.sourceId
        }) as any[]
        if (!source) throw new Error('Missing initiating message')
        const story = await service.getStory(source.storyId)
        const now = new Date()
        await service.serial(story.id, async () => {
          await service.appendEntry(story.id, { kind: 'world-event', actor: 'system',
            content: message.observation, occurredAt: now.toISOString(),
            metadata: { sourceEntryId: source.id } }, now, source.participantId)
          await service.appendIntent(story.id, { type: 'page-observation', summary: message.observation,
            notBefore: new Date(now.getTime() + 1).toISOString(),
            payload: { userInitiated: true, sourceEntryIds: [source.id], traceId: message.sourceId } }, now, source.participantId)
        })
        await new Promise(resolve => setTimeout(resolve, 2))
        const drafts = await service.advanceStory(story, false)
        if (drafts.length) await service.sendScheduledMessages(story, drafts.map((draft: any) => ({ ...draft, traceId: message.sourceId })))
        return { outgoing: drafts.length }
      }
      if (message.command === 'compact') {
        const stories = await app.database.get('interlude_story' as any, {}) as any[]
        return Promise.all(stories.map(story => service.compactStory(story, true)))
      }
      if (message.command !== 'snapshot') throw new Error('Unknown evaluation command.')
      const tables = ['interlude_story', 'interlude_participant', 'interlude_script_entry', 'interlude_fact',
        'interlude_intent', 'interlude_scene', 'interlude_arc', 'interlude_state_patch', 'famila_hdsi_tail']
      const result: Record<string, unknown> = {}
      for (const table of tables) result[table] = await app.database.get(table as any, {})
      return result
    })().then(value => publish({ type: 'famila-evaluation-result', id: message.id, value }), () =>
      publish({ type: 'famila-evaluation-result', id: message.id, error: 'Upstream evaluation failed.' }))
      .finally(() => { evaluationBusy--; heartbeat() })
  }
  if (message?.type === 'famila-drain') { drainRequested = true; heartbeat() }
  if (message?.type === 'famila-start') void start(message).catch(() => { publish({ type: 'famila-fatal' }); process.exit(1) })
  if (message?.type === 'famila-inbound') void inbound(message).catch(() => {
    incoming.delete(message.id)
    publish({ type: 'hdsi-desktop', event: 'inbound-result', payload: { requestId: message.id, accepted: false } })
  })
  if (message?.type === 'hdsi-desktop' && message.command === 'delivery-result') {
    const receipt = recoveryReceipts.get(message.value.deliveryId)
    if (receipt) { recoveryReceipts.delete(message.value.deliveryId); receipt(message.value.messageIds ?? []) }
  }
  if (message?.type === 'famila-stop' && !stopping) {
    stopping = true
    clearInterval(timer)
    dispose?.()
    void app.stop().finally(() => process.disconnect())
  }
})

async function workbench(patch?: Record<string, string>) {
  const session = upstream.desktopSession({ transport: 'sandbox', accountKey: 'sandbox:famila', platform: 'sandbox',
    selfId: 'famila', senderId: 'user', senderName: '用户', kind: 'private', content: '', occurredAt: new Date().toISOString() },
    async () => { throw new Error('Workbench session cannot send messages.') })
  let story = await service.findStory(session)
  if (patch) {
    story ??= await service.createStory(session)
    await service.serial(story.id, async () => {
      const fresh = await service.getStory(story.id)
      const { name, profile, ...fields } = patch
      story = await service.updateSetting(fresh, { ...fields, character: { ...fresh.setting.character,
        ...(name === undefined ? {} : { name }), ...(profile === undefined ? {} : { profile }) } })
    })
  }
  const setting = story?.setting ?? service.initialStorySetting()
  const { runtime, model } = service.config
  const recent = story ? await service.recentEntries(story.id, 50) : []
  const research = story ? await app.database.get('interlude_web_observation' as any, { storyId: story.id }, { limit: 20 }) as any[] : []
  return { storyId: story?.id ?? null, setting: { name: setting.character.name, profile: setting.character.profile,
    world: setting.world, location: setting.location, supportingCast: setting.supportingCast, perspective: setting.perspective,
    relationship: setting.relationship, style: setting.style },
    scenes: recent.filter((r: any) => r.kind === 'script').slice(-6).reverse().map((r: any) => ({ content: r.content, created: r.occurredAt })),
    research: research.map(r => ({ title: r.title ?? r.url ?? '网页观察', content: r.summary ?? '' })),
    config: { contextEntries: runtime.contextEntryLimit, contextMinutes: runtime.contextTimeWindowMinutes,
      outputTokens: model.mainMaxTokens, debounce: runtime.userMessageDebounceSeconds, split: runtime.splitReplyMessages, autoAdvance: runtime.autoAdvanceEnabled } }
}
process.on('disconnect', () => { if (!stopping) { stopping = true; clearInterval(timer); dispose?.(); void app?.stop().finally(() => process.exit(0)) } })
