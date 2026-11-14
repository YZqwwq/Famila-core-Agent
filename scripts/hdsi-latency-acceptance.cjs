// Observe streamed provider output, then return a complete JSON response to native HDSI.
// No early reply, prompt reordering, shortened narrative, or state detachment.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { startHdsiRuntime } = require('../dist/runtime/hdsi/hdsiRuntime')
const { createFamilaServer } = require('../dist/server')
const fixture = process.argv.includes('--fixture')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function main() {
  const cfg = fixture ? { model: 'fixture' } : require('../dist/runtime/config').loadRuntimeConfig().core.model
  const out = path.resolve(__dirname, '../evals/companion_zh/reports', `hdsi-latency-${fixture ? 'fixture' : 'live'}-${Date.now()}`)
  fs.mkdirSync(out, { recursive: true })
  const calls = [], turns = []
  let active, runtime, app
  const now = () => performance.now()
  const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ model: cfg.model,
    method: 'native runtime; relay requests provider streaming and buffers full output before native commit; max 6 calls, 2048 output tokens/call, 30s timeout',
    caveats: ['Provider stream transport differs from ordinary nonstream transport.', 'TTFT includes network, provider queue and prefill; cannot separate these externally.', 'Request duration after first content is observed decoding/stream delivery, not pure GPU time.', 'Small sequential sample; not P95 or a concurrency benchmark.'], calls, turns }, null, 2))
  const proxy = createServer(async (req, res) => {
    const start = now(), turn = active
    if (calls.length >= 6) { res.writeHead(429).end(); return }
    const record = { id: calls.length + 1, turn: turn.id, start_ms: start - turn.start, status: 'pending' }
    calls.push(record)
    try {
      let raw = ''; for await (const part of req) { raw += part; if (raw.length > 180000) throw Error('input_limit') }
      const body = JSON.parse(raw)
      assert.equal(body.stream ?? false, false, 'Native caller must request a complete response')
      body.stream = true; body.stream_options = { include_usage: true }; body.max_tokens = 2048
      fs.writeFileSync(path.join(out, `request-${record.id}.json`), JSON.stringify(body, null, 2))
      let output = '', finish = 'stop'
      if (fixture) {
        await sleep(40); record.first_content_ms = now() - start
        output = JSON.stringify({ script: '她看见消息，发出：<say id="r">收到</say>。', interaction: { seen: true, reply: { mode: 'immediate', content: '收到' } }, alter: 2 })
        await sleep(80)
      } else {
        const response = await fetch(cfg.baseURL.replace(/\/$/, '') + '/chat/completions', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.modelKey}` }, body: JSON.stringify(body) })
        record.headers_ms = now() - start; record.http_status = response.status
        if (!response.ok) throw Error('provider_http_' + response.status)
        assert.match(response.headers.get('content-type') || '', /text\/event-stream/)
        let pending = ''; const decoder = new TextDecoder()
        const parse = line => {
          if (!line.startsWith('data: {')) return
          const packet = JSON.parse(line.slice(6))
          if (packet.usage) record.usage = packet.usage
          const choice = packet.choices?.[0], text = choice?.delta?.content
          if (text) { record.first_content_ms ??= now() - start; output += text; record.last_content_ms = now() - start }
          if (choice?.finish_reason) finish = choice.finish_reason
        }
        for await (const chunk of response.body) {
          pending += decoder.decode(chunk, { stream: true })
          let i; while ((i = pending.indexOf('\n')) >= 0) { parse(pending.slice(0, i).trim()); pending = pending.slice(i + 1) }
        }
        pending += decoder.decode(); if (pending.trim()) parse(pending.trim())
      }
      assert.ok(output)
      record.provider_complete_ms = now() - start
      record.after_first_content_ms = record.provider_complete_ms - record.first_content_ms
      record.response_chars = output.length
      fs.writeFileSync(path.join(out, `output-${record.id}.txt`), output)
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: output }, finish_reason: finish }], usage: record.usage }))
      record.status = 'ok'
    } catch (error) { record.status = 'error'; record.error = error.message; res.writeHead(502).end('{}') }
    finally { record.end_ms = now() - turn.start; save() }
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  try {
    runtime = await startHdsiRuntime({ dataDirectory: path.join(out, 'identity'), model: { ...cfg, vendor: 'openai', modelKey: 'local-only', baseURL: `http://127.0.0.1:${proxy.address().port}` } }, { mode: 'native' })
    app = createFamilaServer(runtime)
    await app.listen({ host: '127.0.0.1', port: 0 })
    for (const [i, text] of ['今天终于把积压的事忙完了，刚坐下来。', '晚饭还没吃，在想煮面还是点外卖。', '还是煮面吧，冰箱里正好有鸡蛋。'].entries()) {
      active = { id: i + 1, text, start: now(), reply: '' }; turns.push(active)
      const response = await fetch(`http://127.0.0.1:${app.server.address().port}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: `latency-${i}`, text }), signal: AbortSignal.timeout(65000) })
      assert.equal(response.status, 200)
      let pending = ''; const decoder = new TextDecoder()
      for await (const part of response.body) {
        pending += decoder.decode(part, { stream: true })
        let j; while ((j = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, j).trim(); pending = pending.slice(j + 1)
          if (line === 'event: error') throw Error('native_turn_failed')
          if (!line.startsWith('data: ')) continue
          const chunk = JSON.parse(line.slice(6))
          if (chunk.type === 'text_delta') { active.first_reply_ms ??= now() - active.start; active.reply += chunk.content }
        }
      }
      active.complete_ms = now() - active.start
      assert.ok(active.reply.trim(), 'Expected a native visible reply')
      const main = calls.find(c => c.turn === active.id)
      active.before_model_ms = main.start_ms
      active.after_model_to_reply_ms = active.first_reply_ms - main.end_ms
      save(); console.log(JSON.stringify(active))
    }
    await runtime.drain(); save()
    assert.ok(calls.every(c => c.status === 'ok'))
    console.log(JSON.stringify({ report: out, calls: calls.length }))
  } finally {
    if (app) await app.close(); else if (runtime) await runtime.close()
    proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve))
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
