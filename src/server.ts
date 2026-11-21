import Fastify from 'fastify'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { PassThrough, Readable } from 'node:stream'
import type { AgentRuntime } from './runtime/agentRuntime'

export function createFamilaServer(runtime: AgentRuntime, options: { token?: string; logger?: boolean } = {}) {
  const app = Fastify({
    logger: options.logger ? { redact: ['req.headers.authorization'] } : false,
    bodyLimit: 256 * 1024,
    keepAliveTimeout: 5000,
    // Reject extra fields rather than silently accepting an application workspace/file contract.
    ajv: { customOptions: { removeAdditional: false } }
  })
  app.addHook('onRequest', async (request, reply) => {
    if (options.token) {
      const expected = Buffer.from(`Bearer ${options.token}`)
      const actual = Buffer.from(request.headers.authorization ?? '')
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return reply.code(401).send({ error: 'Unauthorized' })
      }
    }
    if (!runtime.getStatus().accepting) return reply.code(503).send({ error: 'Agent is shutting down' })
  })

  app.get('/health', async () => ({ status: 'ok', ...runtime.getStatus() }))
  const feeds = new Set<AbortController>()
  if (runtime.deliveries) {
    app.get<{ Querystring: { after?: string } }>('/deliveries', (request, reply) => {
      const raw = request.headers['last-event-id'] ?? request.query.after ?? '0'
      if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        return reply.code(400).send({ error: 'Invalid delivery cursor' })
      }
      const controller = new AbortController()
      feeds.add(controller)
      const stop = () => { controller.abort(); feeds.delete(controller) }
      reply.raw.once('close', stop)
      async function* events() {
        try {
          yield ': connected\n\n'
          for await (const bubble of runtime.deliveries!(Number(raw), controller.signal)) {
            yield `id: ${bubble.cursor}\nevent: bubble\ndata: ${JSON.stringify(bubble)}\n\n`
          }
        } finally { stop() }
      }
      return reply.header('Content-Type', 'text/event-stream; charset=utf-8')
        .header('Cache-Control', 'no-cache, no-transform').header('X-Accel-Buffering', 'no')
        .send(Readable.from(events()))
    })
  }
  app.get('/history', async () => runtime.getHistory())
  app.post('/interrupt', async () => runtime.interrupt())
  app.post<{ Body: { text: string; requestId?: string } }>('/messages', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['text'],
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 64000, pattern: '\\S' },
          requestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '\\S' }
        }
      }
    }
  }, (request, reply) => {
    const requestId = request.body.requestId?.trim() || randomUUID()
    const stream = new PassThrough()
    const write = (event: string, payload: unknown) => {
      if (stream.destroyed || stream.writableEnded) return
      // Callback-based kernel streams cannot await HTTP backpressure. Disconnect slow consumers
      // at a fixed bound; the durable turn continues and remains available in history.
      if (stream.writableLength + stream.readableLength > 1024 * 1024) {
        stream.destroy()
        return
      }
      stream.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
    }
    reply.raw.once('close', () => stream.destroy())
    reply.header('Content-Type', 'text/event-stream; charset=utf-8')
      .header('Cache-Control', 'no-cache, no-transform')
      .header('X-Accel-Buffering', 'no')
      .header('X-Request-Id', requestId)
    write('request', { requestId })
    const heartbeat = setInterval(() => {
      if (!stream.destroyed) write('heartbeat', { requestId })
    }, 15000)
    heartbeat.unref()
    stream.once('close', () => clearInterval(heartbeat))
    void runtime.sendMessage({ text: request.body.text, requestId }, chunk => write('chunk', chunk))
      .then(() => write('complete', { requestId }), error => {
        request.log.error({ err: error, requestId }, 'Agent turn failed')
        write('error', { requestId, message: 'Agent turn failed. Inspect local logs for details.' })
      })
      .finally(() => { clearInterval(heartbeat); stream.end() })
    return reply.send(stream)
  })
  // Drain durable work before Fastify waits for open streaming responses to finish.
  app.addHook('preClose', async () => { await runtime.drain(); for (const feed of feeds) feed.abort() })
  app.addHook('onClose', async () => { await runtime.close() })
  return app
}
