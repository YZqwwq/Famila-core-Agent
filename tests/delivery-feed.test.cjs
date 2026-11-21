const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { createInterface } = require('node:readline')
const { Readable } = require('node:stream')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { startHdsiRuntime } = require('../dist/runtime/hdsi/hdsiRuntime')
const { createFamilaServer } = require('../dist/server')

test('native bubbles arrive live and resume after HTTP disconnect and process restart', { timeout: 50000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'famila-bubble-feed-'))
  const parts = ['杭州明天十三到十九度', '早晚带件外套', '折叠伞可以放包里']
  const content = parts.join('<sep/>')
  const provider = createServer(async (req, res) => {
    let raw = ''
    for await (const bytes of req) raw += bytes
    const messages = JSON.parse(raw).messages
    const main = messages.some(m => m.content.includes('living stage script'))
    const incoming = main && JSON.parse(messages.find(m => m.role === 'user').content).incomingEvent.event.content
    const reply = incoming === '我改天再去。' ? '那就改天再看。' : content
    const text = main ? JSON.stringify({ script: `她看了眼手机，发出：<say id="r">${reply}</say>。`,
      interaction: { seen: true, reply: { mode: 'immediate', content: reply } }, alter: 0 }) : '{}'
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }))
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  const opts = { dataDirectory: directory, model: { model: 'fixture', modelKey: 'fixture', baseURL: 'http://127.0.0.1:' + provider.address().port } }
  let app, url, controller
  const start = async () => {
    app = createFamilaServer(await startHdsiRuntime(opts))
    url = await app.listen({ host: '127.0.0.1', port: 0 })
  }
  async function connect(cursor) {
    controller = new AbortController()
    const response = await fetch(url + '/deliveries', {
      headers: cursor ? { 'Last-Event-ID': String(cursor) } : {}, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(22000)])
    })
    assert.equal(response.status, 200)
    const lines = createInterface({ input: Readable.fromWeb(response.body) })
    return (async function* () {
      for await (const line of lines) if (line.startsWith('data: ')) yield JSON.parse(line.slice(6))
    })()
  }
  try {
    await start()
    const feed = await connect()
    const turn = app.inject({ method: 'POST', url: '/messages', payload: { text: '明天去杭州穿什么？', requestId: 'weather' } }).then(r => r.body)
    const first = (await feed.next()).value
    assert.equal(first.content, parts[0])
    assert.match(await turn, /event: complete/)
    await app.close()
    assert.equal((await feed.next()).done, true)
    await start()
    const resumed = await connect(first.cursor)
    const second = (await resumed.next()).value
    const third = (await resumed.next()).value
    assert.deepEqual([second.content, third.content], parts.slice(1))
    assert.ok(first.cursor < second.cursor && second.cursor < third.cursor)
    assert.ok([first, second, third].every(b => b.requestId === 'weather'))
    assert.deepEqual((await app.inject('/history')).json().replies.map(r => r.content), parts)
    await app.inject({ method: 'POST', url: '/messages', payload: { text: '再说一遍？', requestId: 'again' } })
    const beforeFollowup = (await resumed.next()).value
    assert.equal(beforeFollowup.content, parts[0])
    await app.inject({ method: 'POST', url: '/messages', payload: { text: '我改天再去。', requestId: 'followup' } })
    const followup = (await resumed.next()).value
    assert.equal(followup.requestId, 'followup')
    assert.equal(followup.content, '那就改天再看。')
    assert.deepEqual((await app.inject('/history')).json().replies.map(r => r.content), [...parts, parts[0], followup.content])
  } finally {
    if (app) await app.close()
    controller?.abort()
    await new Promise(resolve => provider.close(resolve))
    rmSync(directory, { recursive: true, force: true })
  }
})
