/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  createTestMergedSettings,
  enforceDeepSeekMutualExclusion,
} from './settings.js';

describe('DeepSeek thinking/search mutual exclusion', () => {
  it('defaults to thinking=false, webSearch=true', () => {
    const merged = createTestMergedSettings();
    expect(merged.deepseek?.thinking).toBe(false);
    expect(merged.deepseek?.webSearch).toBe(true);
  });

  it('forces search off when a hand-edited file sets both on', () => {
    const merged = createTestMergedSettings({
      deepseek: { thinking: true, webSearch: true },
    });
    expect(merged.deepseek?.thinking).toBe(true);
    expect(merged.deepseek?.webSearch).toBe(false);
  });

  it('leaves a consistent pair untouched', () => {
    const merged = createTestMergedSettings({
      deepseek: { thinking: true, webSearch: false },
    });
    expect(merged.deepseek?.thinking).toBe(true);
    expect(merged.deepseek?.webSearch).toBe(false);
  });

  it('normalises in place and is idempotent', () => {
    const settings = createTestMergedSettings({
      deepseek: { thinking: true, webSearch: true },
    });
    const once = enforceDeepSeekMutualExclusion(settings);
    const twice = enforceDeepSeekMutualExclusion(settings);
    expect(once.deepseek?.webSearch).toBe(false);
    expect(twice.deepseek?.webSearch).toBe(false);
  });
});
