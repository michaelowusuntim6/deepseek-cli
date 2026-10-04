/**
 * @license
 * DeepSeek SSE fragment parser — port of the fragment logic in
 * DeepSeek-API/deepseek/client.py (_parse_sse, _dsml_calls_to_json,
 * _extract_tool_call_json).
 *
 * DeepSeek streams THINK fragments, RESPONSE fragments and a FINISHED (or
 * INCOMPLETE) status. Tool calls arrive either as <tool_call>{json}</tool_call>
 * blocks or as DSML invoke blocks whose tag name uses the fullwidth pipe
 * U+FF5C ("｜｜DSML｜｜").
 */

export type PartKind = 'thinking' | 'answer' | 'tool_call';

export interface StreamPart {
  kind: PartKind;
  text: string;
}

export interface StreamState {
  messageId?: number;
  finished: boolean;
  incomplete: boolean;
}

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  raw: string;
}

const THINKING_TYPES = new Set([
  'THINK',
  'REASONING',
  'THINKING',
  'COT',
  'CHAIN_OF_THOUGHT',
]);
const RESPONSE_TYPES = new Set([
  'RESPONSE',
  'ANSWER',
  'TEXT',
  'CONTENT',
  'FINAL',
  'OUTPUT',
]);

const FRAG_INDEX_RE = /fragments\/(-?\d+)(?:\/|$)/;
const OPEN_TAG = '<tool_call>';
const CLOSE_TAG = '</tool_call>';
const BAR = '\uFF5C\uFF5C';
const DSML_CALLS_OPEN = `<${BAR}DSML${BAR} calls>`;
const DSML_CALLS_CLOSE = `</${BAR}DSML${BAR} calls>`;
const DSML_INVOKE_OPEN_RE = new RegExp(
  `<${BAR}DSML${BAR} invoke\\s+name="([^"]+)">`,
  'g',
);
const DSML_INVOKE_CLOSE = `</${BAR}DSML${BAR} invoke>`;
const DSML_PARAM_OPEN_RE = new RegExp(
  `<${BAR}DSML${BAR} parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?>`,
  'g',
);
const DSML_PARAM_CLOSE = `</${BAR}DSML${BAR} parameter>`;

/**
 * Extract DSML invoke blocks from the body of a `<calls>` block.
 *
 * A parameter value is EXACTLY the raw substring between its opening
 * `<parameter ...>` tag and the matching `</parameter>` tag — `<`, `>`, `&`,
 * `|`, newlines and quotes inside the value are preserved verbatim. We never
 * split on `<`, which is what previously dropped shell commands containing
 * `<<` heredocs, `<filename>` redirections or `1<2` comparisons.
 *
 * If a closing tag is missing (the stream was cut mid-block) the extractor
 * stops at that point instead of inventing a close.
 */
export function dsmlCallsToJson(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  let cursor = 0;
  while (true) {
    DSML_INVOKE_OPEN_RE.lastIndex = cursor;
    const invokeMatch = DSML_INVOKE_OPEN_RE.exec(text);
    if (!invokeMatch) {
      break;
    }
    const name = invokeMatch[1];
    const bodyStart = invokeMatch.index + invokeMatch[0].length;
    const bodyEnd = text.indexOf(DSML_INVOKE_CLOSE, bodyStart);
    if (bodyEnd === -1) {
      break; // incomplete invoke: stop, do not invent a close
    }
    const invokeBody = text.slice(bodyStart, bodyEnd);
    const args: Record<string, unknown> = {};
    let paramCursor = 0;
    while (true) {
      DSML_PARAM_OPEN_RE.lastIndex = paramCursor;
      const paramMatch = DSML_PARAM_OPEN_RE.exec(invokeBody);
      if (!paramMatch) {
        break;
      }
      const paramName = paramMatch[1];
      const isString = paramMatch[2] === 'true';
      const valueStart = paramMatch.index + paramMatch[0].length;
      const valueEnd = invokeBody.indexOf(DSML_PARAM_CLOSE, valueStart);
      if (valueEnd === -1) {
        break; // incomplete parameter: stop
      }
      // CRITICAL: raw substring between the boundaries. No `<` scanning.
      const raw = invokeBody.slice(valueStart, valueEnd);
      if (isString) {
        args[paramName] = raw;
      } else {
        try {
          args[paramName] = JSON.parse(raw);
        } catch {
          args[paramName] = raw;
        }
      }
      paramCursor = valueEnd + DSML_PARAM_CLOSE.length;
    }
    calls.push({
      name,
      arguments: args,
      raw: JSON.stringify({ name, arguments: args }),
    });
    cursor = bodyEnd + DSML_INVOKE_CLOSE.length;
  }
  return calls;
}

