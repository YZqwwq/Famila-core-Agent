const { test } = require('node:test')
const assert = require('node:assert/strict')
const evals = require('../../../.generated/companion-eval.cjs')
const item = { id: 'case', conversation_id: 'story', family: 'memory', split: 'dev', source: 'original',
  mode: 'longitudinal', dimensions: ['memory'], rubric: ['只记已发生事实'], probe_at: 2,
  events: [{ session: 'a', known_at: 1, text: '喜欢蓝色' }, { session: 'b', known_at: 2, text: '现在喜欢绿色' },
    { session: 'c', known_at: 3, text: '未来信息' }], expected_fact: '不应注入的答案' }
test('causal replay excludes future, gold facts, rubric and duplicate first inputs', async () => {
  const seen = []; const sessions = []
  const adapter = { mode: 'agent', supports: { persistence: true, proactive: false, controlledReplay: false },
    async startSession(id) { sessions.push(id) }, async send(text) { seen.push(text); return '回复' }, async close() {} }
  assert.equal((await evals.runCase(item, adapter)).status, 'ok')
  assert.deepEqual(seen, ['喜欢蓝色', '现在喜欢绿色']); assert.deepEqual(sessions, ['a', 'b'])
})
test('errors and unsupported are not zero quality scores', async () => {
  const adapter = new evals.MockAdapter()
  adapter.send = async () => { throw new Error('provider failed') }
  assert.equal((await evals.runCase(item, adapter)).status, 'agent_error')
  assert.equal((await evals.runCase({ ...item, mode: 'replay' }, new evals.MockAdapter())).status, 'unsupported')
  assert.equal(evals.macroAverage([{ family: 'a', conversation: 'a', score: null }]), null)
})
test('macro aggregation weights conversations then families', () => {
  assert.equal(evals.macroAverage([{ family: 'a', conversation: 'a', score: 4 },
    { family: 'a', conversation: 'a', score: 4 }, { family: 'b', conversation: 'b', score: 0 }]), 2)
})
test('judge validates range, ID, dimensions and exact evidence', () => {
  const valid = { case_id: 'case', scores: { memory: { score: 3, reason: '贴合', evidence: '绿色' } },
    critical_violation: false, judge_model: 'fixture', rubric_version: '1.0' }
  assert.ok(evals.validateJudge(valid, item, '绿色'))
  assert.throws(() => evals.validateJudge(valid, item, '蓝色'))
  assert.throws(() => evals.validateJudge({ ...valid, case_id: 'wrong' }, item, '绿色'))
  assert.throws(() => evals.validateJudge('not json', item, '绿色'))
})
test('live requires enforced budget and explicit opt-in; logs redact credentials', () => {
  assert.throws(() => evals.assertLiveAllowed({}))
  assert.throws(() => evals.assertLiveAllowed({ allowLive: true, maxCostUsd: 2 }))
  assert.equal(evals.redact('Bearer secret sk-secret 13812345678'), 'Bearer [REDACTED] [REDACTED] [PHONE]')
})
test('schema rejects extra fields and out-of-range scores', () => {
  assert.throws(() => evals.caseSchema.parse({ ...item, hidden: 'extra' }))
  assert.throws(() => evals.judgeSchema.parse({ case_id: 'case', scores: { memory: { score: 5, reason: 'x', evidence: '' } },
    critical_violation: false, judge_model: 'fixture', rubric_version: '1.0' }))
})
