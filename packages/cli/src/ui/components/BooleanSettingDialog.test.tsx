/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { renderWithProviders } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { createMockSettings } from '../../test-utils/settings.js';
import { BooleanSettingDialog } from './BooleanSettingDialog.js';

describe('<BooleanSettingDialog />', () => {
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const withUserSettings = (settings: Record<string, unknown>) =>
    createMockSettings({
      user: { path: '', settings, originalSettings: settings },
    });

  it('renders On/Off and marks the current value for /thinking (off)', async () => {
    const settings = withUserSettings({ deepseek: { thinking: false } });
    const { lastFrame } = await renderWithProviders(
      <BooleanSettingDialog
        title="DeepSeek DeepThink"
        settingKey="deepseek.thinking"
        defaultValue={false}
        onClose={onClose}
      />,
      { settings },
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('DeepSeek DeepThink');
    expect(frame).toContain('On');
    expect(frame).toContain('Off (current)');
  });

  it('marks On as current when /thinking is on', async () => {
    const settings = withUserSettings({ deepseek: { thinking: true } });
    const { lastFrame } = await renderWithProviders(
      <BooleanSettingDialog
        title="DeepSeek DeepThink"
        settingKey="deepseek.thinking"
        defaultValue={false}
        onClose={onClose}
      />,
      { settings },
    );

    expect(lastFrame()).toContain('On (current)');
  });

  it('writes the setting and closes when a value is selected', async () => {
    const settings = withUserSettings({ deepseek: { thinking: false } });
    const setValueSpy = vi.spyOn(settings, 'setValue');
    const { stdin, lastFrame } = await renderWithProviders(
      <BooleanSettingDialog
        title="DeepSeek DeepThink"
        settingKey="deepseek.thinking"
        defaultValue={false}
        onClose={onClose}
      />,
      { settings },
    );

    // Highlight starts on the current value (Off); move to On and select it.
    act(() => {
      stdin.write('\x1b[B');
    });
    act(() => {
      stdin.write('\r');
    });

    await waitFor(() => {
      expect(setValueSpy).toHaveBeenCalled();
      const [, key, value] = setValueSpy.mock.calls[0];
      expect(key).toBe('deepseek.thinking');
      expect(value).toBe(true);
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('On (current)');
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('defaults /search to On and marks it current', async () => {
    const settings = withUserSettings({ deepseek: { webSearch: true } });
    const { lastFrame } = await renderWithProviders(
      <BooleanSettingDialog
        title="DeepSeek web search"
        settingKey="deepseek.webSearch"
        defaultValue={true}
        onClose={onClose}
      />,
      { settings },
    );

    expect(lastFrame()).toContain('On (current)');
  });
});
