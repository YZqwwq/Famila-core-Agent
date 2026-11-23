const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { randomUUID } = require('node:crypto')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { startAgentRuntime } = require('../dist/runtime/startRuntime')
const { createFamilaServer } = require('../dist/server')

async function main() {
  process.loadEnvFile('.env')
  Object.assign(process.env, { FAMILA_DB_ENV: 'test', FAMILA_HDSI_ACTIONS: '1', FAMILA_HDSI_MODE: 'native' })
  const marker = randomUUID()
  const directory = await mkdtemp(join(tmpdir(), 'famila-postgres-'))
  let calls = 0
  const provider = createServer(async (req, res) => {
    let raw = ''
    for await (const part of req) raw += part
    const { messages } = JSON.parse(raw)
    let content = '{}'
    if (messages.some(m => m.content.startsWith('【场景物品'))) {
      calls++
      const event = JSON.parse(messages.find(m => m.role === 'user').content).incomingEvent.event.content
      const observation = messages.find(m => m.content.startsWith('【工具观察：'))
      const read = event.includes('读取')
      if (!observation) {
        content = read ? '她翻开笔记。\n【工具调用：读取笔记】\n标题：' + marker + '\n【工具结束】'
          : '她翻开笔记。\n【工具调用：保存笔记】\n标题：' + marker + '\n内容：周六带伞\n【工具结束】'
      } else {
        const receipt = read ? observation.content.includes('周六带伞') : observation.content.includes('saved')
        const reply = receipt ? (read ? '周六带伞。' : '记下了。') : '未找到。'
        content = JSON.stringify({ script: '她看向手机，发出：<say id="r">' + reply + '</say>。',
          interaction: { seen: true, reply: { mode: 'immediate', content: reply } }, alter: 0, editorEffect: 'none' })
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }))
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  const start = async label => startAgentRuntime({ dataDirectory: join(directory, label),
    model: { model: 'fixture', modelKey: 'fixture', baseURL: 'http://127.0.0.1:' + provider.address().port } }, 'hdsi')
  let app
  const send = (requestId, text) => app.inject({ method: 'POST', url: '/messages', payload: { requestId, text } })
  const first = '请帮我记下周六带伞 ' + marker
  try {
    app = createFamilaServer(await start('before'))
    await assert.rejects(start('duplicate'), /running owner/)
    assert.match((await send(marker, first)).body, /记下了。/)
    const before = calls
    await app.close()
    const runtime = await start('after')
    app = createFamilaServer(runtime)
    assert.match((await send(marker, first)).body, /记下了。/)
    assert.equal(calls, before)
    assert.equal((await runtime.getHistory()).messages.filter(row => row.requestId === marker).length, 1)
    assert.match((await send(marker + '-read', '读取刚才的笔记 ' + marker)).body, /周六带伞。/)
    const story = await runtime.workbench()
    assert.ok(story.storyId && story.scenes.length)
    console.log('Test database passed native HTTP chat, owner lock, restart, replay and note read-back.')
  } finally {
    await app?.close()
    await new Promise(resolve => provider.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
