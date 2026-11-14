const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const Database = require('better-sqlite3')
const { startHdsiRuntime: startEngine } = require('../dist/runtime/hdsi/hdsiRuntime')
const startHdsiRuntime = options => startEngine(options, { mode: 'fast' })
const { createFamilaServer } = require('../dist/server')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
const chunk = (response, content) => response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`)

test('HDSI: default execution is native and evaluation controls are disabled', { timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'famila-hdsi-native-'))
  let runtime
  try {
    runtime = await startEngine({ dataDirectory: directory, model: { model: 'fixture', baseURL: 'http://127.0.0.1:9', modelKey: 'fixture' } })
    assert.equal(runtime.getStatus().executionMode, 'native')
    await assert.rejects(runtime.evaluate('snapshot'), /disabled/)
  } finally {
    if (runtime) await runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('HDSI: Fastify, durable dedupe, rapid follow-up before old tail, stale-tail isolation and restart', { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'famila-hdsi-'))
  const tails = [gate(), gate()]
  const recoveryStarted = gate(), recoveryRelease = gate()
  let calls = 0, recoveryCalls = 0
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part
    const body = JSON.parse(raw)
    const isMain = String(body.messages[0].content).includes('living stage script')
    if (!isMain) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] })); return }
    const recovering = JSON.stringify(body.messages).includes('恢复消息')
    const n = ++calls
    if (recovering && ++recoveryCalls === 1) { recoveryStarted.release(); await recoveryRelease.promise }
    if (res.destroyed) return
    const reply = recovering ? '恢复成功' : `回复${n}<sep/>补充`
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    chunk(res, JSON.stringify({ interaction: { seen: true, reply: { mode: 'immediate', content: reply } } }).slice(0, -1) + ',"script":')
    if (!recovering) await tails[n - 1].promise
    if (res.destroyed) return
    const script = `她看见消息，发出回复：<say id="r${n}">${reply}</say>。${n === 1 ? 'OUTDATED-CONTENT' : '最新状态'}。`
    chunk(res, JSON.stringify(script) + ',"alter":0}')
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  const options = { dataDirectory: directory, model: { model: 'fixture', modelKey: 'fixture', baseURL: `http://127.0.0.1:${provider.address().port}` } }
  let runtime, server, recovered
  try {
    runtime = await startHdsiRuntime(options)
    await assert.rejects(startHdsiRuntime(options), /running owner/)
    server = createFamilaServer(runtime, { token: 'fixture' })
    assert.equal((await server.inject('/health')).statusCode, 401)
    const request = (id, text) => server.inject({ method: 'POST', url: '/messages', headers: { authorization: 'Bearer fixture' }, payload: { requestId: id, text } })
    let first
    await Promise.race([request('first', '第一条消息').then(r => { first = r }), sleep(2500).then(() => { throw new Error('First reply waited for narrative tail') })])
    assert.match(first.body, /回复1\\n补充/)
    assert.ok(!first.body.includes('<sep'))
    // Tail 1 is still held by the provider. Tail 2 must start and reply anyway.
    const second = await Promise.race([request('second', '第二条消息'), sleep(2500).then(() => { throw new Error('Next message blocked by old tail') })])
    assert.match(second.body, /回复2/)
    assert.equal(calls, 2)
    const duplicate = await request('first', '第一条消息')
    assert.match(duplicate.body, /回复1/)
    assert.equal(calls, 2)
    await assert.rejects(runtime.sendMessage({ requestId: 'first', text: '不同内容' }), /different content/)
    // Newer tail finishes first. Old tail must not overwrite its canonical state.
    tails[1].release(); await sleep(200); tails[0].release()
    await runtime.drain()
    const db = new Database(join(directory, 'hdsi', 'conversation.sqlite'), { readonly: true })
    const records = db.prepare('SELECT status, script FROM famila_hdsi_tail ORDER BY sourceEntryId').all()
    assert.deepEqual(records.map(r => r.status), ['archived', 'applied'])
    assert.match(records[0].script, /OUTDATED-CONTENT/)
    assert.equal(db.prepare("SELECT count(*) AS n FROM interlude_script_entry WHERE kind='script' AND content LIKE '%OUTDATED-CONTENT%'").get().n, 0)
    db.close()
    await server.close(); server = undefined; runtime = undefined

    // Simulate native checkpoint loss after the host outbox accepted delivery.
    const checkpoint = new Database(join(directory, 'hdsi', 'conversation.sqlite'))
    checkpoint.prepare("DELETE FROM interlude_script_entry WHERE kind='character-message'").run()
    checkpoint.close()

    recovered = await startHdsiRuntime(options)
    const repaired = new Database(join(directory, 'hdsi', 'conversation.sqlite'), { readonly: true })
    assert.equal(repaired.prepare("SELECT count(*) AS n FROM interlude_script_entry WHERE kind='character-message'").get().n, 2)
    repaired.close()
    const replay = []
    await recovered.sendMessage({ requestId: 'first', text: '第一条消息' }, c => replay.push(c))
    assert.equal(calls, 2)
    assert.equal(replay[0].content, '回复1\n补充')
    const interrupted = recovered.sendMessage({ requestId: 'recovery', text: '恢复消息' }).then(() => null, e => e)
    await recoveryStarted.promise
    const exited = new Promise(resolve => recovered.child.once('exit', resolve))
    recovered.child.kill('SIGKILL'); await exited
    assert.ok(await interrupted instanceof Error)
    await recovered.close(); recovered = undefined
    recoveryRelease.release()
    recovered = await startHdsiRuntime(options)
    const reply = []
    await recovered.sendMessage({ requestId: 'recovery', text: '恢复消息' }, c => reply.push(c))
    assert.equal(reply[0].content, '恢复成功')
    await recovered.close(); recovered = undefined
  } finally {
    tails.forEach(g => g.release()); recoveryRelease.release()
    if (server) await server.close()
    else if (runtime) await runtime.close()
    if (recovered) await recovered.close()
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve))
    rmSync(directory, { recursive: true, force: true })
  }
})

