/**
 * @license
 * ContentGenerator backed by DeepSeek's web chat (chat.deepseek.com).
 *
 * This is the only translation layer between the harness and the DeepSeek
 * client: Gemini's GenerateContentParameters go in, DeepSeek's SSE fragment
 * stream comes out, and DeepSeek's native tool-call markup (DSML invoke
 * blocks or <tool_call>{json}</tool_call>) is converted into the
 * functionCall parts the Scheduler already consumes.
 */

import type { ContentGenerator } from './contentGenerator.js';
import type { AuthType } from './contentGenerator.js';
import type {
  GenerateContentParameters,
  GenerateContentResponse,
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
} from '@google/genai';
import type { Config } from '../config/config.js';
import * as fs from 'node:fs';
import type { UserTierId, GeminiUserTier } from '../code_assist/types.js';
import { LlmRole } from '../telemetry/llmRole.js';
import { DeepSeekClient } from '../deepseek/client.js';
import { looksLikeBrokenToolCall, type StreamPart } from '../deepseek/sse.js';
import { deepseekSettingsFiles } from './generatorParts.js';

export const DEEPSEEK_THINKING_MODES = ['off', 'on'] as const;
export type DeepSeekThinkingMode = (typeof DEEPSEEK_THINKING_MODES)[number];

/**
 * DeepSeek CLI: maximum characters the model may produce within one user turn
 * (responses + tool results). Beyond this the server tends to end the stream
 * INCOMPLETE and the turn is lost, so we stop cleanly instead.
 */
export const TURN_OUTPUT_CHAR_BUDGET = 40_000;

interface Part {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args: Record<string, unknown> };
}

interface Candidate {
  content: { role: string; parts: Part[] };
  finishReason?: string;
  index?: number;
}

function makeResponse(
  parts: Part[],
  finishReason?: string,
): GenerateContentResponse {
  const candidate: Candidate = {
    content: { role: 'model', parts },
    index: 0,
  };
  if (finishReason) {
    candidate.finishReason = finishReason;
  }
  const response = {
    candidates: [candidate],
  } as unknown as GenerateContentResponse;
  // turn.ts reads `resp.functionCalls` directly; the real class exposes it as a
  // getter over the parts, so mirror that on the plain object.
  Object.defineProperty(response, 'functionCalls', {
    value: parts
      .filter((part) => part.functionCall)
      .map((part) => part.functionCall),
    enumerable: true,
  });
  return response;
}

function toolDeclarations(request: GenerateContentParameters): string {
  const tools = request.config?.tools ?? [];
  const lines: string[] = [];
  for (const tool of tools) {
    const declarations =
      (tool as { functionDeclarations?: Array<Record<string, unknown>> })
        .functionDeclarations ?? [];
    for (const declaration of declarations) {
      const name = String(declaration['name'] ?? '');
      const description = String(declaration['description'] ?? '');
      const params = declaration['parameters'] ?? {};
      lines.push(
        `- ${name}: ${description}\n  arguments schema: ${JSON.stringify(params)}`,
      );
    }
  }
  return lines.join('\n');
}

function flattenContents(request: GenerateContentParameters): string {
  const chunks: string[] = [];
  const contents = (request.contents ?? []) as Array<{
    role?: string;
    parts?: Array<Record<string, unknown>>;
  }>;
  for (const content of contents) {
    const role = content.role ?? 'user';
    const texts: string[] = [];
    for (const part of content.parts ?? []) {
      const anyPart = part as {
        text?: string;
        functionCall?: { name: string; args?: Record<string, unknown> };
        functionResponse?: { name: string; response?: Record<string, unknown> };
      };
      if (typeof anyPart.text === 'string' && anyPart.text) {
        texts.push(anyPart.text);
      } else if (anyPart.functionCall) {
        // Echo previous calls back in DSML: the model must only ever see the
        // format we want it to emit.
        const B = '\uFF5C\uFF5C';
        const params = Object.entries(anyPart.functionCall.args ?? {})
          .map(
            ([key, value]) =>
              `<${B}DSML${B} parameter name="${key}" string="true">${
                typeof value === 'string' ? value : JSON.stringify(value)
              }</${B}DSML${B} parameter>`,
          )
          .join('\n');
        texts.push(
          `<${B}DSML${B} calls>\n<${B}DSML${B} invoke name="${anyPart.functionCall.name}">\n` +
            `${params}\n</${B}DSML${B} invoke>\n</${B}DSML${B} calls>`,
        );
      } else if (anyPart.functionResponse) {
        texts.push(
          `TOOL RESULT for ${anyPart.functionResponse.name}:\n` +
            JSON.stringify(anyPart.functionResponse.response ?? {}),
        );
      }
    }
    if (texts.length) {
      chunks.push(`${role}: ${texts.join('\n')}`);
    }
  }
  return chunks.join('\n\n');
}

