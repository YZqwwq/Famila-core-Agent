#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { startAgentRuntime } from '../runtime/startRuntime'
import { loadRuntimeConfig } from '../runtime/config'

async function main() {
  const runtime = await startAgentRuntime(loadRuntimeConfig().core)
  const input = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY })
  process.stdout.write(process.env.FAMILA_CHAT_ENGINE === 'hdsi'
    ? 'Famila：输入消息；/exit 等待保存完成后退出。\n'
    : 'Famila：输入消息；/interrupt 停止当前回复，/exit 等待任务完成后退出。\n')
  const interrupt = () => { process.stdout.write(`${runtime.interrupt().message}\n`) }
  input.on('SIGINT', interrupt)
  process.on('SIGINT', interrupt)
  const terminate = () => input.close()
  process.once('SIGTERM', terminate)
  try {
    // Submit lines immediately so /interrupt and queued input work during generation.
    for await (const line of input) {
      const text = line.trim()
      if (!text) continue
      if (text === '/exit') break
      if (text === '/interrupt') { interrupt(); continue }
      let streamed = false
      void runtime.sendMessage({ text, requestId: randomUUID() }, chunk => {
        if (chunk.type === 'text_delta') { process.stdout.write(chunk.content); streamed = true }
        if (chunk.type === 'done' || chunk.type === 'interrupted') {
          if (!streamed) {
            for (const part of chunk.fullContent) {
              if (part.type === 'text') process.stdout.write(part.text)
              else if (part.type === 'code') process.stdout.write(part.code)
              else process.stdout.write(JSON.stringify(part))
            }
          }
          process.stdout.write('\n')
        }
        if (chunk.type === 'stream_error') process.stderr.write(`${chunk.message}\n`)
      }).catch(error => { console.error(error); process.exitCode = 1 })
    }
  } finally {
    input.close()
    await runtime.close()
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
