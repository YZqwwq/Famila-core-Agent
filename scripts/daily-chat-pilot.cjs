// Three explicit live scenarios, isolated identities, bounded provider requests.
const fs = require('node:fs')
const path = require('node:path')
const { fork } = require('node:child_process')
const { createServer } = require('node:http')
const scenarios = [
  { id: 'daily-after-work', input: '刚下班，感觉今天过了一个世纪。' },
  { id: 'daily-good-news', input: '我今天被夸了，哈哈哈有点飘。' },
  { id: 'daily-snack', input: '我正在纠结夜宵吃啥，想吃点辣的。' }
]

async function worker() {
  process.once('message', async ({ scenario, directory, model }) => {
    let runtime
    const result = { ...scenario, status: 'pending', reply: '', reply_ms: null }
    try {
      delete process.env.FAMILA_CHAT_MODE
      const { startFamilaRuntime } = require('../dist/runtime/familaRuntime')
      runtime = await startFamilaRuntime({ dataDirectory: directory, model, recover: false })
      const start = performance.now()
      await runtime.sendMessage({ text: scenario.input, requestId: scenario.id }, chunk => {
        if (chunk.type === 'text_delta') {
          result.reply += chunk.content
          result.reply_ms ??= Math.round(performance.now() - start)
        }
        if (chunk.type === 'stream_error') result.status = 'agent_error'
        if (chunk.type === 'done') result.status = 'ok'
      })
      result.turn_ms = Math.round(performance.now() - start)
      await runtime.close()
      runtime = undefined
      result.maintenance = require('../dist/main/services/aiservice/runtime/conversationMaintenance').conversationMaintenance.getStatus()
    } catch (error) { result.status = 'agent_error'; result.error_type = error.name }
    finally {
      if (runtime) await runtime.close().catch(() => {})
      process.send(result, () => process.disconnect())
    }
  })
}

async function main() {
  const captureOnly = process.argv.includes('--capture-only')
  if (!captureOnly && !process.argv.includes('--live')) throw new Error('Explicit --live required')
  const { core } = require('../dist/runtime/config').loadRuntimeConfig()
  const cfg = core.model
  if (!captureOnly && (!cfg.modelKey || !cfg.model || !cfg.baseURL)) throw new Error('Incomplete model config')
  const out = path.resolve('evals/companion_zh/reports', `daily-${Date.now()}`)
  fs.mkdirSync(out, { recursive: true })
  const calls = []
  const results = []
  const limit = 12
  for (const scenario of scenarios) {
    let caseCalls = 0
    const proxy = createServer(async (req, res) => {
      const quick = req.url === '/quick/chat/completions'
      if (req.method !== 'POST' || !['/main/chat/completions', '/quick/chat/completions'].includes(req.url)) {
        res.writeHead(404); res.end(); return
      }
      if (calls.length >= limit || caseCalls >= 4) {
        res.writeHead(400); res.end(JSON.stringify({ error: { message: 'pilot_request_limit', type: 'invalid_request_error' } })); return
      }
      const record = { case_id: scenario.id, channel: quick ? 'background' : 'chat', status: 'pending' }
      calls.push(record); caseCalls++
      const controller = new AbortController()
      res.once('close', () => controller.abort())
      const timer = setTimeout(() => controller.abort(), 20000)
      const started = performance.now()
      try {
        let raw = ''
        for await (const chunk of req) { raw += chunk; if (raw.length > 80000) throw new Error('input_limit') }
        const body = JSON.parse(raw)
        if (JSON.stringify(body.messages).length > 20000) throw new Error('context_limit')
        if (!quick) fs.writeFileSync(path.join(out, scenario.id + '-request.json'), JSON.stringify(body, null, 2))
        if (captureOnly) {
          record.status = 'mock_capture'
          const content = quick ? '{}' : '本条是离线采集占位回复。'
          res.writeHead(200, { 'Content-Type': body.stream ? 'text/event-stream' : 'application/json' })
          res.end(body.stream
            ? `data: ${JSON.stringify({ id: 'capture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'capture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
            : JSON.stringify({ id: 'capture', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }))
          return
        }
        body.max_tokens = quick ? 768 : 256
        if (body.stream) body.stream_options = { include_usage: true }
        const url = new URL((quick ? cfg.quickBaseURL || cfg.baseURL : cfg.baseURL).replace(/\/$/, '') + '/chat/completions')
        if (url.protocol !== 'https:') throw new Error('HTTPS required')
        const response = await fetch(url, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${quick ? cfg.quickModelKey || cfg.modelKey : cfg.modelKey}` },
          body: JSON.stringify(body) })
        record.http_status = response.status
        res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/json' })
        let text = ''
        const decoder = new TextDecoder()
        for await (const chunk of response.body) { text += decoder.decode(chunk, { stream: true }); res.write(chunk) }
        text += decoder.decode()
        const packets = body.stream ? text.split('\n').filter(line => line.startsWith('data: {')).map(line => line.slice(6)) : [text]
        for (const packet of packets) {
          try { const data = JSON.parse(packet); if (data.usage) record.usage = data.usage } catch {}
        }
        record.status = response.ok ? 'ok' : 'provider_error'
        res.end()
      } catch (error) {
        record.status = 'request_error'; record.error_type = error.name
        if (!res.headersSent) res.writeHead(502)
        res.end(JSON.stringify({ error: { message: 'pilot_provider_request_failed' } }))
      } finally { clearTimeout(timer); record.ms = Math.round(performance.now() - started) }
    })
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
    try {
      const address = `http://127.0.0.1:${proxy.address().port}`
      const child = fork(__filename, ['--worker'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
      const result = await new Promise((resolve, reject) => {
        let received
        const deadline = setTimeout(() => { child.kill(); reject(new Error('worker_timeout')) }, 60000)
        child.on('message', message => { received = message })
        child.once('exit', code => { clearTimeout(deadline); if (code === 0 && received) resolve(received); else reject(new Error('worker_failed')) })
        child.once('error', error => { clearTimeout(deadline); reject(error) })
        child.send({ scenario, directory: path.join(out, scenario.id), model: {
          ...cfg, modelKey: 'local-proxy', quickModelKey: 'local-proxy',
          baseURL: address + '/main', quickBaseURL: address + '/quick',
          mainAgentMaxTokens: 256, mainAgentTimeoutMs: 20000, useResponsesApi: false, streaming: true
        } })
      })
      results.push(result)
      console.log(JSON.stringify(result))
    } finally { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)) }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ mode: captureOnly ? 'offline_capture' : 'live_agent', model: cfg.model,
      limits: { calls: limit, per_case_calls: 4, chat_output_tokens: 256, background_output_tokens: 768 },
      monetary_cost: 'not calculated; token usage recorded', results, calls }, null, 2))
  }
  console.log(JSON.stringify({ report: path.join(out, 'results.json'), provider_calls: calls.length }))
}
if (process.argv.includes('--worker')) worker()
else main().catch(error => { console.error(JSON.stringify({ status: 'failed', error_type: error.name })); process.exitCode = 1 })
