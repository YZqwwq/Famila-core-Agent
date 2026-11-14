// Prompt-level replay, NOT a full agent or memory benchmark. Never executes tools.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const toneV3 = process.argv.includes('--tone-v3')
const toneV2 = process.argv.includes('--tone-v2') || toneV3
const variants = toneV3 ? ['diverse', 'revised'] : toneV2 ? ['examples', 'diverse'] : ['baseline', 'scene', 'examples']
const scene = '眼下是一段手机上的日常聊天。顺着刚才的话接下去，注意力放在眼前具体的人和事上。'
const examples = '以下是独立的表达示例，不是你与当前用户发生过的经历：\n用户：买了杯奶茶，难喝。\n法弥拉：第一口就后悔的那种？\n\n用户：洗完床单就下雨了。\n法弥拉：这雨也太会挑时候了。\n\n用户：算了，不想讲了。\n法弥拉：好，那先不聊这个。\n\n用户：这个方法我试过了，没用。\n法弥拉：那这条划掉。你试的时候卡在哪儿？\n表达示例结束。'
function transform(messages, variant) {
  const result = structuredClone(messages)
  if (variant === 'baseline') return result
  const identity = result.find(m => m.role === 'system' && m.content.includes('｜shared-identity'))
  if (!identity) throw new Error('missing_identity')
  assert(identity.content.includes('一个 AI 对话助手'), 'Capture a fresh neutral baseline first')
  const index = result.findIndex(m => m.role === 'user')
  if (variant === 'scene' || variant === 'examples') result.splice(index, 0, { role: 'system', content: scene + (variant === 'examples' ? '\n\n' + examples : '') })
  if (variant === 'diverse' || variant === 'revised') {
    const prompts = require('../dist/main/services/aiservice/prompt/main_agent/persona/conversationTone')
    result.splice(index, 0, { role: 'system', content: variant === 'revised' ? prompts.CONVERSATION_TONE_EXAMPLES : prompts.CONVERSATION_TONE_EXAMPLES_V2 })
  }
  return result
}
async function main() {
  const capture = process.argv.find(a => a.startsWith('--capture='))?.slice(10)
  if (!capture) throw new Error('capture_directory_required')
  const ids = ['daily-after-work', 'daily-good-news', 'daily-snack']
  const bodies = ids.map(id => JSON.parse(fs.readFileSync(path.join(capture, id + '-request.json'), 'utf8')))
  if (toneV2) {
    const cases = [
      ['rain', '刚出地铁就下大雨，伞还在办公室。'],
      ['lunch', '明天午饭想吃清淡点，帮我挑一个。'],
      ['playful', '我宣布，周一是人类最大的发明失误。'],
      ['correction', '不是难过，我只是觉得这件事很离谱。', [{ role: 'user', content: '他把会议时间改了三次。' }, { role: 'assistant', content: '听起来你很难过。' }]],
      ['listen', '室友又把厨房弄得一团糟，我就吐槽两句，不用帮我想办法。'],
      ['goodbye', '先这样，我去遛狗了。']
    ]
    for (const [id, input, history = []] of cases) {
      const body = structuredClone(bodies[0])
      body.messages = body.messages.filter(m => m.role === 'system')
      const reality = body.messages.find(m => m.content.includes('｜shared-reality'))
      assert(reality)
      reality.content = reality.content.replace('刚下班，感觉今天过了一个世纪。', input)
      body.messages.push(...history, { role: 'user', content: input })
      ids.push(id); bodies.push(body)
    }
  }
  for (const body of bodies) for (const variant of variants) {
    const m = transform(body.messages, variant)
    assert.deepEqual(m.filter(x => x.role !== 'system'), body.messages.filter(x => x.role !== 'system'))
    assert(m.some(x => x.content.includes('未执行的行动不能声称已完成')))
    assert(!m.some(x => x.content.includes('眼下是一段手机')) || ['scene', 'examples'].includes(variant))
  }
  if (!process.argv.includes('--live')) { console.log(`Offline validation passed: ${bodies.length * variants.length} prompt transformations; history and boundaries retained.`); return }
  const cfg = require('../dist/runtime/config').loadRuntimeConfig().core.model
  const url = new URL(cfg.baseURL.replace(/\/$/, '') + '/chat/completions')
  assert.equal(url.protocol, 'https:'); assert(cfg.modelKey)
  const directory = path.resolve('evals/companion_zh/reports', `expression-${Date.now()}`)
  fs.mkdirSync(directory, { recursive: true })
  const results = [], requests = []
  const save = () => fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify({
    mode: 'live_prompt_replay', experiment: toneV3 ? 'diverse_examples_v3' : toneV2 ? 'diverse_examples_v2' : 'neutral_baseline', model: cfg.model, temperature: bodies[0].temperature,
    limits: { requests: 24, output_tokens_per_request: 256, timeout_ms: 20000, retries: 0 },
    caveats: ['Not full agent execution; tools are exposed but not executed.', 'Multi-turn uses actual generated replies; background memory is not replayed.', 'Small exploratory sample; no calibrated judge or statistical significance.'],
    monetary_cost: 'not calculated; usage recorded', results
  }, null, 2))
  async function run(body, variant, caseId, repeat, history = []) {
    assert(requests.length < 24)
    const request = { ...body, model: cfg.model, messages: [...transform(body.messages, variant), ...history], stream: false, max_tokens: 256 }
    delete request.stream_options
    assert(JSON.stringify(request.messages).length < 20000)
    requests.push({ caseId, variant, repeat, body: request })
    fs.writeFileSync(path.join(directory, 'requests.json'), JSON.stringify(requests, null, 2))
    const result = { id: crypto.randomUUID(), variant, case_id: caseId, repeat, status: 'pending',
      dialogue: request.messages.filter(m => m.role !== 'system') }
    results.push(result)
    const start = performance.now()
    try {
      const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.modelKey}` }, body: JSON.stringify(request) })
      result.http_status = response.status
      if (!response.ok) { result.status = 'provider_error'; return result }
      const data = await response.json(), choice = data.choices?.[0]
      result.reply = choice?.message?.content || ''
      result.usage = data.usage
      result.finish_reason = choice?.finish_reason
      result.tool_calls = choice?.message?.tool_calls
      result.status = result.tool_calls?.length ? 'tool_call_not_executed' : choice?.finish_reason === 'length' ? 'truncated' : result.reply ? 'ok' : 'empty'
    } catch (error) { result.status = 'request_error'; result.error_type = error.name }
    finally { result.ms = Math.round(performance.now() - start); save(); console.log(JSON.stringify({ case: caseId, variant, repeat, status: result.status, ms: result.ms })) }
    return result
  }
  // Rotate order to reduce systematic warm-cache/time effects; latency remains exploratory.
  for (let repeat = 0; repeat < (toneV2 ? 1 : 2); repeat++) for (let c = 0; c < ids.length; c++) {
    for (let j = 0; j < variants.length; j++) await run(bodies[c], variants[(j + c + repeat) % variants.length], ids[c], repeat)
  }
  for (const variant of variants) {
    const seed = results.find(r => r.variant === variant && r.case_id === 'daily-snack' && r.repeat === 0)
    if (seed?.status !== 'ok') continue
    const history = [{ role: 'assistant', content: seed.reply }]
    for (const [i, input] of ['家里只有泡面和一个鸡蛋，懒得出门。', '哈哈，吃上了，辣得我直喝水。'].entries()) {
      history.push({ role: 'user', content: input })
      const r = await run(bodies[2], variant, 'snack-followup-' + (i + 1), 0, history)
      if (r.status !== 'ok') break
      history.push({ role: 'assistant', content: r.reply })
    }
  }
  const blind = results.filter(r => r.status === 'ok').map(r => ({ id: r.id, case_id: r.case_id, repeat: r.repeat, dialogue: r.dialogue, reply: r.reply }))
  for (let i = blind.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [blind[i], blind[j]] = [blind[j], blind[i]] }
  fs.writeFileSync(path.join(directory, 'blind-review.json'), JSON.stringify(blind, null, 2))
  console.log(JSON.stringify({ report: directory, calls: requests.length }))
}
main().catch(e => { console.error(e.message); process.exitCode = 1 })