/** The newest user text in a request (used for follow-up turns). */
function latestUserText(request: GenerateContentParameters): string {
  const contents = (request.contents ?? []) as Array<{
    role?: string;
    parts?: Array<Record<string, unknown>>;
  }>;
  for (let i = contents.length - 1; i >= 0; i--) {
    const content = contents[i];
    if (content.role && content.role !== 'user') {
      continue;
    }
    const texts: string[] = [];
    for (const part of content.parts ?? []) {
      const anyPart = part as {
        text?: string;
        functionResponse?: { name: string; response?: Record<string, unknown> };
      };
      if (typeof anyPart.text === 'string' && anyPart.text) {
        texts.push(anyPart.text);
      } else if (anyPart.functionResponse) {
        texts.push(
          `TOOL RESULT for ${anyPart.functionResponse.name}:\n` +
            JSON.stringify(anyPart.functionResponse.response ?? {}),
        );
      }
    }
    if (texts.length) {
      return texts.join('\n');
    }
  }
  return '';
}

export interface DeepSeekContentGeneratorOptions {
  thinking?: boolean | undefined;
  search?: boolean | undefined;
  modelType?: string;
}

/**
 * deepseek.thinking / deepseek.webSearch from project + user settings.json,
 * read per request so /thinking and /search take effect immediately. Env vars
 * DEBUG-free overrides: DEEPSEEK_THINKING, DEEPSEEK_WEB_SEARCH ("1"/"0").
 */
export function readDeepSeekSettings(): {
  thinking: boolean;
  webSearch: boolean;
} {
  const merged: Record<string, unknown> = {};
  for (const file of deepseekSettingsFiles()) {
    try {
      Object.assign(merged, JSON.parse(fs.readFileSync(file, 'utf-8')));
    } catch {
      // missing/invalid settings file: keep defaults
    }
  }
  const section = (merged['deepseek'] ?? {}) as Record<string, unknown>;
  const result = {
    thinking: section['thinking'] === true,
    webSearch: section['webSearch'] !== false, // default true
  };
  if (process.env['DEEPSEEK_THINKING']) {
    result.thinking = process.env['DEEPSEEK_THINKING'] === '1';
  }
  if (process.env['DEEPSEEK_WEB_SEARCH']) {
    result.webSearch = process.env['DEEPSEEK_WEB_SEARCH'] === '1';
  }
  return result;
}

export class DeepSeekContentGenerator implements ContentGenerator {
  userTier?: UserTierId;
  userTierName?: string;
  paidTier?: GeminiUserTier;

  private readonly client = new DeepSeekClient();
  private conversationId?: string;
  private utilityConversationId?: string;
  private requestCount = 0;
  /** DeepSeek CLI: characters produced in the current user turn. */
  private turnOutputChars = 0;

  constructor(
    private readonly config: Config,
    private readonly options: DeepSeekContentGeneratorOptions = {},
  ) {}

  /** Model name from the harness config (kept for logging/diagnostics). */
  get modelName(): string {
    return this.config.getModel?.() ?? 'deepseek';
  }

