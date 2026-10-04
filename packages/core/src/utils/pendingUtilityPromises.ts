/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { debugLogger } from './debugLogger.js';

/**
 * DeepSeek CLI: background utility calls (session titles/summaries) used to be
 * pure fire-and-forget, so the process exited before the DeepSeek request came
 * back and no title was ever written. Every such promise is registered here so
 * the shutdown path can wait briefly for them to settle.
 */
const pendingUtilityPromises = new Set<Promise<unknown>>();

/** Register a background utility promise and untrack it once it settles. */
export function trackUtilityPromise<T>(promise: Promise<T>): Promise<T> {
  pendingUtilityPromises.add(promise);
  const remove = () => {
    pendingUtilityPromises.delete(promise);
  };
  promise.then(remove, remove);
  return promise;
}

export function pendingUtilityPromiseCount(): number {
  return pendingUtilityPromises.size;
}

/**
 * Wait for outstanding utility promises, bounded by `timeoutMs`. Never throws.
 */
export async function awaitPendingUtilityPromises(
  timeoutMs = 5000,
): Promise<void> {
  const snapshot = Array.from(pendingUtilityPromises);
  if (snapshot.length === 0) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(snapshot),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (pendingUtilityPromises.size > 0) {
      debugLogger.warn(
        `[cleanup] ${pendingUtilityPromises.size} background utility call(s) still pending after ${timeoutMs}ms; exiting anyway`,
      );
    }
  } catch {
    // Never block shutdown on a failed utility call.
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
