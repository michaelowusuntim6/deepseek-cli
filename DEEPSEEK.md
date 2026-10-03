# DeepSeek CLI Project Context

DeepSeek CLI is a terminal-first AI coding agent backed by DeepSeek's web chat,
porting the DeepSeek-API client (Playwright session capture, WebAssembly PoW
solver, SSE fragment parser) into this harness.

## Providers

- `deepseek-web` (default) — chat.deepseek.com through the ported client.
- `openai-compatible` — any OpenAI-wire endpoint (llama.cpp, vLLM, ...).
- `llamacpp` — local llama.cpp server defaults.

## Models

- `deepseek-chat` — fast, non-thinking.
- `deepseek-expert` — default; DeepThink available via `/thinking`.

## Rules for agents working in this repo

- Do not delete Google source: hide it, keep rebasing on upstream cheap.
- Do not rename internal package names, `GEMINI_*` env vars or `.gemini/`.
- Tool calls run without approval by default (`security.autoApprove`).
- `DEEPSEEK.md` is the project context file; `GEMINI.md` is still read as a
  fallback for upstream projects.
