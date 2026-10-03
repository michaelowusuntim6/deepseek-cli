/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * /thinking — toggle DeepSeek DeepThink reasoning (deepseek.thinking).
 */

import { CommandKind, type SlashCommand } from './types.js';
import { MessageType } from '../types.js';
import { SettingScope } from '../../config/settings.js';

export const thinkingCommand: SlashCommand = {
  name: 'thinking',
  altNames: ['think'],
  description: 'Toggle DeepSeek DeepThink reasoning (deepseek.thinking)',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: (context, args) => {
    const current = Boolean(context.services.settings.merged.deepseek?.thinking);
    const raw = args.trim().toLowerCase();
    const next = raw
      ? ['on', 'true', '1', 'enable', 'enabled'].includes(raw)
      : !current;
    context.services.settings.setValue(
      SettingScope.User,
      'deepseek.thinking',
      next,
    );
    return {
      type: 'message',
      messageType: MessageType.INFO,
      content: `DeepThink ${next ? 'enabled' : 'disabled'} (deepseek.thinking=${next}). It applies to the next request; the payload sends thinking_enabled=${next}.`,
    };
  },
};
