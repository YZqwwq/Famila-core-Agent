import { startFamilaRuntime } from './familaRuntime'
import { startHdsiRuntime } from './hdsi/hdsiRuntime'
import type { FamilaCoreOptions } from '../index'
import type { AgentRuntime } from './agentRuntime'

export function startAgentRuntime(options: FamilaCoreOptions, engine = process.env.FAMILA_CHAT_ENGINE ?? 'langgraph'): Promise<AgentRuntime> {
  if (engine === 'hdsi') return startHdsiRuntime(options, { mode: (process.env.FAMILA_HDSI_MODE ?? 'native') as 'native' | 'fast' })
  if (engine === 'langgraph') return startFamilaRuntime(options)
  return Promise.reject(new Error('FAMILA_CHAT_ENGINE must be langgraph or hdsi.'))
}
