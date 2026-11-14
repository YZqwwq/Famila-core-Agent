// Explicit, single-request connectivity probe. Does not start the agent or touch its data.
const { loadRuntimeConfig } = require('../dist/runtime/config')
const { writeFileSync, mkdirSync } = require('node:fs')
async function main() {
  const { core } = loadRuntimeConfig()
  const config = core.model
  if (!config.model || !config.modelKey || !config.baseURL) throw new Error('incomplete_config')
  const url = new URL(config.baseURL.replace(/\/$/, '') + '/chat/completions')
  if (url.protocol !== 'https:') throw new Error('HTTPS required for credentialed probe')
  const started = performance.now()
  const report = { mode: 'single_connection_probe', model: config.model, endpoint: url.origin,
    request_limit: 1, max_output_tokens: 64, attempts: 1, status: 'pending' }
  try {
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.modelKey}` },
      body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: '请只回复：连接成功' }],
        max_tokens: 64, stream: false }) })
    report.http_status = response.status
    const body = await response.json()
    report.status = response.ok && Boolean(body.choices?.[0]?.message?.content?.trim()) ? 'ok' : 'failed'
    report.provider_error_code = String(body.error?.code ?? '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80)
    report.output_present = Boolean(body.choices?.[0]?.message?.content?.trim())
    report.usage = body.usage ? { prompt_tokens: body.usage.prompt_tokens, completion_tokens: body.usage.completion_tokens } : null
  } catch (error) { report.status = 'failed'; report.error_type = error.name }
  report.latency_ms = Math.round(performance.now() - started)
  mkdirSync('evals/companion_zh/reports/connection', { recursive: true })
  writeFileSync('evals/companion_zh/reports/connection/result.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (report.status !== 'ok') process.exitCode = 1
}
main().catch(() => { console.error('Configuration check failed. No credential values were logged.'); process.exitCode = 1 })
