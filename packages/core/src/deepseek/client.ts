/**
 * @license
 * DeepSeek web-chat client — port of DeepSeek-API/deepseek/client.py.
 *
 * Speaks chat.deepseek.com's internal API directly with a captured
 * signed-in session: create session, solve PoW, POST the completion, and
 * parse the SSE fragment stream (THINK / RESPONSE / tool calls / FINISHED).
 */

import { getPowSolver, type PowChallenge } from './pow.js';
import { SseFragmentParser, type StreamPart, type StreamState } from './sse.js';
import { getSession, type Session } from './auth.js';

export const BASE = 'https://chat.deepseek.com';
export const COMPLETION_PATH = '/api/v0/chat/completion';
export const DEFAULT_MODEL_TYPE = 'default';

export interface ChatOptions {
  conversationId?: string;
  thinking?: boolean;
  search?: boolean;
  modelType?: string;
}

export interface ChatResult {
  text: string;
  thinking: string;
  toolCalls: StreamPart[];
  conversationId: string;
  finished: boolean;
  incomplete: boolean;
}

function encodeCid(sessionId: string, messageId?: number): string {
  return messageId === undefined ? sessionId : `${sessionId}:${messageId}`;
}

function decodeCid(cid?: string): { sessionId?: string; parentId?: number } {
  if (!cid) {
    return {};
  }
  const [sessionId, msg] = cid.split(':');
  const parentId = msg && /^\d+$/.test(msg) ? Number(msg) : undefined;
  return { sessionId: sessionId || undefined, parentId };
}

export class DeepSeekClient {
  private session?: Session;

  async ensureSession(): Promise<Session> {
    if (!this.session) {
      this.session = await getSession();
    }
    return this.session;
  }

  private async headers(
    extra: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    const session = await this.ensureSession();
    const cookieHeader = Object.entries(session.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    return {
      authorization: `Bearer ${session.token}`,
      accept: '*/*',
      'content-type': 'application/json',
      'user-agent':
        session.userAgent ||
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
      origin: BASE,
      referer: `${BASE}/`,
      'x-app-version': '2.0.0',
      'x-client-version': '2.0.0',
      'x-client-platform': 'web',
      'x-client-locale': 'en_US',
      'x-client-bundle-id': 'com.deepseek.chat',
      'x-client-timezone-offset': '19800',
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...extra,
    };
  }

  private biz(data: unknown): Record<string, unknown> {
    const envelope = data as Record<string, unknown>;
    if (envelope['code'] !== 0) {
      throw new Error(
        `DeepSeek API error: ${envelope['msg'] ?? JSON.stringify(envelope)}`,
      );
    }
    const bizData = (envelope['data'] as Record<string, unknown>)?.['biz_data'];
    if (!bizData) {
      throw new Error(`Unexpected response shape: ${JSON.stringify(envelope)}`);
    }
    return bizData as Record<string, unknown>;
  }

  async createChatSession(): Promise<string> {
    const response = await fetch(`${BASE}/api/v0/chat_session/create`, {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      throw new Error(`chat_session/create failed: ${response.status}`);
    }
    const biz = this.biz(await response.json());
    const chatSession = biz['chat_session'] as Record<string, unknown>;
    return String(chatSession['id']);
  }

  private async powHeader(): Promise<string> {
    const response = await fetch(`${BASE}/api/v0/chat/create_pow_challenge`, {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify({ target_path: COMPLETION_PATH }),
    });
    if (!response.ok) {
      throw new Error(`create_pow_challenge failed: ${response.status}`);
    }
    const biz = this.biz(await response.json());
    const solver = await getPowSolver();
    return solver.makeHeader(biz['challenge'] as PowChallenge);
  }

  /**
   * One completion. Yields parts as they stream and resolves with the final
   * state (text, tool calls, conversation id, finished/incomplete flags).
   */
  async *streamParts(
    prompt: string,
    options: ChatOptions = {},
    onState?: (state: StreamState) => void,
  ): AsyncGenerator<StreamPart, ChatResult, void> {
    const session = await this.ensureSession();
    void session;
    const { sessionId: existingSession, parentId } = decodeCid(
      options.conversationId,
    );
    const sessionId = existingSession ?? (await this.createChatSession());
    const modelType = existingSession
      ? undefined
      : (options.modelType ?? DEFAULT_MODEL_TYPE);

    const body: Record<string, unknown> = {
      chat_session_id: sessionId,
      parent_message_id: parentId ?? null,
      prompt,
      ref_file_ids: [],
      thinking_enabled: options.thinking ?? false,
      search_enabled: options.search ?? true,
      action: null,
      preempt: false,
    };
    if (modelType) {
      body['model_type'] = modelType;
    }

    const parser = new SseFragmentParser();
    const parts: StreamPart[] = [];
    if (process.env['DEBUG_DEEPSEEK']) {
      // Diagnostic dump of the exact request payload (Phase 3.6).
      console.error('[payload]', JSON.stringify(body));
    }
    const response = await fetch(`${BASE}${COMPLETION_PATH}`, {
      method: 'POST',
      headers: await this.headers({
        'x-ds-pow-response': await this.powHeader(),
      }),
      body: JSON.stringify(body),
    });
    if (!response.ok || !response.body) {
      throw new Error(
        `completion failed: ${response.status} ${response.statusText}`,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawBytes = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value && value.length) {
        sawBytes = true;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) {
          if (process.env['DEBUG_DEEPSEEK_SSE']) {
            // Raw SSE audit: shows exactly which fragments/status the server sent.
            console.error('[deepseek-sse]', line.slice(5, 600));
          }
          for (const part of parser.feedPayload(line.slice(5).trim())) {
            parts.push(part);
            yield part;
          }
        }
        newline = buffer.indexOf('\n');
      }
    }
    if (buffer.startsWith('data:')) {
      for (const part of parser.feedPayload(buffer.slice(5).trim())) {
        parts.push(part);
        yield part;
      }
    }
    for (const part of parser.flush()) {
      parts.push(part);
      yield part;
    }
    if (process.env['DEBUG_DEEPSEEK']) {
      // Bug 1 audit: why the reader decided the stream was over. Only
      // `response/status FINISHED` is a clean end; anything else is a server
      // stop (e.g. `INCOMPLETE` + `generation_err`).
      console.error(
        '[deepseek-stream-close] reason=%s',
        parser.state.finished
          ? 'finished'
          : parser.state.incomplete
            ? 'incomplete'
            : 'eof-without-status',
      );
    }
    void sawBytes;
    onState?.(parser.state);

    const text = parts
      .filter((p) => p.kind === 'answer')
      .map((p) => p.text)
      .join('');
    const thinking = parts
      .filter((p) => p.kind === 'thinking')
      .map((p) => p.text)
      .join('');
    return {
      text,
      thinking,
      toolCalls: parts.filter((p) => p.kind === 'tool_call'),
      conversationId: encodeCid(sessionId, parser.state.messageId),
      finished: parser.state.finished,
      incomplete: parser.state.incomplete,
    };
  }

  /** Convenience: collect a whole completion (no streaming). */
  async chat(prompt: string, options: ChatOptions = {}): Promise<ChatResult> {
    const generator = this.streamParts(prompt, options);
    let result = await generator.next();
    while (!result.done) {
      result = await generator.next();
    }
    return result.value;
  }
}

export function createDeepSeekClient(): DeepSeekClient {
  return new DeepSeekClient();
}
