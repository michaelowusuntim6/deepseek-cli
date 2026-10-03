/**
 * @license
 * DeepSeek web-chat client — barrel export.
 */

export {
  BASE,
  COMPLETION_PATH,
  DEFAULT_MODEL_TYPE,
  DeepSeekClient,
  createDeepSeekClient,
  type ChatOptions,
  type ChatResult,
} from './client.js';
export {
  getSession,
  loadSession,
  sessionAgeSeconds,
  SESSION_MAX_AGE_SECONDS,
  CHAT_URL,
  type Session,
  type GetSessionOptions,
} from './auth.js';
export { DeepSeekPow, getPowSolver, type PowChallenge } from './pow.js';
export {
  SseFragmentParser,
  dsmlCallsToJson,
  extractToolCallJson,
  type ParsedToolCall,
  type PartKind,
  type StreamPart,
  type StreamState,
} from './sse.js';
