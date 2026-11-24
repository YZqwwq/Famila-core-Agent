const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { startHdsiRuntime } = require('../dist/runtime/hdsi/hdsiRuntime')
const { createFamilaServer } = require('../dist/server')

test('workbench protects data and persists the current story across restarts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'famila-workbench-'))
  const options = { dataDirectory: directory, model: { model: 'fixture', modelKey: 'private-fixture-key', baseURL: 'http://127.0.0.1:9' } }
  const start = async () => createFamilaServer(await startHdsiRuntime(options, { isolatedSqlite: true }), { token: 'test' })
  const headers = { authorization: 'Bearer test' }
  let server
  try {
    server = await start()
    assert.match((await server.inject('/workbench')).body, /当前故事/)
    assert.equal((await server.inject('/workbench/data')).statusCode, 401)
    const before = await server.inject({ url: '/workbench/data', headers })
    const { familaStoryDefaults } = require('../dist/runtime/hdsi/persona')
    assert.equal(before.json().setting.name, '法弥拉（Famila）')
    assert.equal(before.json().setting.profile, familaStoryDefaults.characterProfile)
    for (const field of ['relationship', 'world', 'style']) {
      assert.equal(before.json().setting[field], familaStoryDefaults[field])
    }
    assert.equal(before.json().storyId, null)
    assert.ok(!before.body.includes(options.model.modelKey))
    const save = payload => server.inject({ method: 'PATCH', url: '/workbench/story', headers, payload })
    assert.equal((await save({ secret: 'bad' })).statusCode, 400)
    const saved = await save({ name: '梨', profile: '夜班编辑' })
    assert.equal(saved.statusCode, 200, saved.body)
    assert.ok(saved.json().storyId)
    await server.close(); server = await start()
    const after = (await server.inject({ url: '/workbench/data', headers })).json()
    assert.equal(after.setting.profile, '夜班编辑')
    assert.equal(after.setting.name, '梨')
    assert.equal(after.setting.location, before.json().setting.location)
  } finally { await server?.close(); rmSync(directory, { recursive: true, force: true }) }
})
