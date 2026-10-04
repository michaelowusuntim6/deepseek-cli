/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * /delete-sessions — numbered, newest-first session list with range selection
 * ("3", "4-5", "1,3,4-8", "all", "q") and a confirmation step. Deletion uses
 * the same code path as the session-browser's `x` key.
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import path from 'node:path';
import { theme } from '../semantic-colors.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useKeypress, type Key } from '../hooks/useKeypress.js';
import {
  formatRelativeTime,
  getSessionFiles,
  type SessionInfo,
} from '../../utils/sessionUtils.js';

export interface ParsedSelection {
  indices: number[];
  warnings: string[];
  cancel: boolean;
}

/**
 * Parse the selection input. Tolerates whitespace, dedupes, ignores
 * out-of-range numbers with a warning, and understands 'all' / 'q'.
 */
export function parseSessionSelection(
  raw: string,
  count: number,
): ParsedSelection {
  const warnings: string[] = [];
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'q' || trimmed === 'quit' || trimmed === '') {
    return { indices: [], warnings, cancel: trimmed !== '' };
  }
  if (trimmed === 'all') {
    return {
      indices: Array.from({ length: count }, (_, i) => i + 1),
      warnings,
      cancel: false,
    };
  }
  const selected = new Set<number>();
  for (const token of trimmed.split(',')) {
    const part = token.trim();
    if (!part) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      const [lo, hi] = start <= end ? [start, end] : [end, start];
      for (let i = lo; i <= hi; i++) {
        if (i >= 1 && i <= count) selected.add(i);
        else warnings.push(`${i} is out of range`);
      }
      continue;
    }
    if (/^\d+$/.test(part)) {
      const value = Number(part);
      if (value >= 1 && value <= count) selected.add(value);
      else warnings.push(`${value} is out of range`);
      continue;
    }
    warnings.push(`"${part}" is not a number or range`);
  }
  return {
    indices: [...selected].sort((a, b) => a - b),
    warnings,
    cancel: false,
  };
}

interface DeleteSessionsDialogProps {
  onClose?: () => void;
}

type Phase = 'select' | 'confirm' | 'done';

