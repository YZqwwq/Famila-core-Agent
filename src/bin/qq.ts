import { createHash } from 'node:crypto'
import { setTimeout as wait } from 'node:timers/promises'
import { databaseStage, postgresConfig } from '../runtime/hdsi/postgres'

const api = 'https://api.bot.qq.com'
const appId = process.env.FAMILA_QQ_ID
const secret = process.env.FAMILA_QQ_SECRET
const bindCode = process.env.FAMILA_QQ_BIND_CODE
const local = 'http://127.0.0.1:' + (process.env.FAMILA_PORT || '4317')
let db: any
let access = '', expires = 0
let session = '', sequence: number | null = null

async function token() {
  if (access && Date.now() < expires) return access
  const response = await fetch(api + '/app/getAppAccessToken', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: secret })
  })
  const data = await response.json() as any
  if (!response.ok || !data.access_token) throw Error('QQ token request failed: ' + response.status)
  access = data.access_token
  expires = Date.now() + Math.max(1, Number(data.expires_in) - 60) * 1000
  return access
}

export function privateMessage(frame: any) {
  if (frame?.op !== 0 || frame.t !== 'C2C_MESSAGE_CREATE') return
  const { author, id, content } = frame.d ?? {}
  if (frame.d.message_type != null && frame.d.message_type !== 0 || author?.bot) return
  const ext = frame.d.message_scene?.ext
  const index = Array.isArray(ext) && ext.find(x => typeof x === 'string' && x.startsWith('msg_idx='))
  const sender = author?.user_openid
  if (typeof sender !== 'string' || !sender || typeof id !== 'string' || !id || typeof content !== 'string' || !content.trim() || content.length > 64000) return
  return { sender, id, index: index ? index.slice(8) : id, text: content.trim() }
}

async function receive(frame: any, gatewayAt: number) {
  const message = privateMessage(frame)
  if (!message) return
  const { sender, id, index, text } = message
  if (text.startsWith('绑定 ')) {
    if (text !== '绑定 ' + bindCode) return
    await db.query('INSERT INTO qq_owner(app,openid) VALUES($1,$2) ON CONFLICT DO NOTHING', [appId, sender])
    return
  }
  const request = 'qq-' + createHash('sha256').update(JSON.stringify([appId, sender, index])).digest('hex')
  const result = await db.query(`INSERT INTO qq_message(request,app,msg,openid,content)
    SELECT $1,$2,$3,$4,$5 FROM qq_owner WHERE app=$2 AND openid=$4 ON CONFLICT DO NOTHING RETURNING request`, [request, appId, id, sender, text])
  if (result.rowCount && process.env.FAMILA_TIMING === '1') {
    const qqAt = Date.parse(frame.d.timestamp)
    console.info(JSON.stringify({ timing: 'qq_received', request, qqAt: Number.isFinite(qqAt) ? qqAt : null, gatewayAt, storedAt: Date.now() }))
  }
}

async function gateway() {
  const authorization = 'QQBot ' + await token()
  const response = await fetch(api + '/gateway', { headers: { authorization }, signal: AbortSignal.timeout(10000), redirect: 'error' })
  if (!response.ok) { if (response.status === 401) expires = 0; throw Error('Gateway lookup: ' + response.status) }
  const url = new URL(((await response.json()) as any).url)
  if (url.protocol !== 'wss:' || !url.hostname.endsWith('.qq.com')) throw Error('Unexpected gateway')
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url)
    let heartbeat: NodeJS.Timeout | undefined
    const handshake = setTimeout(() => ws.close(), 20000)
    let ack = true
    let events = Promise.resolve()
    const send = (op: number, d: unknown) => ws.send(JSON.stringify({ op, d }))
    ws.onmessage = event => {
      let f
      try { f = JSON.parse(String(event.data)) } catch { ws.close(); return }
      if (f.op === 10) {
        if (session) send(6, { token: authorization, session_id: session, seq: sequence })
        else send(2, { token: authorization, intents: 1 << 25, shard: [0, 1], properties: {} })
        heartbeat = setInterval(() => {
          if (!ack || ws.readyState !== WebSocket.OPEN) { ws.close(); return }
          ack = false
          send(1, sequence)
        }, f.d.heartbeat_interval)
      } else if (f.op === 11) ack = true
      else if (f.op === 9 || f.op === 7) {
        if (f.op === 9) { session = ''; sequence = null }
        ws.close()
      } else if (f.op === 0) {
        const gatewayAt = Date.now()
        events = events.then(async () => {
          if (f.t === 'READY' || f.t === 'RESUMED') {
            clearTimeout(handshake)
            if (f.t === 'READY') session = f.d.session_id
            console.log('QQ gateway ' + f.t)
          }
          await receive(f, gatewayAt)
          sequence = f.s
        })
        void events.catch(() => ws.close())
      }
    }
    ws.onerror = () => ws.close()
    ws.onclose = event => {
      clearInterval(heartbeat)
      clearTimeout(handshake)
      if ([4004,4007,4009].includes(event.code)) { session = ''; sequence = null; expires = 0 }
      events.then(resolve, reject)
    }
  })
}

