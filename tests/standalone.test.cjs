const assert = require('node:assert/strict')
process.env.FAMILA_CHAT_MODE = 'legacy'
const { test } = require('node:test')
const { fork, spawn } = require('node:child_process')
const { createServer } = require('node:http')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { once } = require('node:events')

test('native standalone harness: SSE, concurrent dedupe, memory/persona persistence and restart', { timeout: 90000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'famila-standalone-'))
  let mainCalls = 0
  let child
  let logs = ''
  const provider = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body)
    const quick = payload.model === 'fixture-quick'
    const prompt = JSON.stringify(payload.messages)
    let content
    let toolCall = false
    if (quick) {
      content = JSON.stringify(prompt.includes('阶段归档器') ? { summary: '用户提到蓝色风铃。', moodLabel: 'calm' }
        : prompt.includes('阶段边界判断器') ? { type: 'continue' }
        : { userState: { mood: 'calm', valence: 0, confidence: 0 }, eventKind: 'neutral', valence: 0, salience: 0, novelty: 0, futureProspect: 0, agency: 'unknown', normImpact: 0, relationshipImpact: 0, controlSignal: 'unknown', confidence: 0 })
    } else {
      mainCalls++
      toolCall = mainCalls % 3 === 1
      content = mainCalls % 3 === 2
        ? '已经阅读思考指南。\n【表达交接】\n主线结果：记住蓝色风铃，继续交流。\n候选方向：无'
        : JSON.stringify({ reply: '我记得蓝色风铃。', committedLifeNarrative: '' })
    }
    // Keep the first round in flight while duplicate/concurrent HTTP requests attach.
    if (mainCalls === 1 && !quick) await new Promise(resolve => setTimeout(resolve, 80))
    const message = toolCall ? { role: 'assistant', content: '', tool_calls: [{ id: `guide-${mainCalls}`, type: 'function', function: { name: 'consult_thinking_guide', arguments: '{"scene":"character_analysis"}' } }] } : { role: 'assistant', content }
    if (payload.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const delta = toolCall ? { role: 'assistant', tool_calls: message.tool_calls.map(call => ({ index: 0, ...call })) } : message
      response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: payload.model, choices: [{ index: 0, message, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }))
    }
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  async function start(withConfig) {
    logs = ''
    child = fork(join(__dirname, 'fixtures/runtime-process.cjs'), [directory, ...(withConfig ? [`http://127.0.0.1:${provider.address().port}/v1`] : [])], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    child.stdout.on('data', data => { logs += data })
    child.stderr.on('data', data => { logs += data })
    const ready = await Promise.race([
      once(child, 'message').then(([message]) => message),
      once(child, 'exit').then(([code]) => { throw new Error(`Harness exited ${code}: ${logs}`) })
    ])
    assert.equal(ready.type, 'ready')
    return ready.address
  }
  async function stop() {
    const exit = once(child, 'exit')
    child.send({ type: 'close' })
    const [code] = await exit
    assert.equal(code, 0, logs)
    child = undefined
  }
  async function inspect() {
    const message = Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(([code]) => { throw new Error(`Harness inspection failed (${code}): ${logs}`) })
    ])
    child.send({ type: 'inspect' })
    return (await message)[0]
  }
  try {
    let address = await start(true)
    const send = async (requestId, text = '请记住蓝色风铃。') => {
      const response = await fetch(`${address}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, requestId }) })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /text\/event-stream/)
      const stream = await response.text()
      assert.doesNotMatch(stream, /event: error/, logs + stream)
      assert.doesNotMatch(stream, /"type":"stream_error"/, logs + stream)
      assert.match(stream, /event: complete/)
      return stream
    }
    const first = await Promise.all([send('first'), send('first'), send('second')])
    assert.equal(mainCalls, 6, logs)
    assert.ok(first.every(stream => stream.includes('"type":"done"')), 'in-flight duplicates must wait for terminal delivery')
    for (let i = 3; i <= 8; i++) await send(`message-${i}`)
    assert.equal((await (await fetch(`${address}/history`)).json()).length, 16)
    const before = await inspect()
    assert.ok(before.stages.length > 0, 'overflow should create a durable memory stage')
    assert.ok(before.persona.length > 0)
    assert.ok(before.life.length > 0)
    assert.ok(before.recall.matches.some(match => match.content.includes('蓝色风铃')))
    assert.ok(before.events.every(event => event.status === 'completed'), logs)
    await stop()
    address = await start(false)
    assert.equal((await (await fetch(`${address}/history`)).json()).length, 16)
    const after = await inspect()
    assert.deepEqual(after.persona, before.persona)
    assert.deepEqual(after.life, before.life)
    assert.deepEqual(after.memory, before.memory)
    assert.ok(after.recall.matches.some(match => match.content.includes('蓝色风铃')))
    const count = mainCalls
    await send('first')
    assert.equal(mainCalls, count, 'completed requestId stays idempotent across restart')
    await send('after-restart')
    assert.equal(mainCalls, count + 3)
    const seeded = once(child, 'message')
    child.send({ type: 'seedQueued' })
    assert.equal((await seeded)[0].type, 'seeded')
    await stop()
    address = await start(false)
    // Shutdown drains startup-recovered work as well as requests submitted over HTTP.
    await stop()
    address = await start(false)
    assert.equal((await (await fetch(`${address}/history`)).json()).length, 20)
    assert.equal(mainCalls, count + 6, 'startup should execute the durable queued event exactly once')
    const controller = new AbortController()
    const disconnected = await fetch(`${address}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ text: '断开连接后也记住蓝色风铃。', requestId: 'disconnect' })
    })
    await disconnected.body.getReader().read()
    controller.abort()
    await stop()
    address = await start(false)
    assert.equal((await (await fetch(`${address}/history`)).json()).length, 22,
      'disconnect followed by graceful shutdown must still commit the admitted turn')
    assert.equal(mainCalls, count + 9)
    await stop()
    const cli = spawn(process.execPath, [join(__dirname, '../dist/bin/chat.js')], {
      cwd: directory, env: { ...process.env, FAMILA_DATA_DIR: directory }, stdio: ['pipe', 'pipe', 'pipe']
    })
    let output = ''
    cli.stdout.on('data', data => { output += data })
    cli.stderr.on('data', data => { output += data })
    const cliExit = once(cli, 'exit')
    cli.stdin.end('还记得蓝色风铃吗？\n/exit\n')
    assert.equal((await cliExit)[0], 0, output)
    assert.match(output, /我记得蓝色风铃/)
    assert.equal(mainCalls, count + 12)
  } catch (error) {
    error.message += `\nHarness log:\n${logs.slice(-16000)}`
    throw error
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }
    provider.closeAllConnections()
    await new Promise(resolve => provider.close(resolve))
    rmSync(directory, { recursive: true, force: true })
  }
})