  private buildPrompt(request: GenerateContentParameters): string {
    const sections: string[] = [];
    const systemInstruction = request.config?.systemInstruction;
    // Fix 1: DeepSeek keeps the conversation server-side, so the system
    // instruction and tool list go only on the FIRST request of a thread.
    // Re-sending them made the web chat show the same preamble as a new user
    // message on every turn.
    if (systemInstruction && !this.conversationId) {
      sections.push(this.textOf(systemInstruction));
    }
    const tools = toolDeclarations(request);
    if (tools && !this.conversationId) {
      const BAR = '\uFF5C\uFF5C';
      sections.push(
        'Available tools:\n' +
          tools +
          '\n\n## Tool calls\n\n' +
          'Emit tool calls in DSML. Format:\n\n' +
          `<${BAR}DSML${BAR} calls>\n` +
          `<${BAR}DSML${BAR} invoke name="tool_name">\n` +
          `<${BAR}DSML${BAR} parameter name="arg_name" string="true">value</${BAR}DSML${BAR} parameter>\n` +
          `</${BAR}DSML${BAR} invoke>\n` +
          `</${BAR}DSML${BAR} calls>\n\n` +
          'Rules:\n' +
          '  - Always wrap the batch in ONE calls block.\n' +
          '  - Each tool is one invoke element.\n' +
          '  - Each argument is one parameter element.\n' +
          '  - Do NOT nest invoke inside invoke. Parameters are parameter elements, not invoke.\n' +
          '  - Do NOT invent tool names. Only use the names listed above.\n' +
          '  - Do NOT mix JSON and DSML. Pick DSML and stay with it.\n' +
          '  - If you have nothing to call, respond with text only. Do not emit empty DSML blocks.',
      );
    }
    if (this.conversationId) {
      // Follow-up turn: send only the newest user text (the thread already has
      // the system instruction, the tools and the previous turns).
      sections.push(latestUserText(request) || flattenContents(request));
    } else {
      sections.push(flattenContents(request));
    }
    return sections.filter((section) => section && section.trim()).join('\n\n');
  }

