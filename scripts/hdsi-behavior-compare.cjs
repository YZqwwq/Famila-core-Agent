// Differential runtime evaluation: pinned, unmodified HDSI vs the migrated fast engine.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { createServer } = require('node:http')
const assert = require('node:assert/strict')
const { startHdsiRuntime } = require('../dist/runtime/hdsi/hdsiRuntime')
const live = process.argv.includes('--live')
const acceptance = process.argv.includes('--native-acceptance')
const { createFamilaServer } = require('../dist/server')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const training = [
  '我叫小林，不喝咖啡，面试在周五上午十点，地点是星河大厦A座。',
  '准备了好多天，越临近越紧张。现在别给我建议，听我聊聊就好。',
  '更正一下，面试改成周六下午两点了，地点没变，别记成周五。',
  '刚收到朋友发来的鼓励，感觉没刚才那么慌了。谢谢你听我说。',
  '面试完我会回来找你聊，到时候再问问我现场怎么样吧。'
]
async function main() {
  const root = path.resolve(__dirname, '..')
  const source = path.resolve(root, '../.research/HDS-Interlude')
  const expected = '13a623fdc23c0558173fbfa11ad9cdf51c8330e0'
  assert.equal(execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), expected)
  const provenance = require('../vendor/hdsi/provenance.json')
  for (const [file, digest] of Object.entries(provenance.files)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(source, file))).digest('hex')
    assert.equal(actual, digest.upstream, 'Original source changed: ' + file)
  }
  const out = path.resolve(root, 'evals/companion_zh/reports', `hdsi-behavior-${live ? 'live' : 'fixture'}-${Date.now()}`)
  fs.mkdirSync(out, { recursive: true })
  const originalBundle = path.join(out, 'original.cjs')
  require('esbuild').buildSync({ stdin: { contents: `export { Config } from './src/index'; export { InterludeService } from './src/service'; export { installDesktopBridge } from './src/desktop-bridge';`, resolveDir: source, loader: 'ts' },
    outfile: originalBundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external',
    tsconfigRaw: { compilerOptions: { target: 'ES2022', experimentalDecorators: true } } })
  const cfg = live ? require('../dist/runtime/config').loadRuntimeConfig().core.model : { model: 'fixture' }
  const results = {}, calls = []
  let arm = '', activeCase = '', mainCount = 0
  const limit = acceptance ? 14 : live ? 28 : 12
  const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({
    mode: acceptance ? 'native_queue_acceptance' : live ? 'live_runtime_comparison' : 'deterministic_runtime_comparison', originalCommit: expected,
    model: cfg.model, limits: { calls: limit, output_tokens: 2048, request_ms: 30000 },
    caveats: ['Small exploratory sample, not statistical equivalence.', 'Minimal role profile; no inherited Famila persona.', 'Autonomous life advancement, external tools and multi-day interaction not covered.',
      acceptance ? 'Vendored native engine, ordinary debounce/typing/bubble settings, via Fastify POST /messages and durable queue; explicit compaction before recall.' : live ? 'Both engines disable typing and split bubbles, use 100ms debounce; native still commits full narration before continuing. Identical input sequence, closed-loop arrival after each reply.' : 'Native uses its ordinary transport; fast uses early reply and detached tails. Identical fixed decisions and closed-loop input sequence.', 'Context-restricted recall must be checked against the captured payload; a correct answer alone is not proof of long-term memory.'],
    cost: 'not converted; usage recorded', results, calls
  }, null, 2))
  const proxy = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/chat/completions') { res.writeHead(404).end(); return }
    if (calls.length >= limit) { res.writeHead(400).end(JSON.stringify({ error: { message: 'comparison_budget_exhausted' } })); return }
    const record = { id: calls.length + 1, arm, case: activeCase, status: 'pending' }; calls.push(record)
    const start = performance.now()
    try {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 180000) throw new Error('input_limit') }
      const body = JSON.parse(raw)
      if (JSON.stringify(body.messages).length > 100000) throw new Error('context_limit')
      body.max_tokens = 2048
      record.stream = !!body.stream
      record.main = String(body.messages[0].content).includes('living stage script')
      fs.writeFileSync(path.join(out, `request-${record.id}.json`), JSON.stringify(body, null, 2))
      if (!live) {
        const n = record.main ? ++mainCount : 0
        const decision = n ? { script: `她看见第${n}条消息，感到这件事令她更认真。她发出：<say id="r${n}">收到${n}</say>。`,
          interaction: { seen: true, reply: { mode: 'immediate', content: `收到${n}` } }, alter: 2 } : {}
        const output = JSON.stringify(decision)
        record.output = output
        if (body.stream) {
          const prefix = JSON.stringify({ interaction: decision.interaction }).slice(0, -1) + ',"script":'
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          const send = content => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`)
          send(prefix)
          await sleep(800)
          send(JSON.stringify(decision.script) + ',"alter":2}')
          res.end('data: [DONE]\n\n')
        } else {
          await sleep(800)
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: output }, finish_reason: 'stop' }] }))
        }
      } else {
        const url = new URL(cfg.baseURL.replace(/\/$/, '') + '/chat/completions')
        assert.equal(url.protocol, 'https:')
        const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.modelKey}` }, body: JSON.stringify(body) })
        record.http_status = response.status
        res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/json' })
        let buffer = '', output = ''
        const decoder = new TextDecoder()
        const parse = packet => {
          try { const value = JSON.parse(packet); if (value.usage) record.usage = value.usage
            const content = value.choices?.[0]?.delta?.content ?? value.choices?.[0]?.message?.content
            if (content) output += content
          } catch {}
        }
        for await (const chunk of response.body) {
          res.write(chunk); buffer += decoder.decode(chunk, { stream: true })
          if (body.stream) { let newline; while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1)
            if (line.startsWith('data: {')) parse(line.slice(6))
          } }
        }
        buffer += decoder.decode()
        if (!body.stream) parse(buffer)
        record.output = output
        res.end()
      }
      record.status = 'ok'
    } catch (error) { record.status = 'error'; record.error_type = error.name; if (!res.headersSent) res.writeHead(502); res.end() }
    finally { record.ms = Math.round(performance.now() - start); save() }
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  let runtime
  const idle = async () => {
    const start = Date.now(); let stable
    while (true) {
      if (Date.now() - start > 65000) throw new Error('idle_timeout')
      const state = runtime.getStatus()
      if (!state.pendingTurns && !state.backgroundTails && !calls.some(c => c.status === 'pending')) {
        stable ??= Date.now(); if (Date.now() - stable > 500) return
      } else stable = undefined
      await sleep(50)
    }
  }
  const snapshot = async label => {
    await idle()
    const state = await runtime.evaluate('snapshot')
    fs.writeFileSync(path.join(out, `${arm}-${label}.json`), JSON.stringify(state, null, 2))
    return state
  }
  try {
    for (arm of (acceptance || process.argv.includes('--compat-only') ? ['compat'] : ['native', 'fast'])) {
      mainCount = 0
      const directory = path.join(out, arm)
      const options = { dataDirectory: directory, model: { ...cfg, vendor: 'openai', modelKey: 'local-proxy', quickModelKey: 'local-proxy', baseURL: `http://127.0.0.1:${proxy.address().port}` } }
      const execution = { mode: arm === 'fast' ? 'fast' : 'native', evaluation: true, normalizedTransport: live && !acceptance, ...(arm === 'native' ? { upstreamBundle: originalBundle } : {}) }
      runtime = await startHdsiRuntime(options, execution)
      results[arm] = { turns: [] }
      const send = async (id, text) => {
        activeCase = id
        const turn = { id, input: text, reply: '' }, start = performance.now()
        if (acceptance) {
          const server = createFamilaServer(runtime, { token: 'acceptance-local' })
          const request = () => server.inject({ method: 'POST', url: '/messages', headers: { authorization: 'Bearer acceptance-local' }, payload: { requestId: id, text } })
          const response = await request()
          assert.equal(response.statusCode, 200)
          assert.ok(!response.body.includes('event: error'))
          assert.ok(response.body.includes('event: complete'))
          for (const line of response.body.split('\n')) {
            if (!line.startsWith('data: ')) continue
            const chunk = JSON.parse(line.slice(6))
            if (chunk.type === 'text_delta') turn.reply += chunk.content
          }
          assert.ok(turn.reply.trim(), 'Native reply must be nonempty')
          turn.first_reply_ms = Math.round(performance.now() - start)
          const count = calls.length
          const duplicate = await request()
          const chunks = body => body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).filter(chunk => chunk.type === 'text_delta').map(chunk => chunk.content).join('')
          assert.equal(chunks(duplicate.body), turn.reply)
          assert.equal(calls.length, count, 'Duplicate must not call model')
          turn.duplicateReplay = true
          // Do not close this injected server: its close hooks own the shared runtime.
        } else await runtime.sendMessage({ requestId: id, text }, chunk => {
          if (chunk.type === 'text_delta') { turn.reply += chunk.content; turn.first_reply_ms ??= Math.round(performance.now() - start) }
        })
        turn.return_ms = Math.round(performance.now() - start)
        results[arm].turns.push(turn); save()
        console.log(JSON.stringify({ arm, ...turn }))
      }
      const inputs = live ? training : ['固定场景一', '固定场景二', '固定场景三']
      for (const [i, text] of inputs.entries()) await send('train-' + (i + 1), text)
      const before = await snapshot('before-restart')
      results[arm].before = summarize(before)
      if (live) {
        activeCase = 'force-compaction'
        results[arm].compaction = await runtime.evaluate('compact')
        const compacted = await snapshot('after-compaction')
        results[arm].afterCompaction = summarize(compacted)
      }
      await runtime.close(); runtime = undefined
      if (live) {
        runtime = await startHdsiRuntime(options, execution)
        await runtime.evaluate('restrict-context')
        await send('recall', '你还记得我的名字、面试改到了什么时候、地点，以及我喝饮料的偏好吗？')
        await send('promise', '我之前说面试结束回来后，希望你问我什么？')
        results[arm].afterRestart = summarize(await snapshot('after-restart'))
        await runtime.close(); runtime = undefined
      }
      save()
    }
    if (!live && results.native && results.fast) {
      results.difference = { canonicalNarratives: [results.native.before.scripts, results.fast.before.scripts],
        alterHistory: [results.native.before.alterHistory, results.fast.before.alterHistory],
        equivalent: results.native.before.scripts === results.fast.before.scripts && results.native.before.alterHistory === results.fast.before.alterHistory }
      assert.equal(results.native.before.scripts, 3)
      assert.equal(results.fast.before.scripts, 1)
      assert.equal(results.native.before.alterHistory, 3)
      assert.equal(results.fast.before.alterHistory, 1)
    }
    if (!live && results.compat) {
      assert.equal(results.compat.before.scripts, 3)
      assert.equal(results.compat.before.alterHistory, 3)
      assert.equal(results.compat.before.alterSystem.alterValue, 6)
    }
    save()
    console.log(JSON.stringify({ report: out, calls: calls.length, summary: results }))
  } finally {
    if (runtime) await runtime.close()
    proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve))
  }
}
function summarize(state) {
  const story = state.interlude_story[0]
  return { scripts: state.interlude_script_entry.filter(row => row.kind === 'script').length,
    userMessages: state.interlude_script_entry.filter(row => row.kind === 'user-message').length,
    visibleMessages: state.interlude_script_entry.filter(row => row.kind === 'character-message').length,
    facts: state.interlude_fact.map(row => ({ content: row.content, status: row.status, sourceEntryIds: row.sourceEntryIds })),
    intents: state.interlude_intent.map(row => ({ type: row.type, summary: row.summary, status: row.status, notBefore: row.notBefore })),
    alterHistory: story?.state.alterSystem?.history?.length ?? 0,
    alterSystem: story?.state.alterSystem,
    workingDetails: story?.state.workingDetails,
    overlay: story?.state.settingOverlay,
    tails: state.famila_hdsi_tail.map(row => ({ status: row.status, sourceEntryId: row.sourceEntryId })) }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