test('HDSI: bounded detached tails preserve a newer owner; burst input and concurrent duplicate merge once', { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'famila-hdsi-burst-'))
  const tails = Array.from({ length: 4 }, gate)
  let calls = 0, burst = false
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part
    const body = JSON.parse(raw)
    if (!String(body.messages[0].content).includes('living stage script')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: '{}' } }] })); return
    }
    const n = ++calls
    const reply = burst ? '合并接话' : `消息${n}`
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    chunk(res, JSON.stringify({ interaction: { seen: true, reply: { mode: 'immediate', content: reply } } }).slice(0, -1) + ',"script":')
    if (!burst) await tails[n - 1].promise
    chunk(res, JSON.stringify(`她读到消息，发出：<say id="r">${reply}</say>。`) + ',"alter":0}')
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  const options = { dataDirectory: directory, model: { model: 'fixture', modelKey: 'fixture', baseURL: `http://127.0.0.1:${provider.address().port}` } }
  let runtime
  try {
    runtime = await startHdsiRuntime(options)
    for (let i = 1; i <= 3; i++) await runtime.sendMessage({ requestId: `m${i}`, text: `消息${i}` })
    assert.equal(calls, 3)
    await sleep(100)
    assert.equal(runtime.getStatus().backgroundTails, 2)
    const fourth = runtime.sendMessage({ requestId: 'm4', text: '消息4' })
    tails[0].release(); await sleep(300)
    assert.equal(calls, 3, 'old tail completion must not release the newer foreground owner')
    tails[2].release()
    await fourth
    assert.equal(calls, 4)
    tails[3].release(); tails[1].release()
    await runtime.close(); runtime = undefined

    burst = true
    runtime = await startHdsiRuntime({ ...options, dataDirectory: join(directory, 'burst') })
    const results = [[], [], []]
    await Promise.all([
      runtime.sendMessage({ requestId: 'same', text: '我有一件事' }, c => results[0].push(c)),
      runtime.sendMessage({ requestId: 'same', text: '我有一件事' }, c => results[1].push(c)),
      runtime.sendMessage({ requestId: 'next', text: '补充一下细节' }, c => results[2].push(c))
    ])
    assert.equal(calls, 5, 'burst and duplicate should make only one additional model request')
    assert.ok(results.every(chunks => chunks.some(c => c.type === 'done')))
    assert.equal((await runtime.getHistory()).messages.length, 2)
    await runtime.close(); runtime = undefined
  } finally {
    tails.forEach(g => g.release())
    if (runtime) await runtime.close()
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve))
    rmSync(directory, { recursive: true, force: true })
  }
})
