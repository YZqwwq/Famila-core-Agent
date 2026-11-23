import { startFamilaRuntime } from './familaRuntime'
import { databaseStage } from './hdsi/postgres'
import { resolve } from 'node:path'
import { startHdsiRuntime } from './hdsi/hdsiRuntime'
import type { FamilaCoreOptions } from '../index'
import type { AgentRuntime } from './agentRuntime'
import { createLivingTools, livingToolOptions } from './hdsi/livingTools'

export function startAgentRuntime(options: FamilaCoreOptions, engine = process.env.FAMILA_CHAT_ENGINE ?? 'langgraph'): Promise<AgentRuntime> {
  if (engine === 'hdsi') {
    const stage = databaseStage()
    return startHdsiRuntime({ ...options, dataDirectory: resolve(options.dataDirectory, stage) }, {
      databaseStage: stage,
      mode: (process.env.FAMILA_HDSI_MODE ?? 'native') as 'native' | 'fast',
      ...(process.env.FAMILA_HDSI_ACTIONS === '1' ? { sceneActions: { tools: createLivingTools(livingToolOptions(options.model)) } } : {})
    })
  }
  if (engine === 'langgraph') return startFamilaRuntime(options)
  return Promise.reject(new Error('FAMILA_CHAT_ENGINE must be langgraph or hdsi.'))
}
