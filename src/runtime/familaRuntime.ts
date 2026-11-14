import { setTimeout as delay } from 'node:timers/promises'
import { initializeFamilaCore, type FamilaCore, type FamilaCoreOptions, type MainAgentUserMessageInput, type StreamChunk } from '../index'
import { mainAgentDispatchService } from '../main/services/aiservice/runtime/queue/mainAgentDispatchQueueService'
import { subAgentExecutionQueueService } from '../main/services/task/queue/subAgentExecutionQueueService'

/** Owns the agent lifetime independently of HTTP connections or a terminal. */
export class FamilaRuntime {
  private accepting = true
  private pending = new Set<Promise<void>>()
  private closing?: Promise<void>
  private draining?: Promise<void>

  constructor(private readonly core: FamilaCore) {}

  getStatus() {
    return {
      accepting: this.accepting,
      pendingRequests: this.pending.size,
      dispatch: mainAgentDispatchService.getSnapshot(),
      childQueueIdle: subAgentExecutionQueueService.isIdle()
    }
  }

  sendMessage(input: MainAgentUserMessageInput, onChunk?: (chunk: StreamChunk) => void): Promise<void> {
    if (!this.accepting) return Promise.reject(new Error('Famila runtime is shutting down.'))
    // A failed/disconnected consumer must never roll back an agent turn.
    const operation = this.core.chat.sendStreamMessage(input, chunk => {
      try { onChunk?.(chunk) } catch { /* Delivery is independent of execution. */ }
    })
    this.pending.add(operation)
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation))
    return operation
  }

  getHistory() { return this.core.chat.getHistory() }
  interrupt() { return this.core.chat.interruptCurrentRun() }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closing = this.drain().then(() => this.core.close())
    return this.closing
  }

  drain(): Promise<void> {
    this.accepting = false
    this.draining ??= this.waitForIdle()
    return this.draining
  }

  private async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.pending])
    // Includes recovered events and child notifications not submitted through this wrapper.
    while (mainAgentDispatchService.getState() !== 'idle' || !subAgentExecutionQueueService.isIdle()) {
      await delay(25)
    }
  }
}

export async function startFamilaRuntime(options: FamilaCoreOptions): Promise<FamilaRuntime> {
  return new FamilaRuntime(await initializeFamilaCore(options))
}
