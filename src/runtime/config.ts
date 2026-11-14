import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import type { ModelConfigInput } from '../share/cache/AItype/model/modelConfigPayload'
import type { ModelVendor } from '../share/cache/AItype/model/modelVender'

export function loadRuntimeConfig() {
  if (existsSync('.env')) loadEnvFile('.env')
  return readRuntimeConfig()
}

export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = (key: string) => env[key]?.trim() || undefined
  const model: Partial<ModelConfigInput> = {}
  const vendor = (key: string): ModelVendor | undefined => {
    const candidate = value(key)
    if (candidate && !['openai', 'anthropic', 'google'].includes(candidate)) {
      throw new Error(`${key} must be openai, anthropic or google.`)
    }
    return candidate as ModelVendor | undefined
  }
  const put = <K extends keyof ModelConfigInput>(key: K, item: ModelConfigInput[K] | undefined) => {
    if (item !== undefined) model[key] = item
  }
  put('model', value('FAMILA_MODEL'))
  put('modelKey', value('FAMILA_MODEL_API_KEY'))
  put('baseURL', value('FAMILA_MODEL_BASE_URL'))
  put('vendor', vendor('FAMILA_MODEL_VENDOR'))
  // Explicit main-model overrides also configure the quick model unless separately overridden.
  put('quickModel', value('FAMILA_QUICK_MODEL') ?? model.model)
  put('quickModelKey', value('FAMILA_QUICK_API_KEY') ?? model.modelKey)
  put('quickBaseURL', value('FAMILA_QUICK_BASE_URL') ?? model.baseURL)
  put('quickVendor', vendor('FAMILA_QUICK_VENDOR') ?? model.vendor)
  const responses = value('FAMILA_USE_RESPONSES_API')
  if (responses !== undefined) {
    if (!['true', 'false'].includes(responses)) throw new Error('FAMILA_USE_RESPONSES_API must be true or false.')
    model.useResponsesApi = responses === 'true'
  }
  const host = value('FAMILA_HOST') ?? '127.0.0.1'
  const port = Number(value('FAMILA_PORT') ?? 4317)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('FAMILA_PORT must be an integer between 0 and 65535.')
  const token = value('FAMILA_API_TOKEN')
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !token) {
    throw new Error('Set FAMILA_API_TOKEN before listening outside loopback.')
  }
  return {
    core: { dataDirectory: resolve(value('FAMILA_DATA_DIR') ?? '.famila'), model },
    server: { host, port, token }
  }
}
