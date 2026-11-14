import type { AgentWorkspaceContext } from '@share/cache/AItype/states/agentWorkspaceContext'
import type { PersonaScenePolicy } from '@share/cache/AItype/states/personaPolicy'

export interface WorkspaceRelatedToolset {
  id: string
  reason: string
}

export interface WorkspaceProfileDefinition {
  id: string
  matches: (workspace: AgentWorkspaceContext) => boolean
  autoToolsets: string[]
  autoTools?: string[]
  relatedToolsets: WorkspaceRelatedToolset[]
  scenePolicy?: PersonaScenePolicy
}

export interface ResolvedWorkspaceProfile {
  id: string
  autoToolsets: string[]
  autoTools: string[]
  relatedToolsets: WorkspaceRelatedToolset[]
  scenePolicy?: PersonaScenePolicy
}

const WORKSPACE_PROFILES: WorkspaceProfileDefinition[] = []
export const registerWorkspaceProfiles = (profiles: WorkspaceProfileDefinition[]): void => {
  WORKSPACE_PROFILES.push(...profiles)
}

const cloneScenePolicy = (
  policy: PersonaScenePolicy | undefined
): PersonaScenePolicy | undefined =>
  policy
    ? {
        ...policy,
        cognitiveDirections: [...policy.cognitiveDirections],
        workModes: policy.workModes?.map((mode) => ({
          ...mode,
          directions: [...mode.directions]
        }))
      }
    : undefined

export const resolveWorkspaceProfile = (
  workspace: AgentWorkspaceContext | null | undefined
): ResolvedWorkspaceProfile | undefined => {
  if (!workspace) return undefined
  const profile = WORKSPACE_PROFILES.find((candidate) => candidate.matches(workspace))
  if (!profile) return undefined

  return {
    id: profile.id,
    autoToolsets: [...profile.autoToolsets],
    autoTools: [...(profile.autoTools ?? [])],
    relatedToolsets: profile.relatedToolsets.map((toolset) => ({ ...toolset })),
    scenePolicy: cloneScenePolicy(profile.scenePolicy)
  }
}
