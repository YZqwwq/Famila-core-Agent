import type { StreamChunk } from '../share/cache/render/aiagent/aiContent'

export interface AgentRuntime {
  getStatus(): { accepting: boolean; pendingRequests: number }
  sendMessage(input: { text: string; requestId?: string }, onChunk?: (chunk: StreamChunk) => void): Promise<void>
  getHistory(): Promise<unknown>
  interrupt(): { message: string }
  drain(): Promise<void>
  close(): Promise<void>
}
