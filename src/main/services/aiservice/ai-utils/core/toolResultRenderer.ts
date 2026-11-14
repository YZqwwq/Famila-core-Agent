import type { AgentToolResultEnvelope } from './agentTool'
export type ToolRuntimeNotice = { toolName: string; message: string; retryable?: boolean; guidance?: string }
export type ToolResultRenderer = {
  result?: (name: string, envelope: AgentToolResultEnvelope<unknown> | null) => string | null
  notice?: (input: ToolRuntimeNotice) => string | null
  failure?: (input: ToolRuntimeNotice) => string | null
}
let renderer: ToolResultRenderer = {}
export const configureToolResultRenderer = (value: ToolResultRenderer): void => { renderer = value }
export const renderToolResultForModel = (name: string, envelope: AgentToolResultEnvelope<unknown> | null) => renderer.result?.(name, envelope) ?? null
export const renderToolRuntimeNotice = (input: ToolRuntimeNotice) => renderer.notice?.(input) ?? null
export const renderToolRuntimeFailure = (input: ToolRuntimeNotice) => renderer.failure?.(input) ?? null
