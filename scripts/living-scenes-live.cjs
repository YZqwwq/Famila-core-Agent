const fs = require('node:fs')
const path = require('node:path')
const { createServer } = require('node:http')
const Database = require('better-sqlite3')
const { startHdsiRuntime, createLivingTools, livingToolOptions } = require('../dist/runtime/hdsi/hdsiRuntime')
async function main() {
  const cfg = require('../dist/runtime/config').loadRuntimeConfig().core.model
  const out = path.resolve(__dirname, '../evals/companion_zh/reports', `living-scenes-${Date.now()}`)
  fs.mkdirSync(out, { recursive: true })
  const calls = [], tools = [], turns = []
  const filter = process.argv.find(arg => arg.startsWith('--scenes='))?.slice(9).split(',')
  let active = '', searches = 0
  const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ model: cfg.model,
    limits: { mainCalls: 18, mainOutputTokens: 2048, searchCalls: 2, searchOutputTokens: 800 }, calls, tools, turns }, null, 2))
  const proxy = createServer(async (req, res) => {
    if (calls.length >= 18) { res.writeHead(429).end('{}'); return }
    const record = { id: calls.length + 1, scene: active }; calls.push(record)
    try {
      let raw = ''; for await (const part of req) { raw += part; if (raw.length > 300000) throw Error('input_limit') }
      const body = JSON.parse(raw); body.max_tokens = 2048
      fs.writeFileSync(path.join(out, `request-${record.id}.json`), JSON.stringify(body, null, 2))
      const start = Date.now()
      const response = await fetch(cfg.baseURL.replace(/\/$/, '') + '/chat/completions', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.modelKey}` }, body: JSON.stringify(body) })
      const text = await response.text(); record.ms = Date.now() - start; record.status = response.status
      if (response.ok) { const value = JSON.parse(text); record.usage = value.usage; fs.writeFileSync(path.join(out, `output-${record.id}.txt`), value.choices?.[0]?.message?.content ?? '') }
      res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(text)
    } catch (error) { record.error = error.name; res.writeHead(502).end('{}') }
    finally { save() }
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const instrument = list => list.map(tool => ({ ...tool, async execute(fields, ctx) {
    const record = { scene: active, name: tool.name, fields, started: Date.now() }; tools.push(record)
    try {
      if (tool.name === '搜索公开信息' && ++searches > 2) return record.result = { ok: false, message: '测试搜索预算已耗尽。' }
      return record.result = await tool.execute(fields, ctx)
    } finally { record.ms = Date.now() - record.started; save() }
  } }))
  let runtime
  const run = async (id, text, directory) => {
    if (filter && !filter.includes(id)) return
    active = id
    const turn = { id, input: text, reply: '' }, start = Date.now()
    const controller = new AbortController()
    turn.bubbles = []
    const collect = (async () => {
      for await (const bubble of runtime.deliveries(undefined, controller.signal)) {
        if (bubble.requestId !== id) continue
        turn.bubbles.push({ content: bubble.content, ms: Date.now() - start, cursor: bubble.cursor })
        turn.reply = turn.bubbles.map(b => b.content).join('\n')
      }
    })()
    try {
      await runtime.sendMessage({ requestId: id, text })
      turn.requestMs = Date.now() - start
      const messageId = 'famila-' + require('node:crypto').createHash('sha256').update(id).digest('hex').slice(0, 40)
      const deadline = Date.now() + 60000
      let scene, segments
      do {
        const native = await runtime.evaluate('snapshot')
        const inbound = native.interlude_script_entry.find(e => e.kind === 'user-message' && e.metadata?.messageId === messageId)
        scene = inbound && native.interlude_script_entry.find(e => e.kind === 'script' && e.id > inbound.id && e.storyId === inbound.storyId)
        segments = (scene?.metadata?.deliveryActions ?? []).flatMap(a => a.segments ?? []).filter(s => s.kind === 'message')
        if (segments.every(s => s.status === 'delivered') && segments.length === turn.bubbles.length) break
        await new Promise(resolve => setTimeout(resolve, 250))
      } while (Date.now() < deadline)
      turn.firstBubbleMs = turn.bubbles[0]?.ms ?? null
      turn.ms = turn.bubbles.at(-1)?.ms ?? turn.requestMs
      turn.scene = scene?.content ?? null
      turn.plannedReply = scene?.metadata?.interaction?.reply?.content ?? null
      turn.deliveryState = scene?.metadata?.deliveryActions ?? []
      if (!segments.length || segments.length !== turn.bubbles.length || segments.some((s, i) => s.status !== 'delivered' || s.content !== turn.bubbles[i].content)) {
        throw new Error('Delivered bubbles differ from native delivery ledger')
      }
      turn.modelArtifacts = calls.filter(c => c.scene === id).map(c => `output-${c.id}.txt`)
      const db = new Database(path.join(directory, 'hdsi/actions.sqlite'), { readonly: true })
      try { turn.notes = db.prepare('SELECT title,content FROM notes').all(); turn.receipts = db.prepare('SELECT id,status,result FROM actions').all() } finally { db.close() }
      const used = tools.filter(t => t.scene === id)
      if (id === 'chat') turn.functionalPass = used.length === 0 && turn.receipts.length === 0 && !!turn.reply
      if (id === 'weather') turn.functionalPass = used.some(t => t.name === '查询天气' && t.result?.ok === true) && !!turn.reply
      if (id === 'note') turn.functionalPass = !!turn.reply && turn.notes.some(n => n.title === '明日出门' && n.content.trim()) && turn.receipts.some(r => /"saved":true/.test(r.result)) && turn.receipts.some(r => /"content":/.test(r.result))
      if (id === 'dinner') turn.functionalPass = used.some(t => t.name === '搜索公开信息' && t.result?.ok === true && t.result.sources.length) && !!turn.reply
      if (id === 'failure') turn.functionalPass = used.some(t => t.name === '查询天气' && t.result?.ok === false) && /查不了|查不到|没查到|无法|没拿到|查不|连不上|没有查|暂时|服务|打不开|没连|没能|没有.*数据|刷不出|没刷出来|崩了/.test(turn.reply)
    } catch (error) { turn.error = error.message; turn.functionalPass = false }
    finally { controller.abort(); await collect }
    turns.push(turn); save(); console.log(JSON.stringify({ id, reply: turn.reply, scene: turn.scene, plannedReply: turn.plannedReply, deliveryState: turn.deliveryState, ms: turn.ms, functionalPass: turn.functionalPass, error: turn.error }))
  }
  const start = async (name, list) => {
    const directory = path.join(out, name)
    runtime = await startHdsiRuntime({ dataDirectory: directory, model: { ...cfg, modelKey: 'local', baseURL: `http://127.0.0.1:${proxy.address().port}` } }, { mode: 'native', evaluation: true,
      onDiagnostic: text => fs.appendFileSync(path.join(out, 'worker-diagnostics.log'), text), sceneActions: { tools: instrument(list) } })
    return directory
  }
  try {
    const directory = await start('daily', createLivingTools(livingToolOptions(cfg)))
    await run('chat', '今天忙了一天，终于能坐下来歇会儿了，先陪我闲聊两句。', directory)
    await run('weather', '我明天要在浙江杭州出门，帮我查一下明天的天气，看看该穿什么、要不要带伞。', directory)
    await run('note', '把刚才出门要带的东西保存成一条笔记，标题叫“明日出门”，存好后读出来核对一下。', directory)
    await run('dinner', '我家只有鸡蛋和番茄，今晚想煮面。帮我联网查一个简单做法，别给我列一堆，告诉我先做什么就行。', directory)
    fs.writeFileSync(path.join(out, 'daily-native.json'), JSON.stringify(await runtime.evaluate('snapshot'), null, 2))
    await runtime.close(); runtime = undefined
    const fault = createLivingTools({ ...livingToolOptions(cfg), fetch: async () => { throw Error('simulated_weather_offline') } }).filter(t => t.name === '查询天气')
    const failureDirectory = await start('failure', fault)
    await run('failure', '我明天要在浙江杭州出门，帮我查一下明天会不会下雨。', failureDirectory)
    fs.writeFileSync(path.join(out, 'failure-native.json'), JSON.stringify(await runtime.evaluate('snapshot'), null, 2))
    console.log(JSON.stringify({ report: out, passed: turns.filter(t => t.functionalPass).length, total: turns.length, calls: calls.length, searches }))
    if (turns.some(t => !t.functionalPass)) process.exitCode = 1
  } finally {
    if (runtime) await runtime.close()
    proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve))
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
