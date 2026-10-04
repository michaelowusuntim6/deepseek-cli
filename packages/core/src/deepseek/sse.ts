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
// DeepSeek's markup is messy: the pipe count varies (｜DSML｜ vs ｜｜DSML｜｜),
// the prefix is sometimes missing entirely, and the model frequently writes a
// stray `/` in front of an *opening* tag. Accept all of it.
const FW = '\uFF5C';
const PIPE = `[${FW}|]`;
const DSML_NAMESPACE = `${PIPE}{1,2}DSML${PIPE}{1,2}\\s*`;
const DSML_TAG_PREFIX = `(?:\\/?${DSML_NAMESPACE})?`;
const DSML_INVOKE_OPEN_RE = new RegExp(
  `<${DSML_TAG_PREFIX}invoke\\s+name="([^"]+)">`,
  'g',
);
const DSML_INVOKE_CLOSE_RE = new RegExp(
  `</${DSML_TAG_PREFIX}invoke>`,
  'g',
);
const DSML_PARAM_OPEN_RE = new RegExp(
  `<${DSML_TAG_PREFIX}parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?>`,
  'g',
);
const DSML_PARAM_CLOSE_RE = new RegExp(
  `</${DSML_TAG_PREFIX}parameter>`,
  'g',
);
/**
 * DeepSeek sometimes encodes arguments as nested invoke blocks instead of
 * parameter elements, e.g.
 *   <invoke name="read_file"><invoke name="file_path">/x</invoke></invoke>
 * Used only as a fallback when no parameter elements were found.
 */
const DSML_NESTED_INVOKE_RE = new RegExp(
  `<${DSML_TAG_PREFIX}invoke\\s+name="([^"]+)">([\\s\\S]*?)</${DSML_TAG_PREFIX}invoke>`,
  'g',
);
/** Find the first closing tag (qualified or compact) at or after `from`. */
function findCloseTag(
  re: RegExp,
  text: string,
  from: number,
): { index: number; length: number } | null {
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? { index: m.index, length: m[0].length } : null;
}

/**
 * Any DSML marker: the wrapper open tag or an invoke open tag. Used to decide
 * where a DSML region starts regardless of how (mis)ordered the wrapper tags
 * are — the model sometimes emits duplicated/out-of-order `<calls>` tags.
 */
const DSML_MARKER_RE = new RegExp(
  `<${DSML_TAG_PREFIX}(?:calls[^>]*>|invoke\\s+name=)`,
);
/** Longest prefix we may need to buffer when a marker is split across chunks. */
const DSML_MARKER_TAIL = 32;
/**
 * Stray DSML scaffolding left in the visible stream once invokes have been
 * extracted: wrapper tags and any orphan invoke/parameter tags (including the
 * malformed `</invoke name="...">` form). None of it is prose.
 */
const DSML_SCAFFOLDING_RE = new RegExp(
  `</?(?:\\/?${DSML_NAMESPACE})?calls\\b[^>]*>` +
    `|</(?:\\/?${DSML_NAMESPACE})?(?:invoke|parameter)\\b[^>]*>`,
  'g',
);
/** `<calls>` / `</calls>` (qualified). Safe to strip before parsing. */
const DSML_CALLS_TAG_RE = new RegExp(
  `</?(?:\\/?${DSML_NAMESPACE})?calls[^>]*>`,
  'g',
);

/** Wrapper tags only — safe to strip before parsing (invokes stay intact). */
function stripDsmlWrapperTags(text: string): string {
  return text.replace(DSML_CALLS_TAG_RE, '');
}

