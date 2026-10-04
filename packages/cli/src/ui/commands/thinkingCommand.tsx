/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * /thinking — picker for DeepSeek DeepThink reasoning (deepseek.thinking).
 */

import {
  CommandKind,
  type CommandContext,
  type OpenCustomDialogActionReturn,
  type SlashCommand,
} from './types.js';
import { BooleanSettingDialog } from '../components/BooleanSettingDialog.js';

export const thinkingCommand: SlashCommand = {
  name: 'thinking',
  altNames: ['think'],
  description:
    'Open a picker to turn DeepSeek DeepThink reasoning on or off (deepseek.thinking)',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: (context: CommandContext): OpenCustomDialogActionReturn => ({
    type: 'custom_dialog',
    component: (
      <BooleanSettingDialog
        title="DeepSeek DeepThink"
        settingKey="deepseek.thinking"
        companionSettingKey="deepseek.webSearch"
        defaultValue={false}
        description="Thinking and web search cannot both be on. Enabling this turns web search off. Takes effect on the next request."
        onClose={context.ui.removeComponent}
      />
    ),
  }),
};