async function admit(row: any) {
  const response = await fetch(local + '/messages', { method: 'POST', signal: AbortSignal.timeout(180000),
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.FAMILA_API_TOKEN },
    body: JSON.stringify({ requestId: row.request, text: row.content }) })
  if (!response.ok) throw Error('Famila HTTP ' + response.status)
  const stream = await response.text()
  if (!stream.includes('event: complete')) throw Error('Famila did not complete')
  await db.query('UPDATE qq_message SET admitted=true WHERE request=$1', [row.request])
}

async function admissions() {
  const active = new Set<string>()
  while (true) {
    const { rows } = await db.query('SELECT request,content FROM qq_message WHERE app=$1 AND NOT admitted AND retry_at<=now() ORDER BY received LIMIT 64', [appId])
    for (const row of rows) {
      if (active.has(row.request) || active.size >= 8) continue
      active.add(row.request)
      void admit(row).catch(async () => {
        await db.query("UPDATE qq_message SET retry_at=now()+interval '10 seconds' WHERE request=$1", [row.request])
      }).finally(() => active.delete(row.request))
    }
    await wait(500)
  }
}

async function deliveries() {
  while (true) {
    const { rows } = await db.query(`SELECT m.request,m.msg,m.openid,m.seq,o.rowid,o.content FROM qq_message m
      JOIN inbox i ON i.client_id=m.request JOIN outbox o ON o.inbox_id=i.id AND o.rowid>m.cursor
      WHERE m.app=$1 AND NOT m.closed ORDER BY o.rowid LIMIT 1`, [appId])
    if (!rows.length) { await wait(650); continue }
    const r = rows[0]
    const authorization = 'QQBot ' + await token()
    const sendAt = Date.now()
    const response = await fetch(api + '/v2/users/' + encodeURIComponent(r.openid) + '/messages', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 0, content: r.content, msg_id: r.msg, msg_seq: r.seq + 1 })
    })
    if (process.env.FAMILA_TIMING === '1') console.info(JSON.stringify({ timing: 'qq_response', request: r.request, bubble: r.rowid, seq: r.seq + 1, sendAt, at: Date.now(), status: response.status }))
    if (response.ok) {
      await db.query('UPDATE qq_message SET cursor=$2,seq=seq+1 WHERE request=$1', [r.request, r.rowid])
    } else {
      const error = await response.json().catch(() => ({})) as any
      console.warn('QQ reply HTTP %d code %s', response.status, error.code)
      if (response.status === 401) expires = 0
      if (response.status === 401 || response.status === 429 || response.status >= 500) await wait(3000)
      else await db.query('UPDATE qq_message SET closed=true WHERE request=$1', [r.request])
    }
  }
}

async function main() {
  if (!appId || !secret || !bindCode || bindCode.length < 12 || !process.env.FAMILA_API_TOKEN) throw Error('Incomplete QQ adapter configuration')
  const { connection, connect_timeout, ...config } = postgresConfig(databaseStage())
  db = new (require('pg').Pool)({ ...config, options: '-c search_path=' + connection.search_path, connectionTimeoutMillis: connect_timeout * 1000 })
  const lock = await db.connect()
  if (!(await lock.query('SELECT pg_try_advisory_lock(197801,2) AS ok')).rows[0].ok) throw Error('QQ adapter already running')
  await db.query(`CREATE TABLE IF NOT EXISTS qq_owner(app text PRIMARY KEY,openid text NOT NULL);
    CREATE TABLE IF NOT EXISTS qq_message(request text PRIMARY KEY,app text NOT NULL,msg text NOT NULL,openid text NOT NULL,content text NOT NULL,
      received timestamptz DEFAULT now(),retry_at timestamptz DEFAULT now(),admitted boolean DEFAULT false,closed boolean DEFAULT false,
      cursor integer DEFAULT 0,seq integer DEFAULT 0);
    CREATE INDEX IF NOT EXISTS qq_message_pending ON qq_message(app,received) WHERE NOT admitted`)
  async function reconnect() {
    while (true) {
      try { await gateway() } catch { console.warn('QQ gateway reconnecting') }
      await wait(3000)
    }
  }
  await Promise.all([reconnect(), admissions(), deliveries()])
}
if (require.main === module) main().catch(e => { console.error('QQ adapter stopped:', e.code || e.name); process.exit(1) })
