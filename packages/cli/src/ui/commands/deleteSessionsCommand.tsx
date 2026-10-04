/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * /delete-sessions — numbered session list with range syntax and confirmation.
 */

import {
  CommandKind,
  type CommandContext,
  type OpenCustomDialogActionReturn,
  type SlashCommand,
} from './types.js';
import { DeleteSessionsDialog } from '../components/DeleteSessionsDialog.js';

export const deleteSessionsCommand: SlashCommand = {
  name: 'delete-sessions',
  description:
    'Delete saved sessions by number or range (e.g. 1,3,4-8, all)',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: (context: CommandContext): OpenCustomDialogActionReturn => ({
    type: 'custom_dialog',
    component: <DeleteSessionsDialog onClose={context.ui.removeComponent} />,
  }),
};
