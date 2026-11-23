// Bounded, real HDSI worker execution. Credentials remain only in this parent proxy.
const fs = require('node:fs')
const path = require('node:path')
const { createServer } = require('node:http')
async function main() {
  if (!process.argv.includes('--live')) throw new Error('Explicit --live is required')
  const cfg = require('../dist/runtime/config').loadRuntimeConfig().core.model
  const { startHdsiRuntime } = require('../dist/runtime/hdsi/hdsiRuntime')
  const out = path.resolve('evals/companion_zh/reports', `hdsi-integrated-${Date.now()}`)
  fs.mkdirSync(out, { recursive: true })
  const calls = [], turns = []
  const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({
    mode: 'live_integrated_hdsi', model: cfg.model, limits: { calls: 8, output_tokens: 2048, timeout_ms: 30000 },
    cost: 'token usage recorded; monetary cost not calculated', calls, turns
  }, null, 2))
  const proxy = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/chat/completions') { res.writeHead(404).end(); return }
    if (calls.length >= 8) { res.writeHead(400).end(JSON.stringify({ error: { message: 'pilot_limit' } })); return }
    const record = { id: calls.length + 1, status: 'pending' }; calls.push(record)
    const start = performance.now()
    try {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 160000) throw new Error('input_limit') }
      const body = JSON.parse(raw)
      if (JSON.stringify(body.messages).length > 100000) throw new Error('context_limit')
      body.max_tokens = 2048
      record.stream = !!body.stream
      const url = new URL(cfg.baseURL.replace(/\/$/, '') + '/chat/completions')
      if (url.protocol !== 'https:') throw new Error('HTTPS required')
      const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.modelKey}` }, body: JSON.stringify(body) })
      record.http_status = response.status
      record.headers_ms = Math.round(performance.now() - start)
      res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/json' })
      let buffer = '', output = ''
      const decoder = new TextDecoder()
      const packet = text => {
        try {
          const value = JSON.parse(text)
          if (value.usage) record.usage = value.usage
          const content = value.choices?.[0]?.delta?.content ?? value.choices?.[0]?.message?.content
          if (content) { record.first_content_ms ??= Math.round(performance.now() - start); output += content }
        } catch {}
      }
      for await (const chunk of response.body) {
        res.write(chunk)
        buffer += decoder.decode(chunk, { stream: true })
        if (body.stream) {
          let index
          while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1); if (line.startsWith('data: {')) packet(line.slice(6)) }
        }
      }
      buffer += decoder.decode()
      if (!body.stream) packet(buffer)
      record.output = output
      record.status = response.ok ? 'ok' : 'provider_error'
      res.end()
    } catch (error) { record.status = 'error'; record.error_type = error.name; if (!res.headersSent) res.writeHead(502); res.end() }
    finally { record.ms = Math.round(performance.now() - start); save() }
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  let runtime
  try {
    runtime = await startHdsiRuntime({ dataDirectory: path.join(out, 'identity'), model: {
      ...cfg, vendor: 'openai', modelKey: 'local-proxy', quickModelKey: 'local-proxy', baseURL: `http://127.0.0.1:${proxy.address().port}`
    } }, { isolatedSqlite: true, mode: 'fast' })
    for (const [index, text] of ['刚下班，感觉今天过了一个世纪。', '我正在纠结夜宵吃啥，想吃点辣的。', '家里只有泡面和一个鸡蛋，懒得出门。'].entries()) {
      const turn = { id: `pilot-${index + 1}`, input: text, reply: '' }
      const start = performance.now()
      await runtime.sendMessage({ requestId: turn.id, text }, chunk => {
        if (chunk.type === 'text_delta') { turn.reply += chunk.content; turn.first_reply_ms ??= Math.round(performance.now() - start) }
      })
      turn.return_ms = Math.round(performance.now() - start)
      turn.state = runtime.getStatus()
      turns.push(turn); save(); console.log(JSON.stringify(turn))
    }
    const drain = performance.now()
    await runtime.close(); runtime = undefined
    const Database = require('better-sqlite3')
    const db = new Database(path.join(out, 'identity/hdsi/conversation.sqlite'), { readonly: true })
    fs.writeFileSync(path.join(out, 'tail-audit.json'), JSON.stringify(db.prepare('SELECT id, sourceEntryId, status FROM famila_hdsi_tail ORDER BY sourceEntryId').all(), null, 2))
    db.close()
    console.log(JSON.stringify({ report: out, calls: calls.length, drain_ms: Math.round(performance.now() - drain) }))
  } finally {
    if (runtime) await runtime.close()
    proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve))
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