/** All DSML scaffolding — used when emitting visible prose, not when parsing. */
function stripDsmlScaffolding(text: string): string {
  return text.replace(DSML_SCAFFOLDING_RE, '');
}

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
  // 1. Wrapper tags are noise. Strip every calls tag — zero, one or several.
  const source = stripDsmlWrapperTags(text);
  const calls: ParsedToolCall[] = [];
  let cursor = 0;
  while (true) {
    // 2. Find every named invoke opener.
    DSML_INVOKE_OPEN_RE.lastIndex = cursor;
    const invokeMatch = DSML_INVOKE_OPEN_RE.exec(source);
    if (!invokeMatch) {
      break;
    }
    const name = invokeMatch[1];
    const bodyStart = invokeMatch.index + invokeMatch[0].length;
    // 3. Match the close with a nesting counter so nested invoke blocks
    //    (malformed parameters) do not truncate the outer body.
    let depth = 0;
    let scan = bodyStart;
    let bodyEnd = -1;
    let closeLen = 0;
    while (scan < source.length) {
      const nextOpen = findCloseTag(DSML_INVOKE_OPEN_RE, source, scan);
      const nextClose = findCloseTag(DSML_INVOKE_CLOSE_RE, source, scan);
      if (!nextClose) {
        break;
      }
      if (nextOpen && nextOpen.index < nextClose.index) {
        depth += 1;
        scan = nextOpen.index + nextOpen.length;
        continue;
      }
      if (depth === 0) {
        bodyEnd = nextClose.index;
        closeLen = nextClose.length;
        break;
      }
      depth -= 1;
      scan = nextClose.index + nextClose.length;
    }
    if (bodyEnd === -1) {
      // Incomplete invoke: skip it and keep scanning (earlier calls survive).
      cursor = bodyStart;
      continue;
    }
    const invokeBody = source.slice(bodyStart, bodyEnd);
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
      const valueClose = findCloseTag(
        DSML_PARAM_CLOSE_RE,
        invokeBody,
        valueStart,
      );
      // DeepSeek sometimes drops a parameter's opening tag. In that case the
      // naive scan runs past the missing close tag and swallows the next
      // parameter's markup into this value (observed live:
      // end_line = '80</…parameter name="path" …>'). Stop at whichever comes
      // first: this parameter's close tag, or the NEXT parameter's open tag.
      DSML_PARAM_OPEN_RE.lastIndex = valueStart;
      const nextOpen = DSML_PARAM_OPEN_RE.exec(invokeBody);
      const valueEnd =
        nextOpen && (!valueClose || nextOpen.index < valueClose.index)
          ? nextOpen.index
          : valueClose
            ? valueClose.index
            : -1;
      if (valueEnd === -1) {
        break; // incomplete parameter: stop
      }
      const closeLength = valueClose ? valueClose.length : 0;
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
      paramCursor = valueEnd + closeLength;
    }
    if (Object.keys(args).length === 0) {
      // Fallback shape: nested invoke blocks used as parameters.
      for (const nested of invokeBody.matchAll(DSML_NESTED_INVOKE_RE)) {
        const key = nested[1];
        const value = nested[2].trim();
        if (key && !(key in args)) {
          args[key] = value;
        }
      }
    }
    calls.push({
      name,
      arguments: args,
      raw: JSON.stringify({ name, arguments: args }),
    });
    cursor = bodyEnd + closeLen;
  }
  return calls;
}

/**
 * True when the text looks like a (possibly malformed) DSML tool-call attempt.
 * Used to decide whether a response with no valid calls should be retried.
 */
