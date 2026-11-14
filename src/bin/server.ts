#!/usr/bin/env node
import { startAgentRuntime } from '../runtime/startRuntime'
import { loadRuntimeConfig } from '../runtime/config'
import { createFamilaServer } from '../server'

async function main() {
  const config = loadRuntimeConfig()
  const runtime = await startAgentRuntime(config.core)
  const server = createFamilaServer(runtime, { ...config.server, logger: true })
  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    server.log.info('Draining accepted agent work before shutdown.')
    void server.close().catch(error => { console.error(error); process.exitCode = 1 })
  }
  try {
    await server.listen(config.server)
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  } catch (error) {
    await server.close()
    throw error
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