/**
 * Extract tool calls from a full `<calls>…</calls>` region (or from a body
 * whose closing `</calls>` never arrived — some fragments cut off mid-stream).
 */
export function dsmlCallsFromRegion(
  region: string,
  debug = false,
): ParsedToolCall[] {
  const openIdx = region.indexOf(DSML_CALLS_OPEN);
  let body: string;
  if (openIdx === -1) {
    body = region;
  } else {
    const start = openIdx + DSML_CALLS_OPEN.length;
    const end = region.indexOf(DSML_CALLS_CLOSE, start);
    body = end === -1 ? region.slice(start) : region.slice(start, end);
  }
  const calls = dsmlCallsToJson(body);
  if (debug && process.env['DEEPSEEK_DSML_DEBUG']) {
    console.error(
      '[dsml] blocks_found=%d blocks_parsed=%d last_buffer_tail=%s',
      (body.match(new RegExp(`<${BAR}DSML${BAR} invoke`, 'g')) ?? []).length,
      calls.length,
      JSON.stringify(body.slice(-80)),
    );
    calls.forEach((call, i) => {
      console.error(
        '[dsml-block] index=%d name=%s arg_chars=%d',
        i,
        call.name,
        JSON.stringify(call.arguments).length,
      );
    });
  }
  return calls;
}

export function extractToolCallJson(text: string): ParsedToolCall | null {
  const start = text.indexOf('{');
  if (start < 0) {
    return null;
  }
  const candidate = text.slice(start);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) {
    return null;
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(candidate.slice(0, end));
  } catch {
    return null;
  }
  if (
    typeof obj !== 'object' ||
    obj === null ||
    typeof obj['name'] !== 'string'
  ) {
    return null;
  }
  let args = obj['arguments'] ?? {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (typeof args !== 'object' || args === null) {
    return null;
  }
  const inner = (args as Record<string, unknown>)['arguments'];
  if (typeof inner === 'object' && inner !== null && !Array.isArray(inner)) {
    const keys = Object.keys(args as Record<string, unknown>);
    if (keys.every((k) => k === 'name' || k === 'arguments')) {
      const innerName = (args as Record<string, unknown>)['name'];
      if (typeof innerName === 'string') {
        obj['name'] = innerName;
      }
      args = inner;
    }
  }
  return {
    name: String(obj['name']),
    arguments: args as Record<string, unknown>,
    raw: JSON.stringify(obj),
  };
}

function fragmentKind(frag: Record<string, unknown>): PartKind | undefined {
  const t = String(frag['type'] ?? '').toUpperCase();
  if (THINKING_TYPES.has(t)) {
    return 'thinking';
  }
  if (RESPONSE_TYPES.has(t)) {
    return 'answer';
  }
  return undefined;
}

/**
 * Parse one SSE `data:` payload line into zero or more parts plus status
 * updates. Mirrors the Python parser's fragment bookkeeping.
 */
export class SseFragmentParser {
  readonly state: StreamState = { finished: false, incomplete: false };
  private readonly fragmentKinds = new Map<number, PartKind>();
  private readonly lastSeen = new Map<number, string>();
  private answerBuffer = '';
  /**
   * Buffer for THINK fragments. DeepSeek frequently emits a tool call from
   * inside the thinking phase (no RESPONSE fragment is registered first), so
   * the thinking stream must be scanned for DSML too — otherwise the call is
   * rendered as visible reasoning text and never dispatched.
   */
  private thinkingBuffer = '';
  private inToolCall = false;
  private toolCallBuffer = '';
  private inDsml = false;
  private dsmlBuffer = '';
  private stripFinished = false;

  private highest(): number {
    let max = 0;
    for (const key of this.fragmentKinds.keys()) {
      if (key > max) {
        max = key;
      }
    }
    return max;
  }

  private register(idx: number, kind?: PartKind): void {
    if (kind) {
      this.fragmentKinds.set(idx, kind);
      return;
    }
    if (this.fragmentKinds.has(idx)) {
      return;
    }
    if (idx === 0) {
      this.fragmentKinds.set(idx, 'thinking');
    } else if (this.fragmentKinds.has(idx - 1)) {
      const prev = this.fragmentKinds.get(idx - 1);
      this.fragmentKinds.set(idx, prev === 'thinking' ? 'answer' : 'thinking');
    } else {
      this.fragmentKinds.set(idx, 'answer');
    }
  }

