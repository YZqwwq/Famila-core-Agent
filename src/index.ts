import 'reflect-metadata'
import { join } from 'node:path'
import type { DataSource } from 'typeorm'
import { initDatabase, AppDataSource } from './main/database'
import { configureCorePaths, getCoreDataDirectory } from './main/config/pathConfig'
import { initMemoryStorage } from './main/config/storageInit'
import { configureAgentTraceStorage } from './main/services/log/trace/agentTraceStore'
import { mainAgentDispatchService } from './main/services/aiservice/runtime/queue/mainAgentDispatchQueueService'
import { mainAgentEventRecoveryService } from './main/services/aiservice/runtime/queue/mainAgentEventRecoveryQueueService'
import { taskRecoveryService } from './main/services/task/taskRecoveryService'
import { subAgentExecutionQueueService } from './main/services/task/queue/subAgentExecutionQueueService'
import { aiService } from './main/services/aiservice/aiService'
import { modelConfigService } from './main/services/modelconfig/modelConfigService'
import { mainAgentRunControlService } from './main/services/aiservice/runtime/mainAgentRunControlService'
import type { ModelConfigInput } from './share/cache/AItype/model/modelConfigPayload'
import { conversationMaintenance } from './main/services/aiservice/runtime/conversationMaintenance'

export type FamilaCoreOptions = {
  /** One persistent agent identity per process. Use a separate directory per identity. */
  dataDirectory: string
  resourceDirectory?: string
  databasePath?: string
  /** Host owns schema migrations and connection lifetime when supplying a DataSource. */
  dataSource?: DataSource
  model?: Partial<ModelConfigInput>
  /** Recover and enqueue unfinished persisted work at startup. Defaults to true. */
  recover?: boolean
}

let started = false
export interface FamilaCore {
  chat: typeof aiService
  models: typeof modelConfigService
  close(): Promise<void>
}
export async function initializeFamilaCore(options: FamilaCoreOptions): Promise<FamilaCore> {
  if (started) throw new Error('Only one Famila core lifecycle is supported per process.')
  started = true
  configureCorePaths(options)
  configureAgentTraceStorage(join(getCoreDataDirectory(), 'traces'))
  try {
    await initDatabase({
      databasePath: options.databasePath ?? join(getCoreDataDirectory(), 'agent.sqlite'),
      dataSource: options.dataSource
    })
    await initMemoryStorage()
    if (options.model) {
      const { id: _id, updatedAt: _updatedAt, ...defaults } = await modelConfigService.getModelConfig()
      await modelConfigService.saveModelConfig({ ...defaults, ...options.model })
    }
    if (options.recover !== false) {
      await taskRecoveryService.recoverInterruptedExecutions()
      await subAgentExecutionQueueService.enqueueQueuedExecutions()
      await mainAgentEventRecoveryService.reconcileTurnOwnedEvents()
      await mainAgentEventRecoveryService.reconcileLegacyPausedTurn()
      await mainAgentEventRecoveryService.reconcileTaskNotificationEvents()
      await mainAgentEventRecoveryService.enqueueQueuedEvents()
      await taskRecoveryService.enqueuePendingNotifications()
    }
  } catch (error) {
    if (!options.dataSource && AppDataSource?.isInitialized) await AppDataSource.destroy()
    throw error
  }
  conversationMaintenance.request()
  return {
    chat: aiService,
    models: modelConfigService,
    async close(): Promise<void> {
      if (mainAgentDispatchService.getState() !== 'idle' || !subAgentExecutionQueueService.isIdle()) {
        throw new Error('Wait for queued and active turns to finish before closing Famila core.')
      }
      await conversationMaintenance.close()
      if (!options.dataSource && AppDataSource.isInitialized) await AppDataSource.destroy()
    }
  }
}

export { aiService, modelConfigService, mainAgentRunControlService }
export { agent } from './main/services/aiservice/agentrsystem/agentReactSystem'
export { MessagesState } from './main/services/aiservice/agentrsystem/state/messageState'
export { coreEntities } from './main/database/coreEntities'
export { AppDataSource } from './main/database'
export { registerAgentTools, getMainAgentToolEntries } from './main/services/aiservice/ai-utils/toolkits/mainAgentToolRegistry'
export * from './main/services/aiservice/ai-utils/core/agentTool'
export type { AgentToolRegistryEntry, ToolsetRegistryEntry, ToolActivationState } from './main/services/aiservice/ai-utils/toolkits/toolRegistryTypes'
export { registerWorkspaceProfiles } from './main/services/aiservice/agentrsystem/workspaceProfileRegistry'
export { configureAgentHabitat } from './main/services/aiservice/prompt/main_agent/persona/agentHabitatPrompt'
export type { WorkspaceProfileDefinition } from './main/services/aiservice/agentrsystem/workspaceProfileRegistry'
export { configureWorkspaceResolver } from './main/services/aiservice/runtime/agentWorkspaceContextResolver'
export { configureResourceResolver } from './main/protocols/resourceProtocol'
export { configureToolResultRenderer } from './main/services/aiservice/ai-utils/core/toolResultRenderer'
export type { ToolResultRenderer } from './main/services/aiservice/ai-utils/core/toolResultRenderer'
export { configureHostCommit } from './main/services/aiservice/runtime/orchestration/hostCommit'
export { registerSubAgent } from './main/services/task/subAgentRegistry'
export type { SubAgentRegistryEntry } from './main/services/task/subAgentRegistry'
export { subAgentExecutionQueueService } from './main/services/task/queue/subAgentExecutionQueueService'
export { taskService } from './main/services/task/taskService'
export { taskExecutionService } from './main/services/task/taskExecutionService'
export { taskContinuationService } from './main/services/task/taskContinuationService'
export type { ModelConfigInput } from './share/cache/AItype/model/modelConfigPayload'
export type { MainAgentUserMessageInput } from './share/cache/AItype/states/mainAgentMessageContent'
export type { StreamChunk } from './share/cache/render/aiagent/aiContent'
