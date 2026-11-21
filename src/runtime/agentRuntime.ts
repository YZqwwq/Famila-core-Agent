import type { StreamChunk } from '../share/cache/render/aiagent/aiContent'

export interface DeliveredBubble {
  cursor: number
  requestId: string | null
  content: string
  created: number
}

export interface AgentRuntime {
  getStatus(): { accepting: boolean; pendingRequests: number }
  sendMessage(input: { text: string; requestId?: string }, onChunk?: (chunk: StreamChunk) => void): Promise<void>
  getHistory(): Promise<unknown>
  /** Omit after for live only. A cursor replays subsequent persisted bubbles first. */
  deliveries?(after: number | undefined, signal: AbortSignal): AsyncIterable<DeliveredBubble>
  interrupt(): { message: string }
  drain(): Promise<void>
  close(): Promise<void>
}
