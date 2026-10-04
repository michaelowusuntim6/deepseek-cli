/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  SseFragmentParser,
  dsmlCallsToJson,
  looksLikeBrokenToolCall,
} from './sse.js';

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

  it('accepts compact tags without the fullwidth DSML prefix', () => {
    // The open invoke is qualified, the parameter/close tags are not.
    const compact = `<${BAR}DSML${BAR} invoke name="run_shell_command">\n<parameter name="command">ls -la /tmp</parameter>\n</invoke>`;
    const calls = dsmlCallsToJson(compact);
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments['command']).toBe('ls -la /tmp');
  });

  it('maps nested invoke blocks to parameters', () => {
    const nested = `<${BAR}DSML${BAR} invoke name="read_file"><${BAR}DSML${BAR} invoke name="file_path">/tmp/x.txt</${BAR}DSML${BAR} invoke></${BAR}DSML${BAR} invoke>`;
    const calls = dsmlCallsToJson(nested);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read_file');
    expect(calls[0].arguments['file_path']).toBe('/tmp/x.txt');
  });

  it('SHAPE A: no <calls> opener, stray </invoke>, nested invoke params', () => {
    const shapeA = [
      INVOKE('summary', 'text'),
      `</${BAR}DSML${BAR} invoke>`,
      `<${BAR}DSML${BAR} invoke name="run_shell_command">`,
      `<${BAR}DSML${BAR} invoke name="command">ls -la</${BAR}DSML${BAR} invoke>`,
      `</${BAR}DSML${BAR} invoke>`,
      `</${BAR}DSML${BAR} calls>`,
    ].join('\n');
    const calls = dsmlCallsToJson(shapeA);
    expect(calls.map((c) => c.name)).toContain('run_shell_command');
    const shell = calls.find((c) => c.name === 'run_shell_command');
    expect(shell?.arguments['command']).toBe('ls -la');
  });

  it('SHAPE B: no named opener -> zero calls, broken flag true', () => {
    const shapeB = [
      `</${BAR}DSML${BAR} invoke>`,
      `</${BAR}DSML${BAR} invoke name="run_shell_command">`,
      `<${BAR}DSML${BAR} invoke>`,
    ].join('\n');
    expect(dsmlCallsToJson(shapeB)).toHaveLength(0);
    expect(looksLikeBrokenToolCall(shapeB)).toBe(true);
  });

  it('SHAPE C: well-formed multi-invoke batch -> 2 calls', () => {
    const shapeC = `${CALLS_OPEN}\n${INVOKE(
      'read_file',
      PARAM('path', '/a'),
    )}\n${INVOKE(
      'run_shell_command',
      PARAM('command', 'ls'),
    )}\n${CALLS_CLOSE}`;
    const calls = dsmlCallsToJson(shapeC);
    expect(calls).toHaveLength(2);
    expect(calls[0].arguments['path']).toBe('/a');
    expect(calls[1].arguments['command']).toBe('ls');
  });

  it('tolerates single-bar namespaces and stray slashes on openers', () => {
    // Shapes observed live: `</｜DSML｜｜ invoke name="X">` as the OPENER and
    // `</｜DSML｜｜ parameter ...>` as a parameter opener; one pipe instead of two.
    const fw = '\uFF5C';
    const messy = [
      `</${fw}DSML${fw}${fw} invoke name="run_shell_command">`,
      `</${fw}DSML${fw}${fw} parameter name="command" string="true">ls -la /tmp</${fw}DSML${fw}${fw} parameter>`,
      `</${fw}DSML${fw}${fw} invoke>`,
      `</${fw}DSML${fw}${fw} calls>`,
    ].join('\n');
    const calls = dsmlCallsToJson(messy);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('run_shell_command');
    expect(calls[0].arguments['command']).toBe('ls -la /tmp');
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

  it('tolerates duplicated/out-of-order <calls> wrappers (3 calls)', () => {
    const batch =
      INVOKE('run_shell_command', PARAM('command', 'ls -la /tmp')) +
      `\n${CALLS_OPEN}\n` +
      INVOKE('run_shell_command', PARAM('command', 'cat /etc/hostname')) +
      `\n${CALLS_CLOSE}\n` +
      INVOKE('run_shell_command', PARAM('command', 'echo done')) +
      `\n${CALLS_CLOSE}`;
    const parser = new SseFragmentParser();
    const parts = parser
      .feedPayload(
        JSON.stringify({
          p: 'response/fragments',
          o: 'APPEND',
          v: [{ type: 'RESPONSE', content: batch }],
        }),
      )
      .concat(parser.flush());
    const calls = parts
      .filter((p) => p.kind === 'tool_call')
      .map((p) => JSON.parse(p.text));
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.arguments.command)).toEqual([
      'ls -la /tmp',
      'cat /etc/hostname',
      'echo done',
    ]);
  });
});