export function looksLikeBrokenToolCall(text: string): boolean {
  return (
    text.includes(FW) ||
    new RegExp(
      `<\\/?\\s*(?:\\/?${DSML_NAMESPACE})?(?:invoke|parameter|calls)\\b`,
    ).test(text) ||
    text.includes('</parameter>')
  );
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

      const tagIdx = combined.indexOf(OPEN_TAG, pos);
      const dsmlIdx = combined.slice(pos).search(DSML_MARKER_RE);
      const dsmlAbsIdx = dsmlIdx === -1 ? -1 : pos + dsmlIdx;
      if (tagIdx === -1 && dsmlIdx === -1) {
        const keep = Math.max(OPEN_TAG.length, DSML_MARKER_TAIL, 32);
        const safeLen = combined.length - pos;
        if (safeLen > keep) {
          const emitLen = safeLen - keep;
          // Drop stray/misordered DSML wrapper tags so the model's malformed
          // `<calls>` noise never shows up as visible answer text.
          const emitText = stripDsmlScaffolding(
            combined.slice(pos, pos + emitLen),
          );
          if (emitText) {
            out.push({ kind: 'answer', text: emitText });
          }
          pos += emitLen;
        }
        this.answerBuffer = combined.slice(pos);
        break;
      }

      if (tagIdx !== -1 && (dsmlAbsIdx === -1 || tagIdx < dsmlAbsIdx)) {
        if (tagIdx > pos) {
          out.push({ kind: 'answer', text: combined.slice(pos, tagIdx) });
        }
        this.inToolCall = true;
        pos = tagIdx + OPEN_TAG.length;
        continue;
      }

      // DSML region: extract every complete invoke, ignoring stray/misordered
      // <calls> wrapper tags, and buffer any trailing incomplete invoke.
      const { parts, rest, sawCall } = this.scanDsmlBuffer(
        combined.slice(pos),
        'answer',
      );
      out.push(...parts);
      if (sawCall) {
        this.stripFinished = true;
      }
      this.answerBuffer = rest;
      pos = combined.length;
      break;
    }

    combined = '';
    return out;
  }

  /**
   * Walk a buffer looking for DSML invokes. Each `<invoke name="X">` is matched
   * with its own `</invoke>`; everything else (including duplicated or
   * out-of-order `<calls>` wrappers) is ignored. Returns the parts to emit and
   * the unconsumed tail (a partially received invoke) for the caller to buffer.
   */
  private scanDsmlBuffer(
    buffer: string,
    textKind: 'answer' | 'thinking',
  ): { parts: StreamPart[]; rest: string; sawCall: boolean } {
    const parts: StreamPart[] = [];
    let cursor = 0;
    let sawCall = false;
    for (;;) {
      const relIdx = buffer.slice(cursor).search(DSML_MARKER_RE);
      if (relIdx === -1) {
        break;
      }
      const markerIdx = cursor + relIdx;
      const before = stripDsmlScaffolding(buffer.slice(cursor, markerIdx));
      if (before) {
        parts.push({ kind: textKind, text: before });
      }

      DSML_INVOKE_OPEN_RE.lastIndex = markerIdx;
      const invoke = DSML_INVOKE_OPEN_RE.exec(buffer);
      if (!invoke) {
        // A wrapper tag with no invoke yet: keep buffering from the marker.
        return { parts, rest: buffer.slice(markerIdx), sawCall };
      }
      const bodyClose = findCloseTag(
        DSML_INVOKE_CLOSE_RE,
        buffer,
        invoke.index + invoke[0].length,
      );
      if (!bodyClose) {
        // Incomplete invoke: buffer from its open tag.
        return { parts, rest: buffer.slice(invoke.index), sawCall };
      }
      const region = buffer.slice(
        invoke.index,
        bodyClose.index + bodyClose.length,
      );
      const calls = dsmlCallsFromRegion(region, true);
      if (calls.length > 0) {
        sawCall = true;
        for (const call of calls) {
          parts.push({ kind: 'tool_call', text: call.raw });
        }
      }
      cursor = bodyClose.index + bodyClose.length;
    }

    const tail = stripDsmlScaffolding(buffer.slice(cursor));
    if (tail.length > DSML_MARKER_TAIL) {
      parts.push({
        kind: textKind,
        text: tail.slice(0, tail.length - DSML_MARKER_TAIL),
      });
      return { parts, rest: tail.slice(tail.length - DSML_MARKER_TAIL), sawCall };
    }
    return { parts, rest: tail, sawCall };
  }

  /**
   * Handle non-answer text (THINK fragments). Tool calls can be emitted inside
   * the reasoning phase; extract them instead of rendering the DSML as text.
   */
  private processThinkingChunk(text: string): StreamPart[] {
    this.thinkingBuffer += text;
    const { parts, rest, sawCall } = this.scanDsmlBuffer(
      this.thinkingBuffer,
      'thinking',
    );
    this.thinkingBuffer = rest;
    if (sawCall) {
      this.stripFinished = true;
    }
    return parts;
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
    if (this.answerBuffer) {
      const raw = this.stripFinished
        ? this.answerBuffer.replace(/^\s*FINISHED/, '')
        : this.answerBuffer;
      const text = stripDsmlScaffolding(raw);
      if (text) {
        out.push({ kind: 'answer', text });
      }
      this.answerBuffer = '';
    }
    if (this.thinkingBuffer) {
      const remaining = this.thinkingBuffer;
      this.thinkingBuffer = '';
      // A trailing partial invoke cannot be executed; anything else is real
      // thinking text, so keep it.
      DSML_INVOKE_OPEN_RE.lastIndex = 0;
      if (!DSML_INVOKE_OPEN_RE.test(remaining)) {
        const text = stripDsmlScaffolding(remaining);
        if (text) {
          out.push({ kind: 'thinking', text });
        }
      }
    }
    return out;
  }
}
