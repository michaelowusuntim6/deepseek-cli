/**
 * @license
 * llama.cpp provider: the OpenAI-compatible generator with local defaults and
 * reasoning_content → thought parts (see OpenAiCompatibleContentGenerator).
 */

import type { Config } from '../config/config.js';
import {
  OpenAiCompatibleContentGenerator,
  type OpenAiCompatibleOptions,
} from './openaiCompatibleContentGenerator.js';

export const LLAMACPP_DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8080/v1',
  apiKey: 'none',
  model: 'qwen3.5-0.8b',
} as const;

export class LlamaCppContentGenerator extends OpenAiCompatibleContentGenerator {
  constructor(config: Config, options: Partial<OpenAiCompatibleOptions> = {}) {
    super(config, {
      baseUrl: options.baseUrl ?? LLAMACPP_DEFAULTS.baseUrl,
      // llama.cpp accepts "Bearer none", but only send it when configured.
      apiKey: options.apiKey ?? null,
      model: options.model ?? LLAMACPP_DEFAULTS.model,
      thinking: options.thinking,
      reasoningField: true,
    });
  }
}

export function createLlamaCppContentGenerator(
  config: Config,
  options: Partial<OpenAiCompatibleOptions> = {},
): LlamaCppContentGenerator {
  return new LlamaCppContentGenerator(config, options);
}
