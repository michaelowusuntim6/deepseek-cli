# Slash commands after the DeepSeek port

Source of truth: `packages/cli/src/ui/commands/*Command.ts` (44 command
modules, each exporting `SlashCommand` objects registered as `BUILT_IN`).
Nothing was deleted: Google-specific commands stay in place but are inert
unless a Google auth type is selected.

| Command | Action | Status |
| --- | --- | --- |
| `/about` | Version + build info | kept |
| `/agents` | Manage AGENTS.md context | kept |
| `/auth` | Choose / switch auth type | **renamed (behaviour)** — now defaults to `deepseek-web`; the Google entries remain selectable but are not the default |
| `/bug` | File a bug report | kept |
| `/bugMemory` | Inspect memory used by the bug reporter | kept |
| `/chat` | Save / resume chat checkpoints | kept |
| `/clear` | Clear the screen | kept |
| `/commands` | List available commands | kept |
| `/compress` | Compress conversation context | kept |
| `/copy` | Copy the last answer | kept |
| `/corgi` | Easter egg | kept |
| `/docs` | Open documentation | kept |
| `/editor` | Choose external editor | kept |
| `/exportSession` | Export the transcript | kept |
| `/extensions` | Manage extensions | kept |
| `/gemmaStatus` | Local Gemma routing status | kept (inert unless Gemma is configured) |
| `/help` | Help | kept |
| `/hooks` | Manage hooks | kept |
| `/ide` | IDE integration | kept |
| `/init` | Create GEMINI.md context file | kept |
| `/mcp` | Manage MCP servers | kept |
| `/memory` | Show / edit memory | kept |
| `/model` | Choose model | **renamed (behaviour)** — model list still Gemini names; the DeepSeek provider resolves any name to its own backend, and the project settings pin `deepseek-expert`. Selecting a Gemini model name has no effect while `deepseek-web` is selected. Uncertain — kept. |
| `/permissions` | Permission settings | kept |
| `/plan` | Toggle plan mode | kept |
| `/policies` | Policy files | kept |
| `/privacy` | Privacy notice | kept |
| `/profile` | Profile settings | kept |
| `/quit` | Exit | kept |
| `/restore` | Restore a checkpoint | kept |
| `/resume` | Resume a session | kept |
| `/settings` | Settings editor | kept |
| `/setupGithub` | GitHub Actions setup | kept |
| `/shortcuts` | Keyboard shortcuts | kept |
| `/skills` | Manage skills | kept |
| `/stats` | Session statistics | kept |
| `/tasks` | Background tasks | kept |
| `/terminalSetup` | Terminal integration | kept |
| `/theme` | Theme picker | kept |
| `/tools` | List tools | kept — tool list is whatever the harness exposes to DeepSeek |
| `/upgrade` | Upgrade check | **removed in spirit** — kept in code, but it points at the Gemini CLI npm package, so it is marked inactive for this fork |
| `/vim` | Vim mode | kept |
| `/voice` | Voice input | kept |

## Uncertain / explicitly kept

* `/upgrade` — targets the upstream npm package; kept but not meaningful for a
  local fork. Left in place so upstream rebases stay clean.
* `/model` — the picker lists Gemini model names. The DeepSeek provider ignores
  them (it always talks to chat.deepseek.com); a follow-up should replace the
  list with DeepSeek model names (`default` / `expert`).
* `/gemmaStatus` — only relevant to Google's local Gemma routing.

## Added

No new slash commands were added. The DeepSeek provider is selected through
settings (`security.auth.selectedType = "deepseek-web"`, defaulted by
`getAuthTypeFromEnv()`), not through a command.

## Added in the rebrand

| Command | Action | Status |
| --- | --- | --- |
| `/thinking` (alias `/think`) | Toggle deepseek.thinking (default off); payload sends thinking_enabled | **added** |
| `/search` | Toggle deepseek.webSearch (default on); payload sends search_enabled | **added** |
| `/provider` | Show or switch backend: deepseek-web, openai-compatible, llamacpp | **added** |
| `/model` | Picker now offers deepseek-chat, deepseek-expert (+ the configured local provider model) | **rebranded** |
