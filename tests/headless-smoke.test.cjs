const assert = require('node:assert/strict')
// Preserve the original two-stage pipeline as an explicit compatibility baseline.
process.env.FAMILA_CHAT_MODE = 'legacy'
const { test } = require('node:test')
const { createServer } = require('node:http')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { z } = require('zod')
const { DataSource } = require('typeorm')
const coreApi = require('../dist')

test('headless package runs cognition, a host tool, final composition and durable commit', { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'famila-core-smoke-'))
  const requests = []
  const toolInvocations = []
  let mainCalls = 0
  const appraisal = {
    userState: { mood: 'calm', valence: 0, confidence: 0 },
    eventKind: 'neutral', valence: 0, salience: 0, novelty: 0,
    futureProspect: 0, agency: 'unknown', normImpact: 0,
    relationshipImpact: 0, controlSignal: 'unknown', confidence: 0
  }
  // Deterministic local provider fixture: no external API or credentials.
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body)
    requests.push(payload)
    const quick = payload.model === 'fixture-quick'
    if (!quick) mainCalls++
    const toolCall = !quick && mainCalls === 1
    const content = quick ? JSON.stringify(appraisal) : mainCalls === 2
      ? '我已经确认工具结果为 5。\n【表达交接】\n主线结果：2 加 3 等于 5，已经通过工具确认。\n候选方向：无'
      : JSON.stringify({ reply: '2 加 3 等于 5。', committedLifeNarrative: '' })
    const message = toolCall
      ? { role: 'assistant', content: '', tool_calls: [{ id: 'fixture-call-1', type: 'function', function: { name: 'fixture_sum', arguments: '{"a":2,"b":3}' } }] }
      : { role: 'assistant', content }
    if (payload.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const delta = toolCall
        ? { role: 'assistant', tool_calls: message.tool_calls.map(call => ({ index: 0, ...call })) }
        : { role: 'assistant', content }
      for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' }]) {
        response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [choice] })}\n\n`)
      }
      response.end('data: [DONE]\n\n')
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: payload.model, choices: [{ index: 0, message, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }))
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  let core
  let dataSource
  try {
    const tool = coreApi.defineAgentTool({
      name: 'fixture_sum', description: 'Add two numbers.',
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      outputSchema: z.object({ sum: z.number() }),
      metadata: {
        description: { purpose: 'Add two numbers.', whenToUse: ['For arithmetic.'], inputSummary: 'Two numbers.', outputSummary: 'Their sum.' },
        display: { visibility: 'hidden' },
        execution: { level: 'safe', readOnly: true, idempotent: true, completionSemantics: 'definitive' },
        retention: { context: 'evidence' }
      },
      execute: ({ a, b }) => { toolInvocations.push([a, b]); return { sum: a + b } }
    })
    const entry = {
      key: tool.name, tool, toolsetId: 'core_runtime', category: 'test', capabilityLayer: 'core',
      capabilityGroup: 'Test', capabilitySummary: 'Add numbers.', audience: 'main_agent', access: 'read',
      activationMode: 'always', enabled: true
    }
    coreApi.registerAgentTools([entry])
    const entryCount = coreApi.getMainAgentToolEntries().length
    assert.throws(() => coreApi.registerAgentTools([entry]))
    assert.equal(coreApi.getMainAgentToolEntries().length, entryCount)
    const baseURL = `http://127.0.0.1:${server.address().port}/v1`
    dataSource = new DataSource({ type: 'sqljs', location: join(directory, 'agent.sqlite'), autoSave: true, entities: coreApi.coreEntities, synchronize: true })
    core = await coreApi.initializeFamilaCore({
      dataDirectory: directory, recover: false, dataSource,
      model: { modelKey: 'fixture', vendor: 'openai', model: 'fixture-main', baseURL,
        quickModelKey: 'fixture', quickVendor: 'openai', quickModel: 'fixture-quick', quickBaseURL: baseURL,
        streaming: true, useResponsesApi: false }
    })
    assert.equal((await core.chat.getHistory()).length, 0)
    const chunks = []
    await core.chat.sendStreamMessage({ text: '请用工具计算 2 加 3。', requestId: 'fixture-request' }, chunk => chunks.push(chunk))
    const history = await core.chat.getHistory()
    assert.equal(history.length, 2)
    assert.equal(history[0].role, 'user')
    assert.equal(history[1].role, 'ai')
    assert.equal(history[1].content, '2 加 3 等于 5。')
    assert.deepEqual(toolInvocations, [[2, 3]])
    assert.equal(mainCalls, 3)
    assert.ok(requests.some(payload => payload.messages.some(message => message.role === 'tool')))
    assert.ok(chunks.length > 0)
    const versions = await coreApi.AppDataSource.query('SELECT kind FROM main_agent_turn_version')
    assert.ok(versions.length > 0)
    const tables = await coreApi.AppDataSource.query("SELECT name FROM sqlite_master WHERE type='table'")
    assert.equal(tables.some(table => /^world/i.test(table.name)), false)
    const requestsBeforeReplay = requests.length
    await core.chat.sendStreamMessage({ text: '请用工具计算 2 加 3。', requestId: 'fixture-request' })
    assert.equal(requests.length, requestsBeforeReplay)
    assert.equal((await core.chat.getHistory()).length, 2)
  } finally {
    if (core) await core.close()
    if (core) assert.equal(dataSource.isInitialized, true, 'host retains ownership of its DataSource')
    if (dataSource?.isInitialized) await dataSource.destroy()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    rmSync(directory, { recursive: true, force: true })
  }
})
