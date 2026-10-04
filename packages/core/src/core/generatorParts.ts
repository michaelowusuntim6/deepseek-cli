/**
 * @license
 * Shared response shaping for the custom ContentGenerators.
 */

import type { GenerateContentResponse } from '@google/genai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { APP_DIR_NAME, LEGACY_APP_DIR_NAME } from '../utils/paths.js';

/**
 * Settings files for the DeepSeek providers, lowest precedence first: user
 * (legacy `.gemini` then `.deepseek`), then project (same order). Project
 * settings override user settings, and the new `.deepseek/` file always wins
 * over the legacy `.gemini/` one within the same scope.
 */
export function deepseekSettingsFiles(): string[] {
  return [
    path.join(os.homedir(), LEGACY_APP_DIR_NAME, 'settings.json'),
    path.join(os.homedir(), APP_DIR_NAME, 'settings.json'),
    path.join(process.cwd(), LEGACY_APP_DIR_NAME, 'settings.json'),
    path.join(process.cwd(), APP_DIR_NAME, 'settings.json'),
  ];
}

/** Project-then-user settings, merged into one object (.deepseek wins). */
export function readMergedSettings(): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const file of deepseekSettingsFiles()) {
    try {
      Object.assign(merged, JSON.parse(fs.readFileSync(file, 'utf-8')));
    } catch {
      // missing/invalid settings file: defaults apply
    }
  }
  return merged;
}

export interface Part {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args: Record<string, unknown> };
}

interface Candidate {
  content: { role: string; parts: Part[] };
  finishReason?: string;
  index?: number;
}

/** Build a GenerateContentResponse-shaped object the Scheduler understands. */
export function makeResponse(
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
  const response = { candidates: [candidate] } as unknown as GenerateContentResponse;
  Object.defineProperty(response, 'functionCalls', {
    value: parts
      .filter((part) => part.functionCall)
      .map((part) => part.functionCall),
    enumerable: true,
  });
  return response;
}
