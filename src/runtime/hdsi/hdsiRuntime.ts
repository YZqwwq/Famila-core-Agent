import { fork, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { FamilaCoreOptions } from '../../index'
import type { AgentRuntime, DeliveredBubble } from '../agentRuntime'
import type { StreamChunk } from '../../share/cache/render/aiagent/aiContent'
import { databaseStage } from './postgres'
import { HdsiDatabase } from './hdsiDatabase'
import { SceneGateway } from './sceneGateway'
import type { SceneActionsOptions } from './sceneActions'
export type { SceneTool, SceneActionsOptions } from './sceneActions'
export { createLivingTools, livingToolOptions } from './livingTools'

type Row = { id: string; client_id: string; text: string; status: string }
type Subscriber = { emit?: (chunk: StreamChunk) => void; resolve: () => void; reject: (error: Error) => void }
export type HdsiExecutionOptions = {
  /** Offline regression and isolated historical comparisons only. */
  isolatedSqlite?: boolean
  databaseStage?: import('./postgres').DatabaseStage
  mode?: 'native' | 'fast'
  /** Evaluation only: load a pinned, unmodified local upstream bundle. Never accepted over HTTP. */
  upstreamBundle?: string
  evaluation?: boolean
  /** Evaluation only: equalize bubble/typing/debounce settings across engines. */
  normalizedTransport?: boolean
  /** Outer harness only; HDSI's source and native commit flow are unchanged. */
  sceneActions?: SceneActionsOptions
  /** Local evaluation only. Callback never crosses IPC or HTTP. */
  onDiagnostic?: (text: string) => void
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

/** HDSI owns conversation state. This adapter owns durable admission and the local HTTP outbox. */
export class HdsiRuntime implements AgentRuntime {
  private db!: HdsiDatabase
  private readonly pending = new Set<string>()
  private operations: Promise<void> = Promise.resolve()
  private deliveryVersion = 0
  private readonly lease = randomUUID()
  private child?: ChildProcess
  private accepting = true
  private subscribers = new Map<string, Set<Subscriber>>()
  private deliveryWaiters = new Set<() => void>()
  private state = { pendingTurns: 0, backgroundTails: 0, ready: false }
  private sent = new Set<string>()
  private stopping = false
  private closing?: Promise<void>
  private draining?: Promise<void>
  private drainResolved?: () => void
  private childError?: Error
  private gateway?: SceneGateway
  private inspections = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>()

  constructor(private readonly options: FamilaCoreOptions, private readonly execution: HdsiExecutionOptions = { mode: 'native' }) {
    if (execution.isolatedSqlite && execution.databaseStage) throw new Error('Choose one HDSI storage backend.')
    if (!execution.isolatedSqlite) this.execution = { ...execution, databaseStage: databaseStage(execution.databaseStage) }
    if (execution.mode && !['native', 'fast'].includes(execution.mode)) throw new Error('HDSI mode must be native or fast.')
    if (execution.sceneActions && execution.mode === 'fast') throw new Error('Scene actions require native HDSI execution.')
    if (options.dataSource || options.databasePath) throw new Error('HDSI owns its database; supply dataDirectory only.')
    if (options.model?.vendor && options.model.vendor !== 'openai') throw new Error('HDSI adapter currently requires an OpenAI-compatible model connection.')
  }

  private async openTransport() {
    const directory = resolve(this.options.dataDirectory, 'hdsi')
    mkdirSync(directory, { recursive: true })
    const stage = this.execution.databaseStage
    this.db = stage ? await HdsiDatabase.postgres(stage, error => {
      this.fail(error)
      this.child?.kill()
    }) : HdsiDatabase.sqlite(resolve(directory, 'transport.sqlite'))
    try {
      if (stage) {
        const [lock] = await this.db.all('SELECT pg_try_advisory_lock(197801, 1) AS acquired')
        if (!lock.acquired) throw new Error('This HDSI identity already has a running owner.')
      }
      await this.db.transaction(async query => {
        if (!stage) {
          await query('CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY, token TEXT, pid INTEGER)')
          const [owner] = (await query('SELECT * FROM owner WHERE id=1')).rows
          if (owner) {
            let alive = true
            try { process.kill(owner.pid, 0) } catch (e) { alive = (e as NodeJS.ErrnoException).code !== 'ESRCH' }
            if (alive) throw new Error('This HDSI identity already has a running owner.')
          }
          await query('INSERT OR REPLACE INTO owner VALUES (1,?,?)', this.lease, process.pid)
        }
        const sequence = stage ? ', rowid SERIAL UNIQUE' : ''
        await query('CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, client_id TEXT UNIQUE, text TEXT NOT NULL, status TEXT NOT NULL, created DOUBLE PRECISION NOT NULL' + sequence + ')')
        await query('CREATE TABLE IF NOT EXISTS outbox (key TEXT PRIMARY KEY, inbox_id TEXT, content TEXT NOT NULL, created DOUBLE PRECISION NOT NULL' + sequence + ')')
      })
    } catch (error) { await this.db.close(); throw error }
  }

  async start(): Promise<this> {
    await this.openTransport()
    let workerModel = this.options.model
    if (this.execution.sceneActions) {
      try {
        this.gateway = new SceneGateway(this.options.model ?? {}, this.execution.databaseStage ? this.db : resolve(this.options.dataDirectory, 'hdsi/actions.sqlite'), this.execution.sceneActions)
        workerModel = { ...this.options.model, ...await this.gateway.start() } as typeof workerModel
      } catch (error) { await this.gateway?.close(); await this.release(); throw error }
    }
    const diagnostics = this.execution.evaluation && !!this.execution.onDiagnostic
    const worker = fork(resolve(__dirname, 'worker.js'), [], { stdio: ['ignore', diagnostics ? 'pipe' : 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, HDSI_DESKTOP_BRIDGE: '1' } })
    this.child = worker
    // Upstream diagnostics may contain model material. Do not relay them to HTTP consumers.
    const diagnostic = (data: Buffer) => {
      if (this.execution.evaluation && this.execution.onDiagnostic) {
        let text = data.toString()
        for (const secret of [this.options.model?.modelKey, workerModel?.modelKey]) if (secret) text = text.split(secret).join('[redacted]')
        try { this.execution.onDiagnostic(text) } catch {}
      }
    }
    worker.stderr?.on('data', diagnostic)
    worker.stdout?.on('data', diagnostic)
    worker.on('message', message => { this.operations = this.operations.then(() => this.onMessage(message as any)).catch(error => this.fail(error)) })
    worker.on('error', error => this.fail(error))
    worker.on('exit', () => { if (!this.stopping) this.fail(new Error('HDSI worker exited; persisted requests can recover on restart.')) })
    try {
      const delivered = await this.db.all(`SELECT i.id, i.text, o.content, o.created FROM outbox o
        JOIN inbox i ON i.id=o.inbox_id ORDER BY o.created,o.rowid`)
      const { sceneActions, onDiagnostic, ...workerExecution } = this.execution
      worker.send({ type: 'famila-start', dataDirectory: resolve(this.options.dataDirectory, 'hdsi'), model: workerModel, delivered,
        execution: { ...workerExecution, sceneActionsEnabled: !!sceneActions } })
      const started = Date.now()
      while (!this.state.ready) {
        if (this.childError) throw this.childError
        if (Date.now() - started > 20000) throw new Error('HDSI worker start timeout.')
        await delay(20)
      }
      await this.db.run("UPDATE inbox SET status='completed' WHERE status='delivered'")
      for (const row of await this.db.all("SELECT * FROM inbox WHERE status IN ('queued','processing') ORDER BY created,rowid")) { this.pending.add(row.id); await this.submit(row, true) }
      return this
    } catch (error) { this.stopping = true; worker.kill(); await this.gateway?.close(); await this.release(); throw error }
  }

  getStatus() {
    return { engine: 'hdsi', executionMode: this.execution.mode ?? 'native', sceneActionsEnabled: !!this.execution.sceneActions, accepting: this.accepting && !this.childError,
      pendingRequests: this.pending.size,
      ...this.state }
  }

  sendMessage(input: { text: string; requestId?: string }, emit?: (chunk: StreamChunk) => void): Promise<void> {
    if (!this.accepting || this.childError) return Promise.reject(this.childError ?? new Error('HDSI is draining.'))
    if (!input.text.trim() || input.text.length > 64000) return Promise.reject(new Error('Invalid message.'))
    const clientId = input.requestId?.trim() || randomUUID()
    if (clientId.length > 128) return Promise.reject(new Error('Invalid requestId.'))
    const id = `famila-${hash(clientId).slice(0, 40)}`
    return new Promise<void>((resolve, reject) => {
      const admit = async () => {
        if (this.childError) throw this.childError
        let [row] = await this.db.all('SELECT * FROM inbox WHERE id=?', id)
        if (row && row.text !== input.text) throw new Error('requestId already belongs to different content.')
        if (!row) {
          if (this.getStatus().pendingRequests >= 64) return Promise.reject(new Error('HDSI input queue is full.'))
          await this.db.run("INSERT INTO inbox (id,client_id,text,status,created) VALUES (?,?,?,'queued',?)", id, clientId, input.text, Date.now())
          this.pending.add(id)
          row = { id, client_id: clientId, text: input.text, status: 'queued' }
        }

        const set = this.subscribers.get(id) ?? new Set<Subscriber>()
        set.add({ emit, resolve, reject })
        this.subscribers.set(id, set)
        if (row.status === 'completed') await this.finish(id)
        else if (row.status === 'failed') this.failRequest(id, new Error('Previous HDSI request failed. Use a new requestId to retry.'))
        else {
          try { await this.submit(row, false) } catch (error) { this.failRequest(id, error as Error) }
        }
      }
      this.operations = this.operations.then(admit).catch(reject)
    })
  }

  private async submit(row: Row, recovering: boolean) {
    if (this.sent.has(row.id)) return
    await this.db.run("UPDATE inbox SET status='processing' WHERE id=?", row.id)
    this.sent.add(row.id)
    this.state.pendingTurns++
    this.child?.send({ type: 'famila-inbound', recovering, id: row.id, text: row.text })
  }

  private async onMessage(frame: any): Promise<void> {
    if (frame.type === 'famila-evaluation-result') {
      const pending = this.inspections.get(frame.id)
      this.inspections.delete(frame.id)
      if (frame.error) pending?.reject(new Error(frame.error))
      else pending?.resolve(frame.value)
      return
    }
    if (frame.type === 'famila-drained') { this.drainResolved?.(); return }
    if (frame.type === 'famila-status') { this.state = frame.state; return }
    if (frame.type === 'famila-visible-committed') {
      await this.db.run("UPDATE inbox SET status='completed' WHERE id=? AND status='delivered'", frame.id)
      await this.finish(frame.id)
      return
    }
    if (frame.type === 'famila-fatal') { this.fail(new Error('HDSI worker initialization failed.')); return }
    if (frame.type === 'famila-settled') {
      for (const id of frame.ids as string[]) {
        await this.db.run("UPDATE inbox SET status='completed' WHERE id=? AND status IN ('processing','delivered')", id)
        await this.finish(id)
      }
      return
    }
    if (frame.type !== 'hdsi-desktop') return
    if (frame.event === 'inbound-result' && !frame.payload.accepted) {
      await this.db.run("UPDATE inbox SET status='failed' WHERE id=?", frame.payload.requestId)
      this.failRequest(frame.payload.requestId, new Error('HDSI did not accept the request.'))
    }
    if (frame.event !== 'delivery') return
    const delivery = frame.payload
    const id = delivery.traceId
    const key = delivery.intentKey || `${id}:${hash(delivery.content)}`
    // Separator is transport markup, rendered as a line break without rewriting words.
    const content = String(delivery.content).replace(/<sep\s*\/?>/g, '\n')
    const inserted = await this.db.transaction(async query => {
      const result = await query('INSERT INTO outbox (key,inbox_id,content,created) VALUES (?,?,?,?) ON CONFLICT(key) DO NOTHING', key, id ?? null, content, Date.now())
      if (id) await query("UPDATE inbox SET status=CASE WHEN status='completed' THEN status ELSE 'delivered' END WHERE id=?", id)
      return result.changes
    })
    if (inserted) this.wakeDeliveryReaders()
    this.child?.send({ type: 'hdsi-desktop', command: 'delivery-result', value: {
      deliveryId: delivery.deliveryId, status: 'sent', messageIds: [`famila-outbox-${hash(key)}`]
    } })
    // Wait for the native first-reply boundary before completing HTTP streams.
  }

  private wakeDeliveryReaders() {
    this.deliveryVersion++
    for (const wake of this.deliveryWaiters) wake()
  }

  async *deliveries(after: number | undefined, signal: AbortSignal): AsyncIterable<DeliveredBubble> {
    if (signal.aborted || this.stopping || this.childError) return
    let cursor: number = after ?? (await this.db.all('SELECT coalesce(max(rowid),0) AS id FROM outbox'))[0].id
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid delivery cursor.')
    const read = `SELECT o.rowid AS cursor, i.client_id AS "requestId", o.content, o.created
      FROM outbox o LEFT JOIN inbox i ON i.id=o.inbox_id WHERE o.rowid>? ORDER BY o.rowid LIMIT 64`
    while (!signal.aborted && !this.stopping && !this.childError) {
      const version = this.deliveryVersion
      const rows = await this.db.all(read, cursor) as DeliveredBubble[]
      for (const row of rows) {
        if (signal.aborted || this.stopping || this.childError) return
        cursor = row.cursor
        yield row
      }
      if (rows.length || this.deliveryVersion !== version || signal.aborted || this.stopping || this.childError) continue
      // Register before yielding control after the empty read.
      await new Promise<void>(resolve => {
        const wake = () => {
          signal.removeEventListener('abort', wake)
          this.deliveryWaiters.delete(wake)
          resolve()
        }
        this.deliveryWaiters.add(wake)
        signal.addEventListener('abort', wake, { once: true })
      })
    }
  }

  private async finish(id: string) {
    this.sent.delete(id)
    const content = (await this.db.all('SELECT content FROM outbox WHERE inbox_id=? ORDER BY created,rowid', id)).map((r: any) => r.content).join('\n')
    this.pending.delete(id)
    const listeners = this.subscribers.get(id)
    this.subscribers.delete(id)
    for (const subscriber of listeners ?? []) {
      try { if (content) subscriber.emit?.({ type: 'text_delta', content }); subscriber.emit?.({ type: 'done', fullContent: content ? [{ type: 'text', text: content }] : [] }) } catch {}
      subscriber.resolve()
    }
  }
  private failRequest(id: string, error: Error) {
    this.sent.delete(id)
    this.pending.delete(id)
    for (const subscriber of this.subscribers.get(id) ?? []) subscriber.reject(error)
    this.subscribers.delete(id)
  }
  private fail(error: Error) { this.childError = error; this.wakeDeliveryReaders(); this.accepting = false; this.drainResolved?.(); for (const id of this.subscribers.keys()) this.failRequest(id, error); for (const pending of this.inspections.values()) pending.reject(error); this.inspections.clear() }
  async evaluate(command: 'snapshot' | 'compact' | 'restrict-context'): Promise<any> {
    if (!this.execution.evaluation) throw new Error('Evaluation access is disabled.')
    return this.workerQuery({ type: 'famila-evaluation', command })
  }
  async workbench(patch?: Record<string, string>) {
    const snapshot = await this.workerQuery({ type: 'famila-workbench', patch })
    return { ...snapshot, status: this.getStatus(), model: this.options.model?.model,
      replies: await this.db.all('SELECT content,created FROM outbox ORDER BY rowid DESC LIMIT 40') }
  }
  private async workerQuery(frame: Record<string, unknown>): Promise<any> {
    if (this.childError || !this.child?.connected) throw this.childError ?? new Error('Worker unavailable.')
    const id = randomUUID()
    const result = new Promise((resolvePromise, reject) => this.inspections.set(id, { resolve: resolvePromise, reject }))
    this.child.send({ ...frame, id })
    return result
  }
  async getHistory() {
    return { engine: 'hdsi', messages: await this.db.all(`SELECT client_id AS "requestId", text, status, created FROM inbox ORDER BY created,rowid`),
      replies: await this.db.all('SELECT inbox_id AS "eventId", content, created FROM outbox ORDER BY created,rowid') }
  }
  interrupt() { return { message: 'HDSI uses message-driven conversation scheduling.' } }
  async drain() {
    this.accepting = false
    await this.operations
    if (this.childError || !this.child?.connected) return
    this.draining ??= new Promise<void>(resolvePromise => {
      this.drainResolved = resolvePromise
      this.child!.send({ type: 'famila-drain' })
    })
    await this.draining
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      await this.drain()
      this.stopping = true
      this.wakeDeliveryReaders()
      if (this.child?.connected) {
        const exited = new Promise<void>(resolvePromise => this.child!.once('exit', () => resolvePromise()))
        this.child.send({ type: 'famila-stop' })
        await exited
      }
      await this.gateway?.close()
      await this.operations
      await this.release()
    })()
  }
  private async release() {
    try { if (!this.execution.databaseStage) await this.db.run('DELETE FROM owner WHERE token=?', this.lease) } finally { await this.db.close() }
  }
}

export async function startHdsiRuntime(options: FamilaCoreOptions, execution?: HdsiExecutionOptions): Promise<HdsiRuntime> {
  return new HdsiRuntime(options, execution).start()
}
