import { z } from 'zod'
import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const dimension = z.enum(['naturalness', 'context_fit', 'emotional_fit', 'non_intrusion', 'persona', 'memory'])
export const caseSchema = z.object({
  id: z.string().min(1), conversation_id: z.string(), family: z.string(), split: z.literal('dev'),
  mode: z.enum(['replay', 'interactive', 'longitudinal']), source: z.literal('original'),
  dimensions: z.array(dimension).min(1).max(4), rubric: z.array(z.string()).min(1),
  events: z.array(z.object({ session: z.string(), known_at: z.number(), text: z.string().min(1) })).min(1),
  probe_at: z.number(), expected_fact: z.string().optional()
}).strict()
export type Case = z.infer<typeof caseSchema>
export const responseSchema = z.object({
  case_id: z.string(), status: z.enum(['ok', 'agent_error', 'timeout', 'unsupported']),
  mode: z.enum(['mock', 'agent']), output: z.string(), latency_ms: z.number().nonnegative(),
  context_hash: z.string(), error: z.string().optional()
}).strict()
export type Response = z.infer<typeof responseSchema>
export const judgeSchema = z.object({
  case_id: z.string(), scores: z.partialRecord(dimension, z.object({ score: z.number().int().min(0).max(4),
    reason: z.string().min(1), evidence: z.string() }).strict()),
  critical_violation: z.boolean(), judge_model: z.string(), rubric_version: z.literal('1.0')
}).strict()
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
export const redact = (value: string): string => value
  .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
  .replace(/\bsk-[a-zA-Z0-9_-]+/g, '[REDACTED]')
  .replace(/\b1[3-9]\d{9}\b/g, '[PHONE]')
