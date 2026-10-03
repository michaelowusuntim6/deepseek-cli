/**
 * @license
 * DeepSeek session capture — port of DeepSeek-API/deepseek/auth.py.
 *
 * The session is the bearer token + cookies captured from a signed-in
 * chat.deepseek.com tab. Two refresh paths, in order:
 *
 *   1. Node Playwright, driving the same persistent Chromium profile the
 *      Python client uses (headless, no window).
 *   2. The Python refresher from the bundled DeepSeek-API copy, which ships
 *      the profile and already works. Used when the Playwright package or its
 *      browsers are unavailable.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface Session {
  token: string;
  cookies: Record<string, string>;
  userAgent: string;
  capturedAt: number;
}

export const SESSION_MAX_AGE_SECONDS = 6 * 60 * 60;
export const CHAT_URL = 'https://chat.deepseek.com/';

interface MinimalPage {
  evaluate(js: string): Promise<unknown>;
}

interface MinimalContext {
  pages(): MinimalPage[];
  newPage(): Promise<MinimalPage>;
  cookies(): Promise<Array<{ name: string; value: string }>>;
  close(): Promise<void>;
}

interface ChromiumLike {
  launchPersistentContext(
    dir: string,
    opts: Record<string, unknown>,
  ): Promise<MinimalContext>;
}

export function candidateSessionFiles(): string[] {
  const files: string[] = [];
  if (process.env['DEEPSEEK_SESSION_FILE']) {
    files.push(process.env['DEEPSEEK_SESSION_FILE']);
  }
  files.push(
    path.join(os.homedir(), 'DeepSeek-API', 'session', 'session.json'),
    path.join(
      os.homedir(),
      'CLI_harnesses',
      'DeepSeek-API',
      'session',
      'session.json',
    ),
    path.join(os.homedir(), '.deepseek-cli', 'session.json'),
  );
  return files;
}

export function loadSession(file?: string): Session | null {
  const paths = file ? [file] : candidateSessionFiles();
  for (const candidate of paths) {
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      if (raw && typeof raw.token === 'string' && raw.token) {
        return {
          token: raw.token,
          cookies: raw.cookies ?? {},
          userAgent: raw.user_agent ?? raw.userAgent ?? '',
          capturedAt: raw.captured_at ?? raw.capturedAt ?? 0,
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function sessionAgeSeconds(session: Session): number {
  return Date.now() / 1000 - session.capturedAt;
}

function pythonProjectDir(): string | null {
  for (const dir of [
    path.join(os.homedir(), 'DeepSeek-API'),
    path.join(os.homedir(), 'CLI_harnesses', 'DeepSeek-API'),
  ]) {
    if (fs.existsSync(path.join(dir, 'deepseek', 'auth.py'))) {
      return dir;
    }
  }
  return null;
}

/** Refresh via the Python refresher (profile + WAF handling already work). */
function refreshViaPython(): Session | null {
  const project = pythonProjectDir();
  if (!project) {
    return null;
  }
  const python = path.join(project, 'venv', 'bin', 'python');
  if (!fs.existsSync(python)) {
    return null;
  }
  const script = [
    'import json, sys',
    'from deepseek.auth import get_session',
    's = get_session(allow_interactive=True)',
    'print(json.dumps({"token": s.token, "cookies": s.cookies,',
    '                  "user_agent": s.user_agent, "captured_at": s.captured_at}))',
  ].join('\n');
  const result = spawnSync(python, ['-c', script], {
    cwd: project,
    encoding: 'utf-8',
    timeout: 180_000,
  });
  if (result.status !== 0) {
    return null;
  }
  const line = (result.stdout ?? '').trim().split('\n').pop() ?? '';
  try {
    const raw = JSON.parse(line);
    return {
      token: raw.token,
      cookies: raw.cookies ?? {},
      userAgent: raw.user_agent ?? '',
      capturedAt: raw.captured_at ?? Date.now() / 1000,
    };
  } catch {
    return null;
  }
}

/** Refresh with Node Playwright against the persistent profile. */
async function refreshViaPlaywright(): Promise<Session | null> {
  const profile = path.join(os.homedir(), 'DeepSeek-API', 'session', 'profile');
  if (!fs.existsSync(profile)) {
    return null;
  }
  let chromium: ChromiumLike;
  try {
    // Non-literal specifier: playwright is optional (the Python refresher is
    // the fallback), so TypeScript must not require the module to exist.
    const specifier = 'playwright';
    const mod = (await import(specifier)) as { chromium: ChromiumLike };
    chromium = mod.chromium;
  } catch {
    return null;
  }
  try {
    const context = await chromium.launchPersistentContext(profile, {
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.evaluate(`() => { window.location.href = '${CHAT_URL}'; }`);
      const token = (await page.evaluate(`
        () => {
          const raw = window.localStorage.getItem('userToken');
          if (!raw) return null;
          try { const o = JSON.parse(raw); return o && o.value ? o.value : null; }
          catch (e) { return null; }
        }
      `)) as string | null;
      if (!token) {
        return null;
      }
      const cookies = await context.cookies();
      const userAgent = (await page.evaluate(
        '() => navigator.userAgent',
      )) as string;
      return {
        token,
        cookies: Object.fromEntries(cookies.map((c) => [c.name, c.value])),
        userAgent,
        capturedAt: Date.now() / 1000,
      };
    } finally {
      await context.close();
    }
  } catch {
    return null;
  }
}

export interface GetSessionOptions {
  maxAgeSeconds?: number;
  file?: string;
  allowRefresh?: boolean;
}

/** Return a usable session, refreshing it when it is older than maxAge. */
export async function getSession(
  options: GetSessionOptions = {},
): Promise<Session> {
  const maxAge = options.maxAgeSeconds ?? SESSION_MAX_AGE_SECONDS;
  const current = loadSession(options.file);
  if (current && sessionAgeSeconds(current) < maxAge) {
    return current;
  }
  if (options.allowRefresh === false) {
    if (current) {
      return current;
    }
    throw new Error(
      'No DeepSeek session found. Run `python -m deepseek.auth` once to sign in.',
    );
  }
  const refreshed = (await refreshViaPlaywright()) ?? refreshViaPython();
  if (refreshed) {
    return refreshed;
  }
  if (current) {
    return current; // stale but usable; the server decides
  }
  throw new Error(
    'No DeepSeek session found. Run `python -m deepseek.auth` once to sign in.',
  );
}