export function DeleteSessionsDialog({
  onClose,
}: DeleteSessionsDialogProps): React.JSX.Element {
  const config = useConfig();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [phase, setPhase] = useState<Phase>('select');
  const [input, setInput] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [chosen, setChosen] = useState<SessionInfo[]>([]);
  const [status, setStatus] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const chatsDir = path.join(
          config?.storage.getProjectTempDir() ?? '',
          'chats',
        );
        const all = await getSessionFiles(
          chatsDir,
          config?.getSessionId() ?? undefined,
        );
        const deletable = all
          .filter((session) => !session.isCurrentSession)
          .sort(
            (a, b) =>
              new Date(b.lastUpdated).getTime() -
              new Date(a.lastUpdated).getTime(),
          );
        if (!cancelled) setSessions(deletable);
      } catch (error) {
        if (!cancelled) {
          setSessions([]);
          setStatus(
            `Could not load sessions: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config]);

  const shortId = (session: SessionInfo) =>
    (session.id ?? '').slice(0, 8);

  const handleConfirm = useCallback(async () => {
    const recording = config?.getGeminiClient?.()?.getChatRecordingService?.();
    let deleted = 0;
    for (const session of chosen) {
      try {
        await recording?.deleteSession(session.file);
        deleted += 1;
      } catch {
        // Best effort: keep deleting the rest.
      }
    }
    const remaining = (sessions?.length ?? 0) - deleted;
    setStatus(`Deleted ${deleted} sessions. ${remaining} remain.`);
    setPhase('done');
  }, [chosen, config, sessions]);

  useKeypress(
    (key: Key) => {
      if (phase === 'done') {
        if (key.name === 'escape' || key.name === 'return') {
          onClose?.();
          return true;
        }
        return false;
      }
      if (key.name === 'escape') {
        onClose?.();
        return true;
      }
      if (key.name === 'backspace') {
        setInput((prev) => prev.slice(0, -1));
        return true;
      }
      if (key.name === 'return' || key.name === 'enter') {
        if (phase === 'select') {
          const parsed = parseSessionSelection(input, sessions?.length ?? 0);
          if (parsed.cancel) {
            onClose?.();
            return true;
          }
          setWarnings(parsed.warnings);
          if (parsed.indices.length === 0) {
            setStatus('Nothing selected. Enter numbers like 3, 4-5 or "all".');
            return true;
          }
          setChosen(parsed.indices.map((i) => sessions![i - 1]));
          setPhase('confirm');
          return true;
        }
        if (phase === 'confirm') {
          if (input.trim().toLowerCase() === 'yes') {
            void handleConfirm();
            setInput('');
            return true;
          }
          onClose?.();
          return true;
        }
      }
      if (key.insertable && key.sequence && key.sequence >= ' ') {
        setInput((prev) => prev + key.sequence);
        return true;
      }
      return false;
    },
    { isActive: true, priority: true },
  );

  const listView = useMemo(() => {
    if (!sessions) return ['Loading sessions…'];
    if (sessions.length === 0) return ['No other sessions to delete.'];
    return sessions.map(
      (session, i) =>
        `${i + 1}. ${session.displayName || session.firstUserMessage} (${formatRelativeTime(
          session.lastUpdated,
        )})  [${shortId(session)}]`,
    );
  }, [sessions]);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border.default}
      paddingX={1}
      marginX={1}
      marginBottom={1}
    >
      <Text color={theme.text.primary} bold>
        Delete sessions
      </Text>
      {phase === 'select' && (
        <>
          <Text color={theme.text.secondary}>
            Enter session numbers to delete (e.g. 3, 4-5, 1,3,7-9).
          </Text>
          <Text color={theme.text.secondary}>
            &apos;q&apos; to cancel. &apos;all&apos; to delete every session
            except the current one.
          </Text>
          <Box flexDirection="column" marginY={1}>
            {listView.slice(0, 20).map((line) => (
              <Text key={line} color={theme.text.primary}>
                {line.length > 110 ? `${line.slice(0, 107)}...` : line}
              </Text>
            ))}
            {listView.length > 20 && (
              <Text color={theme.ui.comment}>
                … {listView.length - 20} more
              </Text>
            )}
          </Box>
          <Text color={theme.text.accent}>{'> '}{input}</Text>
        </>
      )}
      {phase === 'confirm' && (
        <>
          <Text color={theme.status.warning}>
            About to delete {chosen.length} session
            {chosen.length === 1 ? '' : 's'}:
          </Text>
          <Box flexDirection="column" marginY={1}>
            {chosen.map((session) => (
              <Text key={session.file} color={theme.text.primary}>
                {'  '}
                {session.displayName || session.firstUserMessage} (
                {formatRelativeTime(session.lastUpdated)}) [{shortId(session)}]
              </Text>
            ))}
          </Box>
          <Text color={theme.text.secondary}>
            Type &apos;yes&apos; to confirm, anything else to cancel:
          </Text>
          <Text color={theme.text.accent}>{'> '}{input}</Text>
        </>
      )}
      {phase === 'done' && (
        <Text color={theme.status.success}>{status}</Text>
      )}
      {warnings.length > 0 && phase === 'confirm' && (
        <Text color={theme.status.warning}>
          Ignored: {warnings.join('; ')}
        </Text>
      )}
      {status && phase === 'select' && (
        <Text color={theme.text.secondary}>{status}</Text>
      )}
      <Box marginTop={1}>
        <Text color={theme.ui.comment}>
          {phase === 'done'
            ? 'Enter or Esc to close'
            : 'Enter to continue · Esc to cancel'}
        </Text>
      </Box>
    </Box>
  );
}
