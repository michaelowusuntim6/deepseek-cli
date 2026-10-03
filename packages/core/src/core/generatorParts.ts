/**
 * @license
 * Shared response shaping for the custom ContentGenerators.
 */

import type { GenerateContentResponse } from '@google/genai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Project-then-user .gemini/settings.json, merged into one object. */
export function readMergedSettings(): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const file of [
    path.join(process.cwd(), '.gemini', 'settings.json'),
    path.join(os.homedir(), '.gemini', 'settings.json'),
  ]) {
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
