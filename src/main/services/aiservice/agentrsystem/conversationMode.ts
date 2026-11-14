import type { MessagesState } from './state/messageState'

/** Legacy is retained for baseline comparisons and specialized internal turns. */
export const isConversationTurn = (state: typeof MessagesState.State): boolean =>
  process.env.FAMILA_CHAT_MODE !== 'legacy' &&
  ['user', 'tester'].includes(state.turnInput?.source ?? '')
