const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { HdsiRuntime } = require('../dist/runtime/hdsi/hdsiRuntime')

test('page observation is restricted to explicit PostgreSQL test evaluation', async () => {
  const options = { dataDirectory: '/unused-evaluation-test' }
  const disabled = new HdsiRuntime(options, { databaseStage: 'test' })
  const sqlite = new HdsiRuntime(options, { isolatedSqlite: true, evaluation: true })
  const production = new HdsiRuntime(options, { databaseStage: 'prod' })
  for (const runtime of [disabled, sqlite, production]) {
    await assert.rejects(runtime.observeTestPage('request', 'loading'), /Requires local evaluation against famila_test/)
  }
  assert.throws(() => new HdsiRuntime(options, { databaseStage: 'prod', evaluation: true }), /Evaluation is unavailable in production/)

  const allowed = new HdsiRuntime(options, { databaseStage: 'test', evaluation: true })
  let sent
  allowed.workerQuery = async frame => { sent = frame; return { outgoing: 0 } }
  assert.deepEqual(await allowed.observeTestPage('unique-request', 'page completed'), { outgoing: 0 })
  assert.deepEqual(sent, { type: 'famila-evaluation', command: 'page-observation',
    sourceId: 'famila-' + createHash('sha256').update('unique-request').digest('hex').slice(0, 40), observation: 'page completed' })
})