export function causalEvents(item: Case) {
  return item.events.filter(event => event.known_at <= item.probe_at)
    .sort((a, b) => a.known_at - b.known_at)
}
export function validateJudge(raw: unknown, item: Case, output: string) {
  const result = judgeSchema.parse(raw)
  if (result.case_id !== item.id) throw new Error('judge_error: case identity mismatch')
  for (const [name, score] of Object.entries(result.scores)) {
    if (!item.dimensions.includes(name as any) || !output.includes(score!.evidence))
      throw new Error('judge_error: invalid dimension or evidence')
  }
  return result
}
export interface AgentAdapter {
  readonly mode: 'mock' | 'agent'
  readonly supports: { controlledReplay: boolean; persistence: boolean; proactive: boolean }
  startSession(session: string): Promise<void>
  send(text: string): Promise<string>
  close(): Promise<void>
}
/** Tests the evaluator plumbing, not language quality. A new instance is required per case. */
export class MockAdapter implements AgentAdapter {
  readonly mode = 'mock' as const
  readonly supports = { controlledReplay: false, persistence: true, proactive: false }
  private history: string[] = []
  async startSession(_session: string) {}
  async send(text: string) { this.history.push(text); return `模拟回复：${text}` }
  async close() { this.history = [] }
}
export function assertLiveAllowed(options: { allowLive?: boolean; maxCostUsd?: number; budgetEnforced?: boolean }) {
  if (!options.allowLive || !(options.maxCostUsd! > 0) || !options.budgetEnforced)
    throw new Error('blocked: live execution requires explicit opt-in and an enforced provider budget')
}
export async function runCase(item: Case, adapter: AgentAdapter): Promise<Response> {
  const events = causalEvents(item)
  const started = performance.now()
  const result: Response = { case_id: item.id, mode: adapter.mode, status: 'ok', output: '', latency_ms: 0,
    context_hash: hash(JSON.stringify(events)) }
  try {
    if (!events.length || (item.mode === 'longitudinal' && !adapter.supports.persistence) ||
        (item.mode === 'replay' && !adapter.supports.controlledReplay)) {
      result.status = 'unsupported'
    } else {
      let session = ''
      for (const event of events) {
        if (event.session !== session) { session = event.session; await adapter.startSession(session) }
        // Only causal user events reach the agent. Never rubric, gold fact or future input.
        result.output = redact(await adapter.send(event.text))
      }
    }
  } catch (error) {
    result.status = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'agent_error'
    result.error = redact(String(error))
  } finally { await adapter.close() }
  result.latency_ms = performance.now() - started
  return responseSchema.parse(result)
}
/** Conversation means first, then family means: long conversations do not gain extra weight. */
export function macroAverage(rows: Array<{ family: string; conversation: string; score: number | null }>) {
  const groups = new Map<string, { family: string; scores: number[] }>()
  for (const row of rows) {
    if (row.score === null) continue
    const key = `${row.family}:${row.conversation}`
    const group = groups.get(key) ?? { family: row.family, scores: [] }
    group.scores.push(row.score); groups.set(key, group)
  }
  const families = new Map<string, number[]>()
  for (const group of groups.values()) {
    const values = families.get(group.family) ?? []
    values.push(group.scores.reduce((a, b) => a + b, 0) / group.scores.length)
    families.set(group.family, values)
  }
  const means = [...families.values()].map(values => values.reduce((a, b) => a + b, 0) / values.length)
  return means.length ? means.reduce((a, b) => a + b, 0) / means.length : null
}
export function loadCases(path: string): Case[] {
  const items = readFileSync(path, 'utf8').trim().split(/\r?\n/).map(line => caseSchema.parse(JSON.parse(line)))
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('duplicate case ID')
  return items
}
export async function smoke(data: string, out: string) {
  const items = loadCases(data)
  mkdirSync(out, { recursive: true })
  const datasetHash = hash(readFileSync(data, 'utf8'))
  const manifestPath = join(out, 'manifest.json')
  const manifest = { timestamp: new Date().toISOString(), mode: 'mock', dataset_sha256: datasetHash,
    evaluator_version: '1.0', split: 'dev', case_ids: items.map(item => item.id),
    model: null, judge_model: null, cost_usd: 0, token_usage: null, calibration: 'not_calibrated',
    proactive: 'not_applicable', real_model_status: 'blocked: model and budget not configured' }
  if (existsSync(manifestPath) && JSON.parse(readFileSync(manifestPath, 'utf8')).dataset_sha256 !== datasetHash)
    throw new Error('Resume dataset mismatch')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  const results: Response[] = []
  for (const item of items) {
    // Resume completed mock cases only; never reuse results across dataset versions.
    const path = join(out, `${item.id}.json`)
    const result = existsSync(path) ? responseSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
      : await runCase(item, new MockAdapter())
    if (result.case_id !== item.id || result.mode !== 'mock') throw new Error('Resume identity mismatch')
    writeFileSync(path, JSON.stringify(result, null, 2)); results.push(result)
  }
  writeFileSync(join(out, 'results.jsonl'), results.map(row => JSON.stringify(row)).join('\n') + '\n')
  writeFileSync(join(out, 'failures.jsonl'), results.filter(row => row.status !== 'ok').map(row => JSON.stringify(row)).join('\n'))
  writeFileSync(join(out, 'report.md'), [
    '# 中文陪聊离线 smoke', '',
    '**仅验证评测管线；不是 Famila 的真实语言质量得分。**',
    `原创开发用例 ${items.length}；执行成功 ${results.filter(row => row.status === 'ok').length}；费用 $0。`,
    'A 自然度 / B 情绪 / C 社交 / D 人格与记忆：未进行真实模型或人工评分，无分数和置信区间。',
    'E 安全：未评判；未发现规则错误不等于安全合格。主动时机为 not_applicable。',
    '模拟跨 session 仅验证回放顺序；真实持久化由核心集成测试另行验证。',
    '真实回放 blocked：需指定模型、隔离运行目录和可强制执行的费用额度；人工校准 not_calibrated。',
    '本集为原创种子集，未经人工审校，不是 HeartBench、CompanionBench 或 ANCHOR 官方得分。',
    '', ...results.map(row => `- ${row.case_id}: ${row.status}，${row.latency_ms.toFixed(1)} ms（模拟耗时）。`)
  ].join('\n'))
  return results
}

if (require.main === module) {
  const root = 'evals/companion_zh'
  if (process.argv.includes('--live')) throw new Error('blocked: no enforced live budget adapter configured')
  mkdirSync(join(root, 'schemas'), { recursive: true })
  for (const [name, schema] of Object.entries({ case: caseSchema, response: responseSchema, judge: judgeSchema }))
    writeFileSync(join(root, 'schemas', `${name}.schema.json`), JSON.stringify(z.toJSONSchema(schema), null, 2))
  smoke(join(root, 'data/seed_zh.jsonl'), join(root, 'reports/smoke')).then(results => {
    console.log(`Offline smoke: ${results.length} cases; no real model score.`)
  }).catch(error => { console.error(redact(String(error))); process.exitCode = 1 })
}
