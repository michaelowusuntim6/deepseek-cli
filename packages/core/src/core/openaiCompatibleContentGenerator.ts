/**
 * @license
 * OpenAI-compatible ContentGenerator.
 *
 * Works with any endpoint that speaks POST {baseUrl}/chat/completions with
 * `stream: true` (llama.cpp's llama-server, vLLM, Ollama's OpenAI API, ...).
 * Used by both the `openai-compatible` and `llamacpp` auth types; the
 * llama.cpp variant only changes defaults and adds reasoning_content support.
 */

import type { ContentGenerator } from './contentGenerator.js';
import type {
  GenerateContentParameters,
  GenerateContentResponse,
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
} from '@google/genai';
import type { Config } from '../config/config.js';
import type { UserTierId, GeminiUserTier } from '../code_assist/types.js';
import type { LlmRole } from '../telemetry/llmRole.js';
import { readDeepSeekSettings } from './deepseekContentGenerator.js';
import { makeResponse, type Part } from './generatorParts.js';

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey?: string | null;
  model: string;
  thinking?: boolean;
  /** llama.cpp returns reasoning_content alongside content. */
  reasoningField?: boolean;
}

interface OpenAiToolCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export class OpenAiCompatibleContentGenerator implements ContentGenerator {
  userTier?: UserTierId;
  userTierName?: string;
  paidTier?: GeminiUserTier;

  constructor(
    private readonly config: Config,
    private readonly options: OpenAiCompatibleOptions,
  ) {}

  /** Model name from the harness config (diagnostics/logging). */
  get modelName(): string {
    return this.config.getModel?.() ?? this.options.model;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    // llama.cpp accepts "Bearer none"; only send when a key is configured.
    if (this.options.apiKey) {
      headers['authorization'] = `Bearer ${this.options.apiKey}`;
    }
    return headers;
  }

  private buildBody(request: GenerateContentParameters): Record<string, unknown> {
    const messages: Array<Record<string, unknown>> = [];
    const systemInstruction = request.config?.systemInstruction;
    const systemText = textOfValue(systemInstruction);
    if (systemText) {
      messages.push({ role: 'system', content: systemText });
    }
    const contents = (request.contents ?? []) as Array<{
      role?: string;
      parts?: Array<Record<string, unknown>>;
    }>;
    for (const content of contents) {
      const role = content.role === 'model' ? 'assistant' : content.role ?? 'user';
      const texts: string[] = [];
      const toolCalls: Array<Record<string, unknown>> = [];
      for (const part of content.parts ?? []) {
        const anyPart = part as {
          text?: string;
          functionCall?: { name: string; args?: Record<string, unknown> };
          functionResponse?: { name: string; response?: Record<string, unknown> };
        };
        if (typeof anyPart.text === 'string' && anyPart.text) {
          texts.push(anyPart.text);
        } else if (anyPart.functionCall) {
          toolCalls.push({
            id: `call_${toolCalls.length}`,
            type: 'function',
            function: {
              name: anyPart.functionCall.name,
              arguments: JSON.stringify(anyPart.functionCall.args ?? {}),
            },
          });
        } else if (anyPart.functionResponse) {
          messages.push({
            role: 'tool',
            tool_call_id: `call_0`,
            content: JSON.stringify(anyPart.functionResponse.response ?? {}),
          });
        }
      }
      if (texts.length || toolCalls.length) {
        const message: Record<string, unknown> = {
          role,
          content: texts.join('\n'),
        };
        if (toolCalls.length) {
          message['tool_calls'] = toolCalls;
        }
        messages.push(message);
      }
    }

    const body: Record<string, unknown> = {
      model: this.options.model,
      messages,
      stream: true,
    };
    const tools = toolDeclarations(request);
    if (tools.length) {
      body['tools'] = tools;
    }
    if (this.options.thinking ?? readDeepSeekSettings().thinking) {
      body['reasoning_effort'] = 'medium';
    }
    return body;
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    return Promise.resolve(this.streamImpl(request));
  }

  private async *streamImpl(
    request: GenerateContentParameters,
  ): AsyncGenerator<GenerateContentResponse> {
    const body = this.buildBody(request);
    if (process.env['DEBUG_DEEPSEEK']) {
      console.error('[payload]', JSON.stringify(body));
    }
    const response = await fetch(
      `${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      },
    );
    if (!response.ok || !response.body) {
      throw new Error(
        `openai-compatible completion failed: ${response.status} ${response.statusText}`,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const toolCalls = new Map<number, { name: string; args: string }>();
    let sawFinish = false;

    const handleLine = (line: string): GenerateContentResponse[] => {
      const out: GenerateContentResponse[] = [];
      if (!line.startsWith('data:')) {
        return out;
      }
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') {
        return out;
      }
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(payload);
      } catch {
        return out;
      }
      const choice = (obj['choices'] as Array<Record<string, unknown>>)?.[0];
      if (!choice) {
        return out;
      }
      const delta = (choice['delta'] ?? {}) as Record<string, unknown>;
      const parts: Part[] = [];
      const reasoning = delta['reasoning_content'];
      if (typeof reasoning === 'string' && reasoning) {
        parts.push({ text: reasoning, thought: true }); // Phase 8.4
      }
      const content = delta['content'];
      if (typeof content === 'string' && content) {
        parts.push({ text: content });
      }
      const calls = delta['tool_calls'] as OpenAiToolCall[] | undefined;
      if (calls) {
        for (const call of calls) {
          const index = call.index ?? 0;
          const existing = toolCalls.get(index) ?? { name: '', args: '' };
          if (call.function?.name) {
            existing.name += call.function.name;
          }
          if (call.function?.arguments) {
            existing.args += call.function.arguments;
          }
          toolCalls.set(index, existing);
        }
      }
      if (choice['finish_reason']) {
        sawFinish = true;
        for (const call of toolCalls.values()) {
          if (!call.name) {
            continue;
          }
          let args: Record<string, unknown> = {};
          try {
            args = call.args ? JSON.parse(call.args) : {};
          } catch {
            args = { raw: call.args };
          }
          parts.push({ functionCall: { name: call.name, args } });
        }
        toolCalls.clear();
      }
      if (parts.length) {
        out.push(makeResponse(parts));
      }
      return out;
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        for (const chunk of handleLine(line)) {
          yield chunk;
        }
        newline = buffer.indexOf('\n');
      }
    }
    if (buffer) {
      for (const chunk of handleLine(buffer)) {
        yield chunk;
      }
    }
    void sawFinish;
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
      parts.push(...((chunk.candidates?.[0]?.content?.parts ?? []) as Part[]));
    }
    return makeResponse(parts, 'STOP');
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    const text = JSON.stringify(request.contents ?? []);
    return { totalTokens: Math.ceil(text.length / 4) } as CountTokensResponse;
  }

  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    return { embeddings: [] } as unknown as EmbedContentResponse;
  }
}

function textOfValue(value: unknown): string {
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

function toolDeclarations(
  request: GenerateContentParameters,
): Array<Record<string, unknown>> {
  const tools = request.config?.tools ?? [];
  const out: Array<Record<string, unknown>> = [];
  for (const tool of tools) {
    const declarations =
      (tool as { functionDeclarations?: Array<Record<string, unknown>> })
        .functionDeclarations ?? [];
    for (const declaration of declarations) {
      out.push({ type: 'function', function: declaration });
    }
  }
  return out;
}

export function createOpenAiCompatibleContentGenerator(
  config: Config,
  options: OpenAiCompatibleOptions,
): OpenAiCompatibleContentGenerator {
  return new OpenAiCompatibleContentGenerator(config, options);
}
