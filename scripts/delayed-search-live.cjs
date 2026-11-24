const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { setTimeout: sleep } = require('node:timers/promises')
const { startHdsiRuntime } = require('../dist/runtime/hdsi/hdsiRuntime')
const { loadRuntimeConfig } = require('../dist/runtime/config')

async function main() {
  const model = loadRuntimeConfig().core.model
  const grounded = process.argv.includes('--grounded')
  const notify = grounded || process.argv.includes('--notify')
  const start = Date.now()
  const dir = path.resolve('evals/companion_zh/reports', 'delayed-search-' + start)
  fs.mkdirSync(dir, { recursive: true })
  const log = []
  const record = (type, data) => {
    log.push({ seconds: (Date.now() - start) / 1000, type, data })
    fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(log, null, 2))
  }
  const report = path.join(dir, 'scenes.md')
  fs.writeFileSync(report, '# 延时搜索实验\n\n模型：' + model.model + '。本地原生 HDSI；展览与搜索页数据为实验虚构。\n')
  console.log(report)
  let calls = 0
  const proxy = createServer(async (req, res) => {
    try {
      if (++calls > 18) throw Error('model budget')
      const id = calls
      let raw = ''
      for await (const c of req) raw += c
      if (grounded) {
        const body = JSON.parse(raw)
        if (body.messages.some(m => typeof m.content === 'string' && m.content.includes('living stage script'))) {
          const page = !launched ? '空白，尚未提交查询。' : Date.now()-launched < 90000
            ? '查询已提交。页面显示加载中，结果列表为空。' : result
          body.messages.push({ role: 'system', content: '桌上电脑的展讯页此刻显示：' + page +
            '。这是场景物品的实时状态；能看见的展讯以本页为准。收到搜索请求时，打开页面用工具行动提交。是否看屏幕、是否发消息由她决定。发出去过的话以对话记录为准。' })
          raw = JSON.stringify(body)
        }
      }
      const r = await fetch(model.baseURL.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(100000),
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + model.modelKey }, body: raw })
      const body = await r.text()
      if (r.ok) record('模型输出 ' + id, JSON.parse(body).choices?.[0]?.message?.content)
      res.writeHead(r.status, { 'content-type': 'application/json' }).end(body)
    } catch { res.writeHead(502).end('{}') }
  })
  await new Promise(ok => proxy.listen(0, '127.0.0.1', ok))
  let launched, ready, timer, runtime, lastEntry = 0
  const result = (notify ? '桌面展讯提醒响了一声，搜索结果卡片亮在屏幕上。' : '') + '浏览器搜索页加载完成。实验展讯：周六，纸月展厅《蓝线》开放至21:30，地铁口步行3分钟；远山仓库《白石》开放至22:00，地铁口步行28分钟。'
  const tools = [{ name: '打开展讯搜索页', description: '输入关键词并打开浏览器搜索页。页面异步加载，结果会自行出现；重复打开同一页只显示当前状态。', fields: ['关键词'], readOnly: true,
    validateReply({ userMessage }) {
      if (!launched && userMessage.includes('用浏览器搜')) return '浏览器还没有收到查询。请用「打开展讯搜索页」行动块实际提交关键词；页面返回什么取决于回执。'
    },
    async execute(fields) {
      if (!launched) {
        launched = Date.now()
        record('搜索开始', fields)
        ready = new Promise(resolve => { timer = setTimeout(() => { record('搜索结果到达', result); resolve() }, 90000) })
      }
      return { 页面: Date.now() - launched < 90000 ? '正在加载；当前没有展讯' : result }
    } }]
  const scenes = []
  let delivered = 0
  async function stage(label, input, action) {
    const begin = Date.now()
    record(label, input)
    await action()
    const snapshot = await runtime.evaluate('snapshot')
    const entries = snapshot.interlude_script_entry.filter(e => e.id > lastEntry).sort((a,b) => a.id-b.id)
    lastEntry = Math.max(lastEntry, ...entries.map(e => e.id))
    const scripts = entries.filter(e => e.kind === 'script')
    const history = await runtime.getHistory()
    const bubbles = history.replies.slice(delivered)
    delivered = history.replies.length
    const block = ['\n## ' + label, input, '耗时 ' + ((Date.now()-begin)/1000).toFixed(2) + ' 秒',
      ...scripts.map(e => '### 剧本原文\n\n' + e.content), '### 本地发件箱实际回复',
      bubbles.map(e => e.content).join('\n\n') || '（无）'].join('\n\n')
    fs.appendFileSync(report, block + '\n')
    record('本幕条目', entries.map(e => ({id:e.id, kind:e.kind, content:e.content})))
    scenes.push({ label, scripts, bubbles })
    console.log(label, scripts.length, 'scripts;', bubbles.length, 'bubbles')
    assert.ok(scripts.length, '原生内核没有提交本幕')
  }
  try {
    runtime = await startHdsiRuntime({ dataDirectory: dir, model: { ...model, modelKey:'local', baseURL:'http://127.0.0.1:' + proxy.address().port } },
      { mode:'native', evaluation:true, isolatedSqlite:true, normalizedTransport:true, sceneActions:{ tools } })
    const first = '帮我用浏览器搜一下，周六晚上杭州有什么展可以逛？' + (notify ? '我现在在订行程，搜到就告诉我，我等着。' : '')
    await stage('第一幕 · 发起搜索', first, () => runtime.sendMessage({requestId:'search',text:first}))
    assert.ok(launched, '本次没有实际启动工具')
    const extra = '对了，我那天不想走太远，最好离地铁近一点。'
    await stage('第二幕 · 加条件', extra, () => runtime.sendMessage({requestId:'preference',text:extra}))
    assert.ok(Date.now()-launched < 90000, '第二幕未在结果到达前完成')
    await sleep(Math.max(0, launched+40000-Date.now()))
    if (Date.now()-launched < 90000) {
      const pending = '浏览器页面仍显示加载中，距离提交已过了一会儿，目前没有任何展讯。'
      await stage('第三幕 · 等待提醒',pending,()=>runtime.observeTestPage('search',pending))
    }
    await ready
    await stage('第四幕 · 页面返回',result,()=>runtime.observeTestPage('search',result))
    const last = scenes.at(-1)
    const text = last.bubbles.map(e=>e.content).join(' ')
    record('验收', { secondBeforeResult:true, finalVisibleNear:/蓝线|纸月/.test(text) && /地铁|3分钟|三分钟/.test(text), calls })
  } finally { clearTimeout(timer); await runtime?.close(); proxy.closeAllConnections(); await new Promise(ok=>proxy.close(ok)) }
}
main().catch(e=>{console.error(e.message);process.exitCode=1})
