const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createFamilaServer } = require('../dist/server')
const { readRuntimeConfig } = require('../dist/runtime/config')
const { FamilaRuntime } = require('../dist/runtime/familaRuntime')

test('environment configuration preserves absent values and validates explicit overrides', () => {
  assert.deepEqual(readRuntimeConfig({}).core.model, {})
  const config = readRuntimeConfig({ FAMILA_MODEL: 'chosen', FAMILA_MODEL_API_KEY: 'secret', FAMILA_MODEL_VENDOR: 'anthropic', FAMILA_QUICK_MODEL: 'small' })
  assert.equal(config.core.model.model, 'chosen')
  assert.equal(config.core.model.quickModel, 'small')
  assert.equal(config.core.model.quickModelKey, 'secret')
  assert.equal(config.core.model.quickVendor, 'anthropic')
  assert.throws(() => readRuntimeConfig({ FAMILA_PORT: 'bad' }), /FAMILA_PORT/)
  assert.throws(() => readRuntimeConfig({ FAMILA_HOST: '0.0.0.0' }), /FAMILA_API_TOKEN/)
  assert.throws(() => readRuntimeConfig({ FAMILA_MODEL_VENDOR: 'unknown' }), /FAMILA_MODEL_VENDOR/)
})

test('server validates messages, authenticates, streams terminal events and orders shutdown', async () => {
  const calls = []
  const runtime = {
    getStatus: () => ({ accepting: true }), getHistory: async () => [],
    interrupt: () => ({ ok: true }),
    sendMessage: async (input, onChunk) => {
      calls.push(input)
      onChunk({ type: 'text_delta', content: 'hello\nworld' })
      onChunk({ type: 'done', fullContent: [{ type: 'text', text: 'hello\nworld' }] })
    },
    drain: async () => { calls.push('drain') }, close: async () => { calls.push('close') }
  }
  const app = createFamilaServer(runtime, { token: 'test-token' })
  const headers = { authorization: 'Bearer test-token' }
  try {
    assert.equal((await app.inject({ url: '/health' })).statusCode, 401)
    assert.equal((await app.inject({ url: '/health', headers })).statusCode, 200)
    for (const payload of [{ text: '  ' }, { text: 'hi', workspaceContext: {} }, { text: 'hi', requestId: '' }]) {
      assert.equal((await app.inject({ method: 'POST', url: '/messages', headers, payload })).statusCode, 400)
    }
    assert.equal(calls.length, 0)
    const response = await app.inject({ method: 'POST', url: '/messages', headers, payload: { text: 'hello', requestId: 'request-1' } })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['x-request-id'], 'request-1')
    assert.match(response.body, /event: chunk/)
    assert.match(response.body, /hello\\nworld/)
    assert.match(response.body, /event: complete/)
    assert.deepEqual(calls[0], { text: 'hello', requestId: 'request-1' })
    assert.deepEqual((await app.inject({ method: 'POST', url: '/interrupt', headers })).json(), { ok: true })
  } finally { await app.close() }
  assert.deepEqual(calls.slice(-2), ['drain', 'close'])
})

test('runtime drains accepted work and isolates a failing output consumer', async () => {
  let finish
  let closed = false
  const core = {
    chat: {
      sendStreamMessage: async (_input, onChunk) => {
        onChunk({ type: 'text_delta', content: 'hello' })
        await new Promise(resolve => { finish = resolve })
      }
    },
    close: async () => { closed = true }
  }
  const runtime = new FamilaRuntime(core)
  const turn = runtime.sendMessage({ text: 'hello' }, () => { throw new Error('consumer disconnected') })
  const close = runtime.close()
  assert.equal(closed, false)
  assert.equal(runtime.getStatus().accepting, false)
  await assert.rejects(runtime.sendMessage({ text: 'late input' }), /shutting down/)
  finish()
  await turn
  await close
  assert.equal(closed, true)
  assert.equal(runtime.close(), close)
})

test('server emits an error event without leaking provider credentials', async () => {
  const runtime = {
    getStatus: () => ({ accepting: true }),
    sendMessage: async () => { throw new Error('provider failed: secret-key') },
    drain: async () => {}, close: async () => {}
  }
  const app = createFamilaServer(runtime)
  try {
    const response = await app.inject({ method: 'POST', url: '/messages', payload: { text: 'hello' } })
    assert.match(response.body, /event: error/)
    assert.doesNotMatch(response.body, /secret-key/)
    assert.doesNotMatch(response.body, /event: complete/)
  } finally { await app.close() }
})