  private absorbFull(idx: number, full: string): string | null {
    const prev = this.lastSeen.get(idx) ?? '';
    if (!full || full === prev) {
      return null;
    }
    const delta =
      prev && full.startsWith(prev) ? full.slice(prev.length) : full;
    this.lastSeen.set(idx, full);
    return delta;
  }

  private processAnswerChunk(text: string): StreamPart[] {
    const out: StreamPart[] = [];
    let combined = this.answerBuffer + text;
    this.answerBuffer = '';
    let pos = 0;

    while (pos < combined.length) {
      if (this.stripFinished) {
        const probe = combined.slice(pos).replace(/^\s+/, '');
        if (probe.startsWith('FINISHED')) {
          pos = combined.length - probe.length + 'FINISHED'.length;
          this.stripFinished = false;
          continue;
        }
      }

      if (this.inToolCall) {
        const closeIdx = combined.indexOf(CLOSE_TAG, pos);
        if (closeIdx !== -1) {
          this.toolCallBuffer += combined.slice(pos, closeIdx);
          const payload = this.toolCallBuffer.trim();
          this.toolCallBuffer = '';
          this.inToolCall = false;
          pos = closeIdx + CLOSE_TAG.length;
          out.push({ kind: 'tool_call', text: payload });
        } else {
          this.toolCallBuffer += combined.slice(pos);
          break;
        }
        continue;
      }

      if (this.inDsml) {
        const closeIdx = combined.indexOf(DSML_CALLS_CLOSE, pos);
        if (closeIdx !== -1) {
          this.dsmlBuffer += combined.slice(pos, closeIdx);
          for (const call of dsmlCallsFromRegion(
            `${DSML_CALLS_OPEN}${this.dsmlBuffer}${DSML_CALLS_CLOSE}`,
            true,
          )) {
            out.push({ kind: 'tool_call', text: call.raw });
          }
          this.dsmlBuffer = '';
          this.inDsml = false;
          this.stripFinished = true;
          pos = closeIdx + DSML_CALLS_CLOSE.length;
        } else {
          this.dsmlBuffer += combined.slice(pos);
          break;
        }
        continue;
      }

      const tagIdx = combined.indexOf(OPEN_TAG, pos);
      const dsmlIdx = combined.indexOf(DSML_CALLS_OPEN, pos);
      if (tagIdx === -1 && dsmlIdx === -1) {
        const keep = Math.max(OPEN_TAG.length, DSML_CALLS_OPEN.length, 32);
        const safeLen = combined.length - pos;
        if (safeLen > keep) {
          const emitLen = safeLen - keep;
          out.push({
            kind: 'answer',
            text: combined.slice(pos, pos + emitLen),
          });
          pos += emitLen;
        }
        this.answerBuffer = combined.slice(pos);
        break;
      }

      if (tagIdx !== -1 && (dsmlIdx === -1 || tagIdx < dsmlIdx)) {
        if (tagIdx > pos) {
          out.push({ kind: 'answer', text: combined.slice(pos, tagIdx) });
        }
        this.inToolCall = true;
        pos = tagIdx + OPEN_TAG.length;
        continue;
      }

      if (dsmlIdx > pos) {
        out.push({ kind: 'answer', text: combined.slice(pos, dsmlIdx) });
      }
      this.inDsml = true;
      pos = dsmlIdx + DSML_CALLS_OPEN.length;
    }

    combined = '';
    return out;
  }

