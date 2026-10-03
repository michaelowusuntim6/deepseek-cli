/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { useSettingsStore } from '../contexts/SettingsContext.js';
import { useKeypress } from '../hooks/useKeypress.js';
import {
  RadioButtonSelect,
  type RadioSelectItem,
} from './shared/RadioButtonSelect.js';
import { SettingScope } from '../../config/settings.js';

interface BooleanSettingDialogProps {
  title: string;
  /** Dotted settings path, e.g. `deepseek.thinking`. */
  settingKey: string;
  /** Value to use when the setting has never been written. */
  defaultValue: boolean;
  description?: string;
  onClose?: () => void;
}

function readByPath(source: unknown, dottedPath: string): unknown {
  return dottedPath.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, source);
}

/**
 * A minimal On/Off picker used by boolean DeepSeek settings (`/thinking`,
 * `/search`). It mirrors the selection UX of /model and /theme rather than
 * flipping the value blindly.
 */
export function BooleanSettingDialog({
  title,
  settingKey,
  defaultValue,
  description,
  onClose,
}: BooleanSettingDialogProps): React.JSX.Element {
  const { settings, setSetting } = useSettingsStore();

  const current = useMemo(() => {
    const value = readByPath(settings.merged, settingKey);
    return typeof value === 'boolean' ? value : defaultValue;
  }, [settings.merged, settingKey, defaultValue]);

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onClose?.();
        return true;
      }
      return false;
    },
    { isActive: true },
  );

  const items: Array<RadioSelectItem<boolean>> = useMemo(
    () => [
      {
        key: 'on',
        label: current ? 'On (current)' : 'On',
        value: true,
      },
      {
        key: 'off',
        label: current ? 'Off' : 'Off (current)',
        value: false,
      },
    ],
    [current],
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border.default}
      paddingX={1}
      paddingY={0}
      marginX={1}
      marginBottom={1}
    >
      <Text color={theme.text.primary} bold>
        {title}
      </Text>
      {description && <Text color={theme.text.secondary}>{description}</Text>}
      <Box marginTop={1}>
        <RadioButtonSelect
          items={items}
          initialIndex={current ? 0 : 1}
          onSelect={(value) => {
            setSetting(SettingScope.User, settingKey, value);
            onClose?.();
          }}
        />
      </Box>
      <Box marginTop={1}>
        <Text color={theme.ui.comment}>
          Enter to select · Esc to cancel
        </Text>
      </Box>
    </Box>
  );
}
