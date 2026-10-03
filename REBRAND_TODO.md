# REBRAND_TODO — classification + raw test output

## Phase 1 — inventory results (2026-10-03)

```
1.1 cli/src  "Gemini|GEMINI|gemini" hits (no tests): 2523
1.2 core/src "Gemini|GEMINI|gemini" hits (no tests): 2168
1.3 model names: gemini-3-pro-preview, gemini-3-flash-preview,
    gemini-3.1-pro-preview, gemini-2.5-computer-use-preview-10-2025
    (packages/core/src/config/defaultModelConfigs.ts, config/config.ts,
     agents/browser/modelAvailability.ts)
1.4 brand strings: "Gemini CLI" in ~20 user-visible places (help, banners,
    warnings, notifications); thousands of `@google/gemini-cli-core` imports
1.5 YOLO: packages/cli/src/config/config.ts:87,258,333,343;
    packages/cli/src/acp/acpUtils.ts:237 (ApprovalMode.YOLO)
1.6 resume: packages/cli/src/gemini.tsx:320-414, interactiveCli.tsx:61,119
```

## Classification table

| Category | Examples | Decision |
| --- | --- | --- |
| (a) user-visible strings | `config/config.ts:170` "Gemini CLI - Defaults to interactive…", `acp/commands/help.ts:30`, `acp/commands/about.ts:63`, `utils/windowTitle.ts:47`, `utils/handleAutoUpdate.ts:42`, `utils/terminalNotifications.ts:50-66`, `utils/userStartupWarnings.ts:54-99`, `config/extensions/extensionSettings.ts:38`, `config/settingsSchema.ts:576,596`, `commands/hooks.tsx:14`, `commands/extensions.tsx:24`, `commands/hooks/migrate.ts:277` | **rebrand** to "DeepSeek CLI" |
| (d) logo / banner / branding | `packages/cli/src/ui/components/AsciiArt.ts`, `Header.tsx`, `AppHeader.tsx` (Gemini ASCII art + name line) | **rebrand**: DeepSeek text banner + "Made by Michael Owusu Ntim" |
| (c) Google-specific code, inert | `packages/core/src/code_assist/*`, Vertex/ADC/gateway auth, `commands/gemma.ts`, `agents/browser/*` visual agent, `@google/genai` client paths | leave in place, unreachable while `deepseek-web` is selected |
| (b) internal identifiers | package names `@google/gemini-cli-core` / `@google/gemini-cli`, `GEMINI_*` env vars, `.gemini/` dir, `AuthType.USE_GEMINI`, `gemini.tsx` filenames, model-config keys | leave untouched (rebasing) |

Model names (`gemini-3*`) are class (b)/model-config internals: they stay in
`defaultModelConfigs.ts` so rebases keep working, but the `/model` picker is
changed to offer only `deepseek-chat` / `deepseek-expert`.

## Phase 2 — raw test output

```
$ npm run build
Successfully copied files.
build exit=0          # 0 "error TS" lines

$ node packages/cli/dist/index.js --help | head -3
Usage: deepseek [options] [command]

DeepSeek CLI - Defaults to interactive mode. Use -p/--prompt for non-interactive (headless) mode.

$ node packages/cli/dist/index.js --help | grep -c -i gemini
1                     # only the geminicli.com docs URL in --allowed-tools

$ node packages/cli/dist/index.js --version
DeepSeek CLI 0.64.0-nightly.20260929.gd75234cae

$ node packages/cli/dist/index.js --skip-trust -y -p "Reply with exactly: ready"
YOLO mode is enabled. All tool calls will be automatically approved.
ready
```

Sources changed: `ui/components/AsciiArt.ts` (all six exports now spell
DEEPSEEK / "DEEPSEEK CLI"), `ui/components/AppHeader.tsx` ("DeepSeek CLI
v<version>" + "Made by Michael Owusu Ntim"), 40 files with user-visible
"Gemini CLI" → "DeepSeek CLI", `config/config.ts` (`scriptName('deepseek')`,
`--version` prefix, usage string, `--worktree` help).

## Phase 2.9 — residual Google URLs

```
$ rg -n "geminicli.com" packages/cli/src --type ts | grep -v '\.test\.' | wc -l
0
$ rg -n "geminicli.com" packages/cli/src --type ts | wc -l
6        # all inside *.test.ts snapshots, deliberately untouched
```

13 user-visible `https://geminicli.com/...` links were replaced with neutral
text ("the DeepSeek CLI documentation") across `gemini.tsx`,
`acp/commands/extensions.ts`, `config/settings-validation.ts`,
`config/extensionRegistryClient.ts`, `ui/constants.ts`,
`ui/privacy/CloudFreePrivacyNotice.tsx`, `ui/auth/AuthDialog.tsx`,
`ui/commands/extensionsCommand.ts`, `ui/components/HooksDialog.tsx`,
`utils/userStartupWarnings.ts`, `config/settingsSchema.ts`, `config/config.ts`.
The first pass swallowed closing quotes (regex `\S*`); repaired and rebuilt.

## Phase 3 — payload test output

```
$ DEBUG_DEEPSEEK=1 node packages/cli/dist/index.js --skip-trust -y -p "hi" | grep -m1 payload
[payload] {"chat_session_id":"3798a1d5-...","parent_message_id":null,"prompt":"You are DeepSeek CLI, an autonomous CLI agent ...","thinking_enabled":false,"search_enabled":true,...}

thinking_enabled = False
search_enabled   = True
```

`deepseek.thinking` / `deepseek.webSearch` live in the settings schema
(`config/settingsSchema.ts`) and are read per request by
`readDeepSeekSettings()` in `core/deepseekContentGenerator.ts`; env overrides
are `DEEPSEEK_THINKING=1` and `DEEPSEEK_WEB_SEARCH=0`. `security.autoApprove`
(default true) was added to the same schema for Phase 4.

Also rebranded in this phase: `packages/core/src/prompts/snippets.ts` —
the model-facing system prompt now starts "You are DeepSeek CLI, ...".
