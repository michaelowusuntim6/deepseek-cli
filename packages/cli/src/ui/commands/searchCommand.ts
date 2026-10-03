/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * /search — toggle DeepSeek's built-in web search (deepseek.webSearch).
 */

import { CommandKind, type SlashCommand } from './types.js';
import { MessageType } from '../types.js';
import { SettingScope } from '../../config/settings.js';

export const searchCommand: SlashCommand = {
  name: 'search',
  description:
    "Toggle DeepSeek's built-in web search (deepseek.webSearch; default on)",
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: (context, args) => {
    const current =
      context.services.settings.merged.deepseek?.webSearch !== false;
    const raw = args.trim().toLowerCase();
    const next = raw
      ? ['on', 'true', '1', 'enable', 'enabled'].includes(raw)
      : !current;
    context.services.settings.setValue(
      SettingScope.User,
      'deepseek.webSearch',
      next,
    );
    return {
      type: 'message',
      messageType: MessageType.INFO,
      content: `DeepSeek web search ${next ? 'enabled' : 'disabled'} (deepseek.webSearch=${next}). The payload sends search_enabled=${next}.`,
    };
  },
};
