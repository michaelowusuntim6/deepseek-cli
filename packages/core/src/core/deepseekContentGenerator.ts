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
import * as os from 'node:os';
import * as path from 'node:path';
import type { UserTierId, GeminiUserTier } from '../code_assist/types.js';
import { LlmRole } from '../telemetry/llmRole.js';
import { DeepSeekClient } from '../deepseek/client.js';
import type { StreamPart } from '../deepseek/sse.js';

export const DEEPSEEK_THINKING_MODES = ['off', 'on'] as const;
export type DeepSeekThinkingMode = (typeof DEEPSEEK_THINKING_MODES)[number];

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
        texts.push(
          `<tool_call>${JSON.stringify({
            name: anyPart.functionCall.name,
            arguments: anyPart.functionCall.args ?? {},
          })}</tool_call>`,
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
  for (const file of [
    path.join(process.cwd(), '.gemini', 'settings.json'),
    path.join(os.homedir(), '.gemini', 'settings.json'),
  ]) {
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
      sections.push(
        'Available tools (call them with your native tool-call markup; ' +
          'DSML invoke blocks or <tool_call>{"name":..,"arguments":{..}}</tool_call> ' +
          'are both accepted):\n' +
          tools,
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
    const prompt = isUtility
      ? latestUserText(request) || flattenContents(request)
      : this.buildPrompt(request);
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
    const generator = this.client.streamParts(prompt, {
      conversationId: priorConversationId,
      thinking,
      search,
      modelType: this.options.modelType,
    });
    let thinkFragments = 0;
    let responseFragments = 0;
    let result = await generator.next();
    while (!result.done) {
      if (result.value.kind === 'thinking') {
        thinkFragments += 1;
      } else if (result.value.kind === 'answer') {
        responseFragments += 1;
      }
      if (process.env['DEBUG_DEEPSEEK'] && result.value.kind === 'tool_call') {
        // Fix 1 audit: shows the exact parameter names DeepSeek emitted.
        console.error(`[deepseek-tool-call] ${result.value.text}`);
      }
      const parts = this.toParts(result.value);
      if (parts.length) {
        yield makeResponse(parts);
      }
      result = await generator.next();
    }
    const streamFinished = result.value.finished;
    if (process.env['DEBUG_DEEPSEEK']) {
      console.error(
        '[deepseek-stream] finished=%s think_fragments=%d response_fragments=%d',
        streamFinished,
        thinkFragments,
        responseFragments,
      );
    }
    if (isUtility) {
      this.utilityConversationId = result.value.conversationId;
    } else {
      this.conversationId = result.value.conversationId;
    }
    // Bug 1: only a FINISHED stream is a completed turn. When DeepSeek ends the
    // stream INCOMPLETE (server-side generation error) we must NOT hand the
    // harness a synthetic STOP — that makes it look like a clean turn that
    // produced thoughts but no answer, which triggers the "you previously
    // generated thoughts" continuation. Report it as a blocked stream instead
    // so the harness retries the same request cleanly.
    yield makeResponse([], streamFinished ? 'STOP' : 'OTHER');
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
