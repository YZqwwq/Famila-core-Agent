const { startFamilaRuntime } = require('../../dist/runtime/familaRuntime')
const { createFamilaServer } = require('../../dist/server')

async function main() {
  const dataDirectory = process.argv[2]
  const baseURL = process.argv[3]
  const runtime = await startFamilaRuntime({
    dataDirectory,
    ...(baseURL ? { model: {
      vendor: 'openai', model: 'fixture-main', modelKey: 'fixture', baseURL,
      quickVendor: 'openai', quickModel: 'fixture-quick', quickModelKey: 'fixture', quickBaseURL: baseURL,
      streaming: true, useResponsesApi: false
    } } : {})
  })
  const server = createFamilaServer(runtime)
  const address = await server.listen({ port: 0, host: '127.0.0.1' })
  process.on('message', async message => {
    try {
      if (message.type === 'seedQueued') {
        const db = require('../../dist').AppDataSource
        const { Message } = require('../../dist/share/entity/database/Message')
        const { MainAgentEventRecord } = require('../../dist/share/entity/database/MainAgentEventRecord')
        await db.transaction(async manager => {
          const content = [{ type: 'text', text: '重启后继续聊蓝色风铃。' }]
          const row = await manager.save(Message, manager.create(Message, {
            role: 'user', content: content[0].text, contentJson: JSON.stringify(content),
            requestId: 'recover-queued', eventId: 'recover-queued', sessionId: 'default'
          }))
          await manager.save(MainAgentEventRecord, manager.create(MainAgentEventRecord, {
            id: 'recover-queued', type: 'user_message', source: 'user', sessionId: 'default',
            priority: 'interactive', createdAtMs: Date.now(), dedupeKey: 'user_message:recover-queued',
            payloadJson: JSON.stringify({ messageId: row.id, content }), status: 'queued'
          }))
        })
        process.send({ type: 'seeded' })
      }
      if (message.type === 'inspect') {
        const db = require('../../dist').AppDataSource
        const { recallAgentMemory } = require('../../dist/main/services/aiservice/ai-utils/tools/memory/agentRecallService')
        process.send({ type: 'inspection',
          memory: await db.query('SELECT * FROM memory_state'),
          stages: await db.query('SELECT * FROM memory_stage'),
          persona: await db.query('SELECT * FROM persona_state'),
          life: await db.query('SELECT * FROM agent_life_state'),
          events: await db.query('SELECT status FROM main_agent_event_record'),
          recall: await recallAgentMemory({ query: '蓝色风铃', limit: 8 })
        })
      }
      if (message.type === 'close') {
        await server.close()
        process.disconnect()
      }
    } catch (error) { console.error(error); process.exitCode = 1; process.disconnect() }
  })
  process.send({ type: 'ready', address })
}
main().catch(error => { console.error(error); process.exitCode = 1; process.disconnect() })
