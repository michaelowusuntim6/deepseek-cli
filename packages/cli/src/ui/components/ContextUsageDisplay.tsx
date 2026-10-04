/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { getContextUsagePercentage } from '../utils/contextUsage.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { tokenLimit } from 'deepseek-cli-core';
import {
  MIN_TERMINAL_WIDTH_FOR_FULL_LABEL,
  DEFAULT_COMPRESSION_THRESHOLD,
} from '../constants.js';

export const ContextUsageDisplay = ({
  promptTokenCount,
  model,
  terminalWidth,
}: {
  promptTokenCount: number;
  model: string | undefined;
  terminalWidth: number;
}) => {
  const settings = useSettings();
  const config = useConfig();
  const percentage = getContextUsagePercentage(promptTokenCount, model);
  const percentageUsed = (percentage * 100).toFixed(0);

  const threshold =
    settings.merged.model?.compressionThreshold ??
    DEFAULT_COMPRESSION_THRESHOLD;

  let textColor = theme.text.secondary;
  if (percentage >= 1.0) {
    textColor = theme.status.error;
  } else if (percentage >= threshold) {
    textColor = theme.status.warning;
  }

  const label =
    terminalWidth < MIN_TERMINAL_WIDTH_FOR_FULL_LABEL ? '%' : '% used';

  // DeepSeek CLI: honest (chars/4) context accounting, persisted per session.
  const stats = config
    ?.getGeminiClient?.()
    ?.getChatRecordingService?.()
    ?.getSessionStats?.();
  const compact = (value: number) => {
    if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
    if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
    return String(value);
  };
  const windowTokens = tokenLimit(model ?? 'deepseek-expert');
  const suffix = stats
    ? `  ·  ctx ~${compact(stats.estimatedTokensCurrent)} / ${compact(
        windowTokens,
      )}  ·  cum ~${compact(stats.estimatedTokensConsumed)}  ·  cmp ${
        stats.compressionCount
      }`
    : '';

  return (
    <Text color={textColor}>
      {percentageUsed}
      {label}
      {suffix}
    </Text>
  );
};