  /**
   * Handle non-answer text (THINK fragments). Tool calls can be emitted inside
   * the reasoning phase; extract them instead of rendering the DSML as text.
   */
  private processThinkingChunk(text: string): StreamPart[] {
    const out: StreamPart[] = [];
    this.thinkingBuffer += text;
    for (;;) {
      const openIdx = this.thinkingBuffer.indexOf(DSML_CALLS_OPEN);
      if (openIdx === -1) {
        // No DSML in the buffer: emit everything but a small tail so a tag
        // split across fragments is still recognised next time.
        const keep = DSML_CALLS_OPEN.length + 8;
        if (this.thinkingBuffer.length > keep) {
          out.push({
            kind: 'thinking',
            text: this.thinkingBuffer.slice(0, this.thinkingBuffer.length - keep),
          });
          this.thinkingBuffer = this.thinkingBuffer.slice(
            this.thinkingBuffer.length - keep,
          );
        }
        return out;
      }
      if (openIdx > 0) {
        out.push({
          kind: 'thinking',
          text: this.thinkingBuffer.slice(0, openIdx),
        });
      }
      const closeIdx = this.thinkingBuffer.indexOf(
        DSML_CALLS_CLOSE,
        openIdx + DSML_CALLS_OPEN.length,
      );
      if (closeIdx === -1) {
        // Incomplete block: keep buffering from the open tag.
        this.thinkingBuffer = this.thinkingBuffer.slice(openIdx);
        return out;
      }
      const region = this.thinkingBuffer.slice(
        openIdx,
        closeIdx + DSML_CALLS_CLOSE.length,
      );
      for (const call of dsmlCallsFromRegion(region, true)) {
        out.push({ kind: 'tool_call', text: call.raw });
      }
      this.thinkingBuffer = this.thinkingBuffer.slice(
        closeIdx + DSML_CALLS_CLOSE.length,
      );
    }
  }

  /** Feed one raw SSE line (the text after `data: `). */
  feedPayload(payload: string): StreamPart[] {
    if (!payload || payload === '[DONE]') {
      return [];
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(payload);
    } catch {
      return [];
    }
    const out: StreamPart[] = [];
    const v = obj['v'];
    const p = String(obj['p'] ?? '');
    const o = String(obj['o'] ?? '');

    // 0. BATCH envelopes.
    if (
      o === 'BATCH' &&
      Array.isArray(v) &&
      v.every(
        (item) => typeof item === 'object' && item !== null && 'p' in item,
      )
    ) {
      for (const op of v as Array<Record<string, unknown>>) {
        const opP = String(op['p'] ?? '');
        const opV = op['v'];
        if (opP.endsWith('fragments') && Array.isArray(opV)) {
          for (const item of opV as Array<Record<string, unknown>>) {
            const idx = this.fragmentKinds.size ? this.highest() + 1 : 0;
            this.register(idx, fragmentKind(item));
            const content = String(item['content'] ?? '');
            if (content) {
              this.lastSeen.set(idx, content);
              const kind = this.fragmentKinds.get(idx)!;
              if (kind === 'answer') {
                out.push(...this.processAnswerChunk(content));
              } else {
                out.push(...this.processThinkingChunk(content));
              }
            }
          }
        } else if (opP.endsWith('content') && typeof opV === 'string') {
          const idx = this.highest();
          if (!this.fragmentKinds.has(idx)) {
            this.register(idx, undefined);
          }
          const kind = this.fragmentKinds.get(idx)!;
          if (kind === 'answer') {
            out.push(...this.processAnswerChunk(opV));
          } else {
            out.push(...this.processThinkingChunk(opV));
          }
        } else if (opP.endsWith('quasi_status') && opV === 'FINISHED') {
          // Deliberately ignored: only response/status FINISHED is the marker.
        } else if (opP.endsWith('quasi_status') && opV === 'INCOMPLETE') {
          this.state.incomplete = true;
        }
      }
      return out;
    }

    // 1. Snapshot with a full response object.
    if (typeof v === 'object' && v !== null && 'response' in (v as object)) {
      const response = (v as Record<string, unknown>)['response'] as Record<
        string,
        unknown
      >;
      const mid = response['message_id'] ?? response['id'];
      if (typeof mid === 'number') {
        this.state.messageId = mid;
      }
      const frags =
        (response['fragments'] as Array<Record<string, unknown>>) ?? [];
      frags.forEach((frag, i) => {
        this.register(i, fragmentKind(frag));
        const delta = this.absorbFull(i, String(frag['content'] ?? ''));
        if (delta) {
          const kind = this.fragmentKinds.get(i) ?? 'answer';
          if (kind === 'answer') {
            out.push(...this.processAnswerChunk(delta));
          } else {
            out.push(...this.processThinkingChunk(delta));
          }
        }
      });
      return out;
    }

    // 2. Fragment registration / update.
    let frapsToRegister: Array<Record<string, unknown>> = [];
    if (Array.isArray(v) && p.endsWith('fragments')) {
      frapsToRegister = v.filter(
        (item) => typeof item === 'object' && item !== null,
      ) as Array<Record<string, unknown>>;
    } else if (
      typeof v === 'object' &&
      v !== null &&
      ('type' in (v as object) || 'content' in (v as object))
    ) {
      frapsToRegister = [v as Record<string, unknown>];
    }
    if (frapsToRegister.length) {
      const m = FRAG_INDEX_RE.exec(p);
      for (const item of frapsToRegister) {
        let idx: number;
        if (m && !(Array.isArray(v) && p.endsWith('fragments'))) {
          const raw = Number(m[1]);
          idx = raw < 0 ? this.highest() + 1 : raw;
        } else {
          idx =
            this.fragmentKinds.size && this.fragmentKinds.has(0)
              ? this.highest() + 1
              : 0;
        }
        this.register(idx, fragmentKind(item));
        const content = String(item['content'] ?? '');
        if (content) {
          this.lastSeen.set(idx, content);
          const kind = this.fragmentKinds.get(idx)!;
          if (kind === 'answer') {
            out.push(...this.processAnswerChunk(content));
          } else {
            out.push(...this.processThinkingChunk(content));
          }
        }
      }
      return out;
    }

    // 3. message_id capture.
    if (p.endsWith('message_id') && typeof v === 'number') {
      this.state.messageId = v;
      return out;
    }

    // 3b. end-of-response / incomplete markers.
    if (p === 'response/status' && v === 'FINISHED') {
      this.state.finished = true;
      return out;
    }
    if (p === 'response/status' && v === 'INCOMPLETE') {
      this.state.incomplete = true;
      return out;
    }

    // 4. Content delta.
    if (typeof v === 'string') {
      let idx: number;
      if (p) {
        if (!p.endsWith('content')) {
          return out;
        }
        const m = FRAG_INDEX_RE.exec(p);
        idx = m
          ? Number(m[1]) < 0
            ? this.highest()
            : Number(m[1])
          : this.highest();
      } else {
        idx = this.highest();
      }
      if (!this.fragmentKinds.has(idx)) {
        this.register(idx, undefined);
      }
      this.lastSeen.set(idx, (this.lastSeen.get(idx) ?? '') + v);
      const kind = this.fragmentKinds.get(idx)!;
      if (kind === 'answer') {
        out.push(...this.processAnswerChunk(v));
      } else {
        out.push(...this.processThinkingChunk(v));
      }
    }
    return out;
  }

