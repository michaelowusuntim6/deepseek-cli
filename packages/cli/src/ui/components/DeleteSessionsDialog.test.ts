/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parseSessionSelection } from './DeleteSessionsDialog.js';

describe('parseSessionSelection', () => {
  it('parses a single number', () => {
    expect(parseSessionSelection('3', 10).indices).toEqual([3]);
  });

  it('parses a range', () => {
    expect(parseSessionSelection('4-5', 10).indices).toEqual([4, 5]);
  });

  it('parses mixed lists with whitespace and dedupes', () => {
    expect(parseSessionSelection('1, 3, 4-8, 4', 10).indices).toEqual([
      1, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it('supports all (except nothing — caller filters the current session)', () => {
    expect(parseSessionSelection('all', 4).indices).toEqual([1, 2, 3, 4]);
  });

  it('cancels on q', () => {
    expect(parseSessionSelection('q', 4).cancel).toBe(true);
  });

  it('warns on out-of-range numbers and ignores them', () => {
    const parsed = parseSessionSelection('2,99', 5);
    expect(parsed.indices).toEqual([2]);
    expect(parsed.warnings.join(' ')).toContain('99 is out of range');
  });

  it('handles reversed ranges', () => {
    expect(parseSessionSelection('5-3', 10).indices).toEqual([3, 4, 5]);
  });
});
