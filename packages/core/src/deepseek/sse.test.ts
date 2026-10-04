/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { SseFragmentParser, dsmlCallsToJson } from './sse.js';

const BAR = '\uFF5C\uFF5C';
const CALLS_OPEN = `<${BAR}DSML${BAR} calls>`;
const CALLS_CLOSE = `</${BAR}DSML${BAR} calls>`;
const INVOKE = (name: string, params: string) =>
  `<${BAR}DSML${BAR} invoke name="${name}">${params}</${BAR}DSML${BAR} invoke>`;
const PARAM = (name: string, value: string, isString = true) =>
  `<${BAR}DSML${BAR} parameter name="${name}" string="${isString}">${value}</${BAR}DSML${BAR} parameter>`;

describe('dsmlCallsToJson', () => {
  it('keeps `<`, `<<` heredocs and pipes verbatim in argument values', () => {
    const command = `python3 -c 'x=1<2; print(x)' 2>&1 <<EOF | grep x\ndata\nEOF`;
    const body = INVOKE('run_shell_command', PARAM('command', command));
    const calls = dsmlCallsToJson(body);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('run_shell_command');
    expect(calls[0].arguments['command']).toBe(command);
  });

  it('parses more than two invoke blocks in one calls block', () => {
    const body = [
      INVOKE('run_shell_command', PARAM('command', 'ls -la')),
      INVOKE('run_shell_command', PARAM('command', 'cat README.md')),
      INVOKE('run_shell_command', PARAM('command', 'find . -name "*.py" | head')),
    ].join('\n');
    const calls = dsmlCallsToJson(body);
    expect(calls.map((c) => c.arguments['command'])).toEqual([
      'ls -la',
      'cat README.md',
      'find . -name "*.py" | head',
    ]);
  });

  it('stops at an incomplete invoke instead of inventing a close', () => {
    const body = INVOKE('run_shell_command', PARAM('command', 'ok'));
    const incomplete = body + `<${BAR}DSML${BAR} invoke name="write_file">`;
    expect(dsmlCallsToJson(incomplete)).toHaveLength(1);
  });
});

describe('SseFragmentParser DSML extraction', () => {
  it('dispatches a tool call emitted inside the THINK phase', () => {
    const dsml = `${CALLS_OPEN}${INVOKE(
      'run_shell_command',
      PARAM('command', "python3 -c 'x=1<2; print(x)'"),
    )}${CALLS_CLOSE}`;
    const parser = new SseFragmentParser();
    let parts = parser.feedPayload(
      JSON.stringify({
        p: 'response/fragments',
        o: 'APPEND',
        v: [{ type: 'THINK', content: '' }],
      }),
    );
    for (let i = 0; i < dsml.length; i += 7) {
      parts = parts.concat(
        parser.feedPayload(JSON.stringify({ v: dsml.slice(i, i + 7) })),
      );
    }
    parts = parts.concat(parser.flush());
    const toolCalls = parts.filter((p) => p.kind === 'tool_call');
    expect(toolCalls).toHaveLength(1);
    expect(JSON.parse(toolCalls[0].text).arguments.command).toContain('1<2');
  });

  it('extracts the call even when </calls> never arrives', () => {
    const dsml = `${CALLS_OPEN}${INVOKE(
      'run_shell_command',
      PARAM('command', 'echo done'),
    )}`;
    const parser = new SseFragmentParser();
    const parts = parser
      .feedPayload(
        JSON.stringify({
          p: 'response/fragments',
          o: 'APPEND',
          v: [{ type: 'RESPONSE', content: dsml }],
        }),
      )
      .concat(parser.flush());
    expect(parts.filter((p) => p.kind === 'tool_call')).toHaveLength(1);
  });
});