  /** Flush buffered text once the stream is over. */
  flush(): StreamPart[] {
    const out = this.processAnswerChunk('');
    if (this.inToolCall && this.toolCallBuffer) {
      const closeIdx = this.toolCallBuffer.indexOf(CLOSE_TAG);
      if (closeIdx !== -1) {
        out.push({
          kind: 'tool_call',
          text: this.toolCallBuffer.slice(0, closeIdx).trim(),
        });
        const after = this.toolCallBuffer.slice(closeIdx + CLOSE_TAG.length);
        if (after) {
          out.push({ kind: 'answer', text: after });
        }
      }
    }
    if (this.inDsml && this.dsmlBuffer) {
      const closeIdx = this.dsmlBuffer.indexOf(DSML_CALLS_CLOSE);
      const body =
        closeIdx === -1 ? this.dsmlBuffer : this.dsmlBuffer.slice(0, closeIdx);
      // Parse whatever complete <invoke> blocks are present even when the
      // outer </calls> never arrived (the stream was cut mid-block).
      for (const call of dsmlCallsFromRegion(
        `${DSML_CALLS_OPEN}${body}`,
        true,
      )) {
        out.push({ kind: 'tool_call', text: call.raw });
      }
      if (closeIdx !== -1) {
        const after = this.dsmlBuffer.slice(closeIdx + DSML_CALLS_CLOSE.length);
        if (after) {
          out.push({ kind: 'answer', text: after.replace(/^\s*FINISHED/, '') });
        }
      }
      this.dsmlBuffer = '';
      this.inDsml = false;
    }
    if (this.answerBuffer) {
      const text = this.stripFinished
        ? this.answerBuffer.replace(/^\s*FINISHED/, '')
        : this.answerBuffer;
      if (text) {
        out.push({ kind: 'answer', text });
      }
      this.answerBuffer = '';
    }
    if (this.thinkingBuffer) {
      // Drain any buffered thinking text; a complete DSML block that never got
      // its closing </calls> is still parsed by dsmlCallsFromRegion.
      const remaining = this.thinkingBuffer;
      this.thinkingBuffer = '';
      if (remaining.includes(DSML_CALLS_OPEN)) {
        for (const call of dsmlCallsFromRegion(remaining, true)) {
          out.push({ kind: 'tool_call', text: call.raw });
        }
      } else {
        out.push({ kind: 'thinking', text: remaining });
      }
    }
    return out;
  }
}
