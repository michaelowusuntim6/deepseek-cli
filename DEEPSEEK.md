# DeepSeek CLI Project Context

DeepSeek CLI is a terminal-first AI coding agent backed by DeepSeek's web chat,
porting the DeepSeek-API client (Playwright session capture, WebAssembly PoW
solver, SSE fragment parser) into this harness.

## Streaming discipline (read before every turn)

The DeepSeek stream has a length limit. Long turns get cut mid-response, and
the turn produces no useful output. To avoid this:

1. Read ONE file per turn. Never batch multiple read_file calls in a single
   response. Read the next file on the next turn.

2. Read files in 80-line chunks. To read a 300-line file:

   ```
   turn 1: read_file start_line=1   end_line=80
   turn 2: read_file start_line=81  end_line=160
   turn 3: read_file start_line=161 end_line=240
   turn 4: read_file start_line=241 end_line=300
   ```

3. For shell commands, always cap the output:

   ```
   find ... | head -50
   ls ... | head -20
   cat file | head -80
   ```

   Long command output cuts the stream.

4. Commit as soon as a fix passes. Do not do "one big commit at the end."
   Every completed fix gets its own commit.

5. If a turn ends because the budget was reached, the harness will tell you.
   Continue with the next single step. Do not re-read files you already read.

6. If a tool result is marked `[OUTPUT TRUNCATED: showing lines X-Y of Z]`,
   the file continues. Decide whether you need the rest before reading more.

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
