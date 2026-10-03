/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * /provider — show or switch the backend: deepseek-web, openai-compatible,
 * llamacpp. Writes security.auth.selectedType and takes effect on restart.
 */

import { CommandKind, type SlashCommand } from './types.js';
import { MessageType } from '../types.js';
import { SettingScope } from '../../config/settings.js';

const PROVIDERS = ['deepseek-web', 'openai-compatible', 'llamacpp'];

export const providerCommand: SlashCommand = {
  name: 'provider',
  description: `Show or switch the backend (${PROVIDERS.join(' | ')})`,
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: (context, args) => {
    const requested = args.trim().toLowerCase();
    if (!requested) {
      const current =
        context.services.settings.merged.security?.auth?.selectedType ??
        'deepseek-web';
      return {
        type: 'message',
        messageType: MessageType.INFO,
        content: `Current provider: ${current}. Switch with /provider <${PROVIDERS.join('|')}>.`,
      };
    }
    if (!PROVIDERS.includes(requested)) {
      return {
        type: 'message',
        messageType: MessageType.ERROR,
        content: `Unknown provider "${requested}". Valid: ${PROVIDERS.join(', ')}.`,
      };
    }
    context.services.settings.setValue(
      SettingScope.User,
      'security.auth.selectedType',
      requested,
    );
    return {
      type: 'message',
      messageType: MessageType.INFO,
      content: `Provider set to ${requested}. Restart DeepSeek CLI for it to take effect.`,
    };
  },
};
