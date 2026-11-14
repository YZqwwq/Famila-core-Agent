import { normalizeAgentWorkspaceContext, type AgentWorkspaceContext } from '@share/cache/AItype/states/agentWorkspaceContext'
type WorkspaceResolver = (value: unknown) => Promise<AgentWorkspaceContext | undefined>
let resolver: WorkspaceResolver | undefined
export const configureWorkspaceResolver = (value: WorkspaceResolver): void => { resolver = value }
export const resolveAgentWorkspaceContext: WorkspaceResolver = async value =>
  resolver ? resolver(value) : normalizeAgentWorkspaceContext(value)