  private textOf(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }
    const anyValue = value as { parts?: Array<{ text?: string }> };
    if (anyValue?.parts) {
      return anyValue.parts
        .map((part) => part.text ?? '')
        .filter((text) => text)
        .join('');
    }
    return '';
  }

  /** Tool name from a parsed tool-call part (`{name, arguments}`). */
  private toolCallName(text: string): string {
    try {
      return (JSON.parse(text) as { name?: string }).name ?? '';
    } catch {
      return '';
    }
  }

  /**
   * One-shot corrective message sent when the model emitted malformed DSML.
   * Keeps the model on DSML and lists the only tool names it may use.
   */
  private correctionMessage(toolNames: string[]): string {
    const B = '\uFF5C\uFF5C';
    return (
      'Your previous response contained malformed tool-call markup. ' +
      'Re-emit the tool call now in this exact format and nothing else:\n\n' +
      `<${B}DSML${B} calls>\n` +
      `<${B}DSML${B} invoke name="tool_name">\n` +
      `<${B}DSML${B} parameter name="arg" string="true">value</${B}DSML${B} parameter>\n` +
      `</${B}DSML${B} invoke>\n` +
      `</${B}DSML${B} calls>\n\n` +
      `Use only these tools: ${toolNames.join(', ')}.\n\n` +
      `No JSON. No ${'<tool_call>'}. No extra closing tags. No nested invoke.`
    );
  }

  private toParts(part: StreamPart): Part[] {
    if (part.kind === 'tool_call') {
      try {
        const parsed = JSON.parse(part.text) as {
          name?: string;
          arguments?: unknown;
        };
        if (parsed?.name) {
          // Fix 1.3: DSML sometimes encodes `arguments` as a JSON *string*
          // instead of an object (e.g. "{\"file_path\": \"...\"}"). Parse it so
          // the first tool call does not fail validation and waste a turn.
          let args = parsed.arguments;
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args);
            } catch {
              // Leave as-is; the schema validator will explain the problem.
            }
          }
          // DeepSeek occasionally double-wraps the payload:
          // {"name":"read_file","arguments":{"arguments":"{\"path\":...}"}}.
          // Unwrap the single `arguments` key so the call reaches the tool.
          if (args && typeof args === 'object' && !Array.isArray(args)) {
            const wrapper = args as Record<string, unknown>;
            const keys = Object.keys(wrapper);
            if (keys.length === 1 && keys[0] === 'arguments') {
              let inner = wrapper['arguments'];
              if (typeof inner === 'string') {
                try {
                  inner = JSON.parse(inner);
                } catch {
                  // keep the original value
                }
              }
              if (inner && typeof inner === 'object') {
                args = inner;
              }
            }
          }
          return [
            {
              functionCall: {
                name: parsed.name,
                args:
                  args && typeof args === 'object'
                    ? (args as Record<string, unknown>)
                    : {},
              },
            },
          ];
        }
      } catch {
        return [];
      }
      return [];
    }
    if (part.kind === 'thinking') {
      return [{ text: part.text, thought: true }];
    }
    return [{ text: part.text }];
  }

  generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    return Promise.resolve(this.streamImpl(request, userPromptId, role));
  }

  private async *streamImpl(
    request: GenerateContentParameters,
    _userPromptId: string,
    role: LlmRole,
  ): AsyncGenerator<GenerateContentResponse> {
    // Fix 1: side-channel calls (summarizer, compressor, router, ...) are not
    // part of the conversation. Running them in their own DeepSeek thread keeps
    // the user's chat free of tooling prompts and avoids re-sending the big
    // system preamble. They never receive the system instruction or tool list.
    const isUtility = role !== LlmRole.MAIN && role !== LlmRole.SUBAGENT;
    const priorConversationId = isUtility
      ? this.utilityConversationId
      : this.conversationId;
    // Turn budget: DeepSeek cuts a stream that grows too long, which loses the
    // turn. Measure everything the model has produced plus every tool result
    // fed back during this user turn, and stop the current response cleanly
    // before the next request would blow past the stream limit.
    const history = (request.contents ?? []) as Array<{
      role?: string;
      parts?: Array<Record<string, unknown>>;
    }>;
    const lastContent = history[history.length - 1];
    const isToolContinuation = (lastContent?.parts ?? []).some(
      (part) => 'functionResponse' in part,
    );
    if (!isToolContinuation) {
      this.turnOutputChars = 0;
    }
    let budgetBaseline = 0;
    const toolResultChars = history.reduce((total, content) => {
      return (
        total +
        (content.parts ?? []).reduce((sub, part) => {
          const fr = (
            part as {
              functionResponse?: { response?: unknown };
            }
          ).functionResponse;
          return sub + (fr ? JSON.stringify(fr.response ?? {}).length : 0);
        }, 0)
      );
    }, 0);
    // Utility calls (summarizer, compressor, router, ...) must see exactly
    // what the caller handed us — the whole contents array, including the
    // history they are asked to work on. They deliberately do NOT get the
    // system preamble, DEEPSEEK.md/AGENTS.md context or the tool schema.
    const prompt = isUtility
      ? flattenContents(request)
      : this.buildPrompt(request);
    if (process.env['DEBUG_DEEPSEEK']) {
      const contents = request.contents;
      console.error(
        '[utility-prompt] role=%s contents_blocks=%d prompt_chars=%d',
        role,
        Array.isArray(contents) ? contents.length : 0,
        prompt.length,
      );
    }
    if (process.env['DEBUG_DEEPSEEK']) {
      const history = (request.contents ?? []) as Array<{
        role?: string;
        parts?: Array<Record<string, unknown>>;
      }>;
      console.error(
        '[request] history_len=%d last_role=%s',
        history.length,
        history[history.length - 1]?.role ?? 'none',
      );
      for (const content of history) {
        for (const part of content.parts ?? []) {
          const fr = (part as { functionResponse?: { name?: string; response?: unknown } })
            .functionResponse;
          if (fr?.name) {
            console.error(
              '[tool-result] name=%s chars=%d queued=%s',
              fr.name,
              JSON.stringify(fr.response ?? {}).length,
              true,
            );
          }
        }
      }
    }
    this.requestCount += 1;
    if (process.env['DEBUG_DEEPSEEK']) {
      // Fix 1 audit: exactly one of these per user turn.
      console.error(
        `[deepseek-request] turn=${this.requestCount} reason=${role} ` +
          `prompt_chars=${prompt.length}`,
      );
    }
    const settings = readDeepSeekSettings();
    const thinking = this.options.thinking ?? settings.thinking;
    let search = this.options.search ?? settings.webSearch;
    // Fix: DeepSeek's chat rejects the combination of DeepThink (thinking) with
    // web search when the model wants to use a tool — the stream comes back as
    // `response/status INCOMPLETE` + `generation_err` ("Server is temporarily
    // unavailable"), which the harness then mis-reads as a thoughts-only turn.
    // The two features are mutually exclusive in the DeepSeek web chat, so when
    // thinking is on we do not request web search.
    if (thinking && search) {
      if (process.env['DEBUG_DEEPSEEK']) {
        console.error(
          '[deepseek-flags] thinking=true -> search_enabled=false (mutually exclusive)',
        );
      }
      search = false;
    }
    let thinkFragments = 0;
    let responseFragments = 0;
    const knownTools = new Set<string>(
      this.config.getToolRegistry?.()?.getAllToolNames?.() ?? [],
    );
    const maxAttempts = 2;
    let attemptPrompt = prompt;
    let attemptConversationId = priorConversationId;
    let lastConversationId = priorConversationId;
    let streamFinished = false;
    let validCalls = 0;
    let rejectedNames: string[] = [];
    let sawBrokenMarkup = false;
    let budgetContinuations = 0;
    const maxBudgetContinuations = 8;
    outer: for (;;) {
      if (!isUtility) {
        const turnChars = toolResultChars + this.turnOutputChars;
        const sinceBaseline = turnChars - budgetBaseline;
        if (process.env['DEBUG_DEEPSEEK']) {
          console.error(
            '[turn-budget] chars=%d threshold=%d',
            sinceBaseline,
            TURN_OUTPUT_CHAR_BUDGET,
          );
        }
        if (sinceBaseline > TURN_OUTPUT_CHAR_BUDGET) {
          console.error(
            '[turn-budget] turn output exceeded %d chars, stopping cleanly. Model can continue next turn.',
            TURN_OUTPUT_CHAR_BUDGET,
          );
          if (budgetContinuations >= maxBudgetContinuations) {
            yield makeResponse([
              {
                text:
                  'Turn budget reached (continuation limit). Continue with the ' +
                  'next single step. Do not re-read files you have already read.',
              },
            ]);
            yield makeResponse([], 'STOP');
            return;
          }
          budgetContinuations += 1;
          // Allow another full budget of progress before gating again.
          budgetBaseline = turnChars;
          // Tell the model what is happening and let it continue with the next
          // single step instead of the server cutting the stream.
          attemptPrompt =
            'Turn budget reached. Continue with the next single step. ' +
            'Do not re-read files you have already read.';
          attemptConversationId = lastConversationId;
          continue outer;
        }
      }
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const generator = this.client.streamParts(attemptPrompt, {
        conversationId: attemptConversationId,
        thinking,
        search,
        modelType: this.options.modelType,
      });
      validCalls = 0;
      rejectedNames = [];
      let rawText = '';
      let result = await generator.next();
      while (!result.done) {
        const part = result.value;
        if (part.kind === 'thinking') {
          thinkFragments += 1;
        } else if (part.kind === 'answer') {
          responseFragments += 1;
          rawText += part.text;
        } else if (part.kind === 'tool_call') {
          rawText += part.text;
          const name = this.toolCallName(part.text);
          if (knownTools.size > 0 && name && !knownTools.has(name)) {
            // Hallucinated tool name: never execute it. Remember it so the
            // batch can be retried with an explicit correction.
            rejectedNames.push(name);
            result = await generator.next();
            continue;
          }
          validCalls += 1;
          if (process.env['DEBUG_DEEPSEEK']) {
            console.error(`[deepseek-tool-call] ${part.text}`);
          }
        }
        const parts = this.toParts(part);
        if (parts.length) {
          if (!isUtility) {
            for (const p of parts) {
              if (typeof p.text === 'string') {
                this.turnOutputChars += p.text.length;
              }
            }
          }
          yield makeResponse(parts);
        }
        result = await generator.next();
      }
      streamFinished = result.value.finished;
      lastConversationId = result.value.conversationId;
      if (rejectedNames.length > 0 && process.env['DEBUG_DEEPSEEK']) {
        console.error(
          '[tool-call] rejected unknown tools: %s',
          rejectedNames.join(', '),
        );
      }
      const broken =
        validCalls === 0 &&
        (rejectedNames.length > 0 || looksLikeBrokenToolCall(rawText));
      if (!broken) {
        break;
      }
      sawBrokenMarkup = true;
      if (attempt === maxAttempts - 1) {
        // Retry already happened and the markup is still broken: save the raw
        // output, tell the user how to continue, and end the turn cleanly.
        const rawPath = `/tmp/broken_tool_call_${Date.now()}.txt`;
        try {
          fs.writeFileSync(rawPath, rawText, 'utf-8');
          console.error(`[tool-call] retry failed. Raw output saved to ${rawPath}.`);
          console.error('[tool-call] type continue to try once more');
        } catch (error) {
          console.error('[tool-call] retry failed.', error);
        }
        break;
      }
      if (process.env['DEBUG_DEEPSEEK']) {
        console.error('[tool-call] broken_markup retrying once');
      }
      attemptPrompt = this.correctionMessage([...knownTools]);
      attemptConversationId = lastConversationId;
    }
    break;
  }
    if (process.env['DEBUG_DEEPSEEK']) {
      console.error('[tool-call] retry_valid_calls=%d', validCalls);
    }
    void sawBrokenMarkup;
    if (process.env['DEBUG_DEEPSEEK']) {
      console.error(
        '[deepseek-stream] finished=%s think_fragments=%d response_fragments=%d',
        streamFinished,
        thinkFragments,
        responseFragments,
      );
    }
    if (isUtility) {
      this.utilityConversationId = lastConversationId;
    } else {
      this.conversationId = lastConversationId;
    }
    // Bug 1: only a FINISHED stream is a completed turn. When DeepSeek ends the
    // stream INCOMPLETE (server-side generation error) we must NOT hand the
    // harness a synthetic STOP — that makes it look like a clean turn that
    // produced thoughts but no answer, which triggers the "you previously
    // generated thoughts" continuation. Report it as a blocked stream instead
    // so the harness retries the same request cleanly.
    if (!streamFinished) {
      // DeepSeek ended the stream without the FINISHED marker (server-side
      // generation error). Deliver whatever we received instead of reporting a
      // generic "OTHER" finish reason, which the harness renders as
      // "The model response was blocked due to other policy settings." and
      // kills the turn for.
      console.error(
        '[deepseek-stream] server ended the stream without FINISHED; delivering partial result',
      );
    }
    yield makeResponse([], 'STOP');
  }

  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<GenerateContentResponse> {
    const parts: Part[] = [];
    for await (const chunk of await this.generateContentStream(
      request,
      userPromptId,
      role,
    )) {
      const chunkParts = chunk.candidates?.[0]?.content?.parts ?? [];
      parts.push(...(chunkParts as Part[]));
    }
    return makeResponse(parts, 'STOP');
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    const text = this.buildPrompt({
      model: request.model,
      contents: request.contents,
    } as GenerateContentParameters);
    return { totalTokens: Math.ceil(text.length / 4) } as CountTokensResponse;
  }

  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    return { embeddings: [] } as unknown as EmbedContentResponse;
  }
}

export function createDeepSeekContentGenerator(
  config: Config,
  options: DeepSeekContentGeneratorOptions = {},
): DeepSeekContentGenerator {
  return new DeepSeekContentGenerator(config, options);
}

export type { AuthType };
