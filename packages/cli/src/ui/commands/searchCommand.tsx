/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * /search — picker for DeepSeek's built-in web search (deepseek.webSearch).
 */

import {
  CommandKind,
  type CommandContext,
  type OpenCustomDialogActionReturn,
  type SlashCommand,
} from './types.js';
import { BooleanSettingDialog } from '../components/BooleanSettingDialog.js';

export const searchCommand: SlashCommand = {
  name: 'search',
  description:
    "Open a picker to turn DeepSeek's built-in web search on or off (deepseek.webSearch; default on)",
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: (context: CommandContext): OpenCustomDialogActionReturn => ({
    type: 'custom_dialog',
    component: (
      <BooleanSettingDialog
        title="DeepSeek web search"
        settingKey="deepseek.webSearch"
        defaultValue={true}
        description="When on, the DeepSeek payload sends search_enabled=true. Takes effect on the next request."
        onClose={context.ui.removeComponent}
      />
    ),
  }),
};
