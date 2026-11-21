const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createServer } = require('node:http')
const Database = require('better-sqlite3')
const { SceneActionStore, parseSceneAction } = require('../dist/runtime/hdsi/sceneActions')
const { startHdsiRuntime } = require('../dist/runtime/hdsi/hdsiRuntime')
const { createFamilaServer } = require('../dist/server')

test('scene actions: bounded prose parsing, atomic notes, replay conflict and uncertain external effects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scene-action-'))
  const file = join(dir, 'actions.sqlite')
  let count = 0
  const tool = { name: '测试外部写入', description: '测试', fields: [], execute: async () => { count++; throw Error('lost receipt') } }
  let store = new SceneActionStore(file, [tool])
  const signal = new AbortController().signal
  try {
    assert.equal(parseSceneAction('她看了看窗外。'), undefined)
    assert.throws(() => parseSceneAction('{"script":"【工具调用：保存笔记】"}'))
    assert.throws(() => parseSceneAction('【工具调用：查询时间】\n\n【工具结束】\n然后她已经查到了。'))
    const action = parseSceneAction('她拿起笔。\n【工具调用：保存笔记】\n标题：出行\n内容：带伞\n标题：这是正文\n【工具结束】')
    assert.equal(action.fields['内容'], '带伞\n标题：这是正文')
    assert.equal(parseSceneAction('【工具调用：保存笔记】\n标题：出行\n内容：\n带伞\n【工具结束】').fields['内容'], '带伞')
    assert.equal(parseSceneAction('【工具调用：读取笔记】\n参数：标题：出行\n【工具结束】').fields['标题'], '出行')
    const result = await store.execute('turn', 0, action, signal)
    assert.match(result, /saved/)
    assert.equal(await store.execute('turn', 0, action, signal), result)
    assert.match(await store.execute('turn', 0, { ...action, fields: { '标题': '别的', '内容': '内容' } }, signal), /变化/)
    assert.match(await store.execute('turn', 1, { name: tool.name, fields: {} }, signal), /未知/)
    store.close(); store = new SceneActionStore(file, [tool])
    assert.match(await store.execute('turn', 1, { name: tool.name, fields: {} }, signal), /未知/)
    assert.equal(count, 1)
    const read = await store.execute('read', 0, { name: '读取笔记', fields: { '标题': '出行' } }, signal)
    assert.equal(JSON.parse(read).content, action.fields['内容'])
    assert.match(await store.execute('bad', 0, { name: '保存笔记', fields: { '标题': '缺正文' } }, signal), /参数/)
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('scene gateway: native HDSI tool loop, real observations, only final commit, HTTP replay and restart', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scene-native-'))
  let mainCalls = 0, ordinaryCalls = 0
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part
    const body = JSON.parse(raw)
    const enabled = body.messages.some(m => m.content.includes('Famila 外围行动规则'))
    let text
    if (!enabled) { ordinaryCalls++; text = '{}' }
    else {
      assert.equal(body.response_format, undefined, 'Plain scene actions must not be constrained by native JSON transport')
      mainCalls++
      const observations = body.messages.filter(m => m.content.startsWith('【工具观察：'))
      const event = JSON.parse(body.messages.find(m => m.role === 'user').content).incomingEvent.event.content
      if (event.includes('晚饭')) text = '她准备烧水。\n\n' + JSON.stringify({ script: '她想起刚才保存笔记并读取核对的事，然后准备煮面，发出：<say id="r">先烧水煮面。</say>。', interaction: { seen: true, reply: { mode: 'immediate', content: '先烧水煮面。' } } })
      else if (observations.length === 0) text = '她准备记住这件事。\n【工具调用：保存笔记】\n标题：出行\n内容：\n周六带伞\n【工具结束】'
      else if (observations.length === 1 && !body.messages.some(m => m.content.startsWith('没有真实的读取笔记回执'))) {
        text = JSON.stringify({ script: '她保存笔记后已经读取核对，发出：<say id="r">核对好了。</say>。', interaction: { seen: true, reply: { mode: 'immediate', content: '核对好了。' } } })
      }
      else if (observations.length === 1) {
        assert.match(observations[0].content, /saved/)
        text = '她决定核对一下。\n【工具调用：读取笔记】\n标题：出行\n【工具结束】'
      } else {
        assert.match(observations[1].content, /周六带伞/)
        text = JSON.stringify({ script: '她写下周六带伞，又核对了记录，发出：<say id="r">记好了，周六带伞。</say>。', interaction: { seen: true, reply: { mode: 'immediate', content: '记好了，周六带伞。' } }, alter: 2 })
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }))
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  const opts = { dataDirectory: dir, model: { model: 'fixture', modelKey: 'fixture', baseURL: `http://127.0.0.1:${provider.address().port}` } }
  let runtime, server
  try {
    runtime = await startHdsiRuntime(opts, { mode: 'native', sceneActions: {}, evaluation: true })
    server = createFamilaServer(runtime)
    const send = () => server.inject({ method: 'POST', url: '/messages', payload: { requestId: 'write-read', text: '帮我记下周六带伞，保存后核对一下。' } })
    const response = await send()
    assert.match(response.body, /记好了，周六带伞/)
    assert.ok(!response.body.includes('工具调用'))
    assert.equal(mainCalls, 4)
    const snapshot = await runtime.evaluate('snapshot')
    assert.equal(snapshot.interlude_script_entry.filter(e => e.kind === 'script').length, 1)
    assert.equal(snapshot.interlude_story[0].state.alterSystem.alterValue, 2)
    assert.equal(snapshot.interlude_script_entry.some(e => e.content.includes('她准备记住')), false)
    assert.match((await send()).body, /记好了/)
    assert.equal(mainCalls, 4)
    const dinner = await server.inject({ method: 'POST', url: '/messages', payload: { requestId: 'dinner', text: '晚饭想煮面，先做什么？' } })
    assert.match(dinner.body, /先烧水煮面/)
    assert.equal(mainCalls, 5, 'Historical note narration must not trigger current-turn note guards')
    await server.close(); server = undefined; runtime = undefined
    runtime = await startHdsiRuntime(opts, { mode: 'native', sceneActions: {} })
    const chunks = []
    await runtime.sendMessage({ requestId: 'write-read', text: '帮我记下周六带伞，保存后核对一下。' }, c => chunks.push(c))
    assert.equal(mainCalls, 5)
    assert.match(chunks[0].content, /记好了/)
    const db = new Database(join(dir, 'hdsi/actions.sqlite'), { readonly: true })
    assert.equal(db.prepare('SELECT count(*) n FROM actions').get().n, 2)
    assert.equal(db.prepare('SELECT content FROM notes').get().content, '周六带伞')
    db.close()
  } finally {
    if (server) await server.close(); else if (runtime) await runtime.close()
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
})
