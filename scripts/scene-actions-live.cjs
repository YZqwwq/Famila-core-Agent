// Bounded real-model pilot of the outer scene-action harness. Never edits HDSI.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const Database = require('better-sqlite3')
const { startHdsiRuntime } = require('../dist/runtime/hdsi/hdsiRuntime')
async function main() {
  const cfg = require('../dist/runtime/config').loadRuntimeConfig().core.model
  const out = path.resolve(__dirname, '../evals/companion_zh/reports', `scene-actions-live-${Date.now()}`)
  fs.mkdirSync(out, { recursive: true })
  const calls = [], turns = []
  const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ model: cfg.model, limits: { calls: 8, output_tokens: 2048, request_ms: 30000 }, calls, turns }, null, 2))
  const proxy = createServer(async (req, res) => {
    if (calls.length >= 8) { res.writeHead(429).end('{}'); return }
    const record = { id: calls.length + 1 }; calls.push(record)
    try {
      let raw = ''; for await (const part of req) { raw += part; if (raw.length > 300000) throw Error('input_limit') }
      const body = JSON.parse(raw); body.max_tokens = 2048
      fs.writeFileSync(path.join(out, `request-${record.id}.json`), JSON.stringify(body, null, 2))
      const start = Date.now()
      const response = await fetch(cfg.baseURL.replace(/\/$/, '') + '/chat/completions', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.modelKey}` }, body: JSON.stringify(body) })
      const text = await response.text()
      record.ms = Date.now() - start; record.status = response.status
      if (response.ok) {
        const parsed = JSON.parse(text); record.usage = parsed.usage
        fs.writeFileSync(path.join(out, `output-${record.id}.txt`), parsed.choices?.[0]?.message?.content ?? '')
      }
      res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(text)
    } catch (error) { record.error = error.name; res.writeHead(502).end('{}') }
    finally { save() }
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  let runtime
  const options = { dataDirectory: path.join(out, 'identity'), model: { ...cfg, modelKey: 'local-only', baseURL: `http://127.0.0.1:${proxy.address().port}` } }
  try {
    runtime = await startHdsiRuntime(options, { isolatedSqlite: true, mode: 'native', sceneActions: {}, evaluation: true })
    const texts = ['帮我实际保存一条个人笔记，标题叫“周末出行”，内容是“周六出门带雨伞”。保存后再读取一次核对。', '刚才那条笔记还在吗？请再读取确认一下内容。']
    for (let i = 0; i < texts.length; i++) {
      if (i) { await runtime.close(); runtime = await startHdsiRuntime(options, { isolatedSqlite: true, mode: 'native', sceneActions: {}, evaluation: true }) }
      const turn = { input: texts[i], reply: '' }, start = Date.now()
      await runtime.sendMessage({ text: texts[i], requestId: 'pilot-' + i }, chunk => { if (chunk.type === 'text_delta') turn.reply += chunk.content })
      turn.ms = Date.now() - start; turns.push(turn); save(); console.log(JSON.stringify(turn))
      assert.ok(turn.reply.trim())
    }
    await runtime.drain()
    const db = new Database(path.join(out, 'identity/hdsi/actions.sqlite'), { readonly: true })
    try {
      const note = db.prepare('SELECT * FROM notes WHERE title=?').get('周末出行')
      assert.equal(note?.content, '周六出门带雨伞')
      const actions = db.prepare('SELECT status,result FROM actions').all()
      assert.ok(actions.length >= 3, 'Expected write, verify and post-restart read')
      assert.ok(actions.every(a => a.status === 'completed'))
      fs.writeFileSync(path.join(out, 'actions.json'), JSON.stringify(actions, null, 2))
    } finally { db.close() }
    fs.writeFileSync(path.join(out, 'native-state.json'), JSON.stringify(await runtime.evaluate('snapshot'), null, 2))
    console.log(JSON.stringify({ report: out, calls: calls.length }))
  } finally {
    if (runtime) await runtime.close()
    proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve))
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
