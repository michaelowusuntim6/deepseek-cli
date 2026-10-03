/**
 * @license
 * DeepSeek proof-of-work solver.
 *
 * Port of DeepSeek-API/deepseek/pow.py. DeepSeek gates
 * POST /api/v0/chat/completion behind an `x-ds-pow-response` header; the
 * algorithm ("DeepSeekHashV1") ships as the website's own
 * sha3_wasm_bg.wasm. The module is self-contained (no WASI imports), so
 * Node's built-in WebAssembly can drive it exactly like wasmtime does in
 * Python.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const WASM_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'sha3_wasm_bg.wasm',
);

export interface PowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  signature: string;
  target_path: string;
  difficulty: number;
  expire_at: number;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  wasm_solve: (
    retptr: number,
    challengePtr: number,
    challengeLen: number,
    prefixPtr: number,
    prefixLen: number,
    difficulty: number,
  ) => void;
  __wbindgen_export_0: (size: number, align: number) => number;
  __wbindgen_add_to_stack_pointer: (delta: number) => number;
}

export class DeepSeekPow {
  private constructor(private readonly exports: WasmExports) {}

  static async load(wasmPath: string = WASM_PATH): Promise<DeepSeekPow> {
    const bytes = fs.readFileSync(wasmPath);
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new DeepSeekPow(instance.exports as unknown as WasmExports);
  }

  private writeString(text: string): { ptr: number; len: number } {
    const data = Buffer.from(text, 'utf-8');
    const ptr = this.exports.__wbindgen_export_0(data.length, 1);
    new Uint8Array(this.exports.memory.buffer, ptr, data.length).set(data);
    return { ptr, len: data.length };
  }

  solve(challenge: string, prefix: string, difficulty: number): number | null {
    const retptr = this.exports.__wbindgen_add_to_stack_pointer(-16);
    try {
      const c = this.writeString(challenge);
      const p = this.writeString(prefix);
      this.exports.wasm_solve(retptr, c.ptr, c.len, p.ptr, p.len, difficulty);
      const view = new DataView(this.exports.memory.buffer, retptr, 16);
      const status = view.getInt32(0, true);
      const value = view.getFloat64(8, true);
      if (status === 0) {
        return null;
      }
      return Math.trunc(value);
    } finally {
      this.exports.__wbindgen_add_to_stack_pointer(16);
    }
  }

  /** base64 `x-ds-pow-response` header value for a challenge dict. */
  makeHeader(challenge: PowChallenge): string {
    const prefix = `${challenge.salt}_${challenge.expire_at}_`;
    const answer = this.solve(
      challenge.challenge,
      prefix,
      challenge.difficulty,
    );
    if (answer === null) {
      throw new Error('PoW solver returned no answer (challenge expired?)');
    }
    const payload = {
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
      target_path: challenge.target_path,
    };
    return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');
  }
}

let cached: Promise<DeepSeekPow> | undefined;

export function getPowSolver(
  wasmPath: string = WASM_PATH,
): Promise<DeepSeekPow> {
  if (!cached) {
    cached = DeepSeekPow.load(wasmPath);
  }
  return cached;
}
