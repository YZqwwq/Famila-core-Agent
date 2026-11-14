import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

let dataDirectory: string | undefined
let resourceDirectory = resolve(__dirname, '../../../resources/prompt-resource')
export function configureCorePaths(options: { dataDirectory: string; resourceDirectory?: string }): void {
  dataDirectory = resolve(options.dataDirectory)
  if (options.resourceDirectory) resourceDirectory = resolve(options.resourceDirectory)
}
export function getCoreDataDirectory(): string {
  if (!dataDirectory) throw new Error('Call initializeFamilaCore({ dataDirectory }) before using persistent services.')
  return dataDirectory
}
const dir = (...parts: string[]): string => {
  const value = join(getCoreDataDirectory(), ...parts)
  mkdirSync(value, { recursive: true })
  return value
}
export const getStaticFamilaDailyRoot = () => join(resourceDirectory, 'famila-daily')
export const getDataFamilaDailyRoot = () => dir('prompt-resource', 'famila-daily')
export const getAiServicePromptDir = () => dir('aiservice', 'prompt')
export const getAuthoredNarrativeTemplatePath = () => join(getAiServicePromptDir(), 'character.md')
export const getExpressionPromptProfilePath = () => join(getAiServicePromptDir(), 'expression.md')
export const getMoodPromptProfilePath = () => join(getAiServicePromptDir(), 'mood.md')
export const getAgentHabitsPath = () => join(getAiServicePromptDir(), 'agent-habits.json')
export const getPersonaStatePath = () => join(dir('prompt-resource', 'famila-daily', 'role'), 'personal_state.json')
export const getPersonaStateFallbackPath = () => join(getStaticFamilaDailyRoot(), 'role', 'persona_state.json')
export const getPersonaConfigPath = () => join(getDataFamilaDailyRoot(), 'persona-config.json')
export const getPersonaConfigFallbackPath = () => join(resourceDirectory, 'persona-config.json')
export const getRuntimeStaticRoot = () => dir('static')
export const getStaticUploadDir = () => dir('static', 'uploads')
export const getStaticAvatarDir = () => dir('static', 'avatars')
export const getAvatarProfilesPath = () => join(getStaticAvatarDir(), 'profiles.json')
