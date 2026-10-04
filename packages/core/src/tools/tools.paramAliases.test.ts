/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { normalizeToolParamAliases } from './tools.js';

const filePathSchema = {
  type: 'object',
  properties: { file_path: { type: 'string' } },
  required: ['file_path'],
};

describe('normalizeToolParamAliases', () => {
  it('maps absolute_path to file_path', () => {
    const out = normalizeToolParamAliases(filePathSchema, {
      absolute_path: '/tmp/a.txt',
    });
    expect(out).toEqual({ file_path: '/tmp/a.txt', absolute_path: '/tmp/a.txt' });
  });

  it('maps path/file/filename/filepath aliases', () => {
    for (const alias of ['path', 'file', 'filename', 'filepath', 'abs_path']) {
      const out = normalizeToolParamAliases(filePathSchema, {
        [alias]: 'x.txt',
      }) as Record<string, unknown>;
      expect(out['file_path']).toBe('x.txt');
    }
  });

  it('does not overwrite an explicit canonical value', () => {
    const params = { file_path: 'real.txt', absolute_path: 'other.txt' };
    const out = normalizeToolParamAliases(filePathSchema, params);
    expect(out).toBe(params);
    expect(out).toEqual(params);
  });

  it('leaves unrelated params untouched (same object)', () => {
    const params = { pattern: 'foo' };
    expect(normalizeToolParamAliases(filePathSchema, params)).toBe(params);
  });

  it('ignores non-string and empty aliases', () => {
    const params = { absolute_path: '' };
    expect(normalizeToolParamAliases(filePathSchema, params)).toBe(params);
  });
});
