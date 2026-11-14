const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
delete process.env.FAMILA_CHAT_MODE
process.env.FAMILA_CHAT_TONE = 'examples'

test('conversation: one call, slow maintenance cannot block next reply, tools and commit-before-delivery', { timeout: 30000 }, async () => {
  const api = require('../dist')
  const directory = mkdtempSync(join(tmpdir(), 'famila-conversation-'))
  let releaseQuick
  const gate = new Promise(resolve => { releaseQuick = resolve })
  let quickStarted
  const started = new Promise(resolve => { quickStarted = resolve })
  let mainCalls = 0
  const provider = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body)
    const quick = payload.model === 'fixture-quick'
    let content = '嗯，今天想聊点什么？'
    let calls
    if (quick) {
      quickStarted()
      await gate
      const prompt = JSON.stringify(payload.messages)
      content = JSON.stringify(prompt.includes('后台对话连续性整理器') ? { narrative: '用户今天有点累，正在聊日常。' }
        : prompt.includes('阶段归档器') ? { summary: '今天聊了日常。', moodLabel: 'calm' }
        : prompt.includes('阶段边界判断器') ? { type: 'continue' }
        : prompt.includes('偏好') && !prompt.includes('userState') ? { signals: [] }
        : { userState: { mood: 'calm', valence: 0, confidence: 0 }, eventKind: 'neutral', valence: 0, salience: 0, novelty: 0, futureProspect: 0, agency: 'unknown', normImpact: 0, relationshipImpact: 0, controlSignal: 'unknown', confidence: 0 })
    } else {
      mainCalls++
      const systemText = payload.messages.filter(m => m.role === 'system').map(m => m.content).join('\n')
      assert.ok(systemText.includes('一个 AI 对话助手'))
      assert.ok(!systemText.includes('现实常常沉重'))
      assert.ok(!systemText.includes('shared-persona-snapshot'))
      assert.equal(payload.messages.filter(m => m.role === 'system' && m.content.includes('展示的是接话方式')).length, 1)
      assert.ok(!payload.messages.filter(m => m.role !== 'system').some(m => String(m.content).includes('包裹可算到了')),
        'style demonstrations must not become actual conversation history')
      assert.ok(!JSON.stringify(payload.messages).includes('【输出协议】只输出一个 JSON'))
      const user = payload.messages.filter(m => m.role === 'user').at(-1)?.content
      if (String(user).includes('工具') && !payload.messages.some(m => m.role === 'tool')) {
        calls = [{ id: 'time-1', type: 'function', function: { name: 'get_time', arguments: '{}' } }]
        // Use the actual visible tool name rather than inventing an adapter API.
        calls[0].function.name = payload.tools.find(t => /catalog/i.test(t.function.name)).function.name
        content = ''
      }
    }
    if (payload.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: calls ? { role: 'assistant', tool_calls: calls.map(c => ({ index: 0, ...c })) } : { role: 'assistant', content }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ id: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }))
    }
  })
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve) })
  let core
  try {
    const baseURL = `http://127.0.0.1:${provider.address().port}/v1`
    core = await api.initializeFamilaCore({ dataDirectory: directory, model: {
      vendor: 'openai', model: 'fixture-main', modelKey: 'fixture', baseURL,
      quickVendor: 'openai', quickModel: 'fixture-quick', quickModelKey: 'fixture', quickBaseURL: baseURL,
      streaming: true, useResponsesApi: false
    } })
    const send = async (id, text) => {
      const chunks = []
      const checks = []
      await core.chat.sendStreamMessage({ requestId: id, text }, chunk => {
        chunks.push(chunk)
        if (chunk.type === 'text_delta') {
          checks.push(api.AppDataSource.query("SELECT e.status FROM main_agent_event_record e JOIN message m ON m.eventId = e.id WHERE m.requestId = ?", [id]).then(rows => {
            assert.equal(rows[0]?.status, 'completed', 'reply must already be committed when delivered')
          }))
        }
      })
      await Promise.all(checks)
      assert.equal(chunks.filter(c => c.type === 'text_delta').length, 1, JSON.stringify(chunks))
      assert.ok(chunks.some(c => c.type === 'done'), JSON.stringify(chunks))
    }
    await send('chat-1', '晚上好')
    assert.equal(mainCalls, 1)
    await started
    let timeout
    try {
      await Promise.race([send('chat-2', '今天有点累'), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Background inference blocked foreground')), 2000)
      })])
    } finally { clearTimeout(timeout) }
    assert.equal(mainCalls, 2)
    await send('chat-3', '用工具看看现在几点')
    assert.equal(mainCalls, 4, 'tool use needs only tool request + answer')
    // Archive inference must not hold the same lock used to save the next user turn.
    for (let i = 4; i <= 7; i++) await send(`chat-${i}`, '继续聊日常')
    const archive = require('../dist/main/services/aiservice/agentrsystem/manager/memory/memoryArchiveService')
    const memory = require('../dist/main/services/aiservice/agentrsystem/manager/memory/MemoryManager').memoryManager
    const original = archive.summarizeMemoryStage
    let releaseArchive, archiveStarted
    const archiveGate = new Promise(resolve => { releaseArchive = resolve })
    const archiveReady = new Promise(resolve => { archiveStarted = resolve })
    archive.summarizeMemoryStage = async () => { archiveStarted(); await archiveGate; return { summary: '日常交流', moodLabel: 'calm', status: 'completed' } }
    const archiving = memory.archivePendingIfNeeded()
    await archiveReady
    try {
      let deadline
      try { await Promise.race([send('chat-8', '我又补充了一句'), new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Archive inference held foreground lock')), 2000)
      })]) } finally { clearTimeout(deadline) }
    } finally { releaseArchive(); await archiving; archive.summarizeMemoryStage = original }
    assert.equal((await memory.getSnapshot()).pendingArchive.length, 2, 'archive keeps newly appended tail')
    releaseQuick()
    const maintenance = require('../dist/main/services/aiservice/runtime/conversationMaintenance').conversationMaintenance
    const end = Date.now() + 5000
    while (maintenance.getStatus().running || maintenance.getStatus().pending) {
      assert.ok(Date.now() < end, 'maintenance must converge: ' + JSON.stringify(maintenance.getStatus()))
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const rows = await api.AppDataSource.query('SELECT lastObservationId FROM persona_state')
    assert.ok(rows[0].lastObservationId >= 8, 'background observation cursor is durable')
    const life = await api.AppDataSource.query('SELECT narrative FROM agent_life_state')
    assert.match(life[0].narrative, /日常/)
    assert.equal(maintenance.getStatus().failures, 0)
    await core.close()
    core = undefined
  } catch (error) {
    console.error('Conversation regression:', error)
    throw error
  } finally {
    releaseQuick()
    if (core) await core.close()
    await new Promise(resolve => provider.close(resolve))
    rmSync(directory, { recursive: true, force: true })
  }
})
