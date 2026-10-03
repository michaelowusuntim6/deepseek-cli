# DeepSeek CLI — remaining Gemini references + live-test bugs

Last updated: 2026-10-03
Branch: main (do not push)
Build: `node scripts/build.js` → exit 0, 0 TS errors

- [x] Fix 1 — duplicate request per turn
  - `deepseekContentGenerator.ts`: the main thread sends the system instruction
    and tool list only on the FIRST request (`!this.conversationId`); follow-ups
    send only the newest user text.
  - Utility roles (summarizer/compressor/router/…) now run in their own DeepSeek
    thread (`utilityConversationId`) and never receive the system instruction or
    tool list. This is what produced the "same system prompt appears as a new
    user message" symptom.
  - Debug log (`DEBUG_DEEPSEEK=1`):
    `[deepseek-request] turn=1 reason=main prompt_chars=51030`
    `grep -c '[deepseek-request]' /tmp/fix-a.log` → **1**
- [x] Fix 2 — `/thinking` and `/search` are now On/Off pickers
  - New `BooleanSettingDialog.tsx` (On / Off, current value marked, Esc cancels)
    wired through `custom_dialog` from `thinkingCommand.tsx` and
    `searchCommand.tsx`.
  - Real TUI frame (`-i /thinking`, 150 cols):
    `DeepSeek DeepThink` … `1. On` / `● 2. Off (current)` … `Esc to cancel`.
  - Selecting On wrote `~/.gemini/settings.json` → `"thinking": true`.
  - Reopening with thinking on shows `● 1. On (current)`.
  - Unit test `BooleanSettingDialog.test.tsx` → 4 passed.
- [x] Fix 3 — exit summary says `deepseek --resume`
  - `SessionSummaryDisplay.tsx` → `To resume this session: deepseek --resume <id>`
    (real TUI exit frame shows `deepseek --resume a416572e-…`; no `gemini --resume`).
- [x] Fix 4 — no `gemini-*` model names in the usage table
  - `loggingContentGenerator.ts` maps any `gemini-*` request model to
    `deepseek-chat` when `security.auth.selectedType === 'deepseek-web'`.
  - `/stats` output: `deepseek-chat ↳ utility_summarizer`, `deepseek-expert`;
    zero `gemini-*` model names.
- [x] Fix 5 — `/compress` output
  - Compress path has no "Gemini CLI" strings; live `/compress` run shows
    "Compressing chat history" / "not beneficial for this history size".
- [x] Fix 6 — session context wrapper
  - `environmentContext.ts` → `This is DeepSeek CLI. We are setting up the context
    for our chat.` Confirmed in the real request payload (`grep -c` → 1).
- [x] Fix 7 — single YOLO banner
  - `config.ts` guards the notice with a module flag (config is loaded twice per
    process). `grep -c "YOLO mode is enabled"` → **1**.
- [x] Fix 8 — README rebranded
  - New DeepSeek CLI README (no banner image, no Google links).
    `grep -c "Gemini CLI\|@google/gemini-cli\|google.github.io" README.md` → 0.
- [x] Fix 9 — broad sweep (decisions)
  - Rebranded user-visible strings: `models.ts` auto-model description,
    `cli-help-agent.ts`, browser input-blocker label, IDE connecting errors,
    MCP client names, git shadow-repo author, internal-docs tool text,
    auth-consent/oauth messages, compatibility warning.
  - Rebranded `/skills` descriptions in `.gemini/skills/**` and
    `packages/core/src/skills/builtin/**` (they show in the composer and the
    system prompt).
  - Left as internal / not user-visible: `GEMINI_CLI_COMPANION_EXTENSION_NAME`
    (IDE contract), `@google/gemini-cli-*` package names, `GEMINI_*` env vars,
    `.gemini/` paths, `GeminiCodeAssist*` classes, code comments, extension-example
    READMEs, Windows sandbox helper comments, macOS sandbox profile comments.
  - `node packages/cli/dist/index.js --help | grep -ci gemini` → 0.
- [x] Fix 10 — rebuild + integration tests A–I (all green, outputs in chat).
- [x] Commit (no push).
