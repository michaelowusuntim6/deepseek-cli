```
================================
     DeepSeek CLI
================================
A terminal-based coding agent for the DeepSeek web chat.
Made by Michael Owusu Ntim.
```

# DeepSeek CLI

A terminal-based coding agent for the DeepSeek web chat.

Made by Michael Owusu Ntim.

DeepSeek CLI is a terminal coding agent: you type a request, it plans, calls
tools (shell, file reads/writes, search), reads the results, and answers — all
backed by the DeepSeek web chat.

Forked from the Apache-2.0 licensed Gemini CLI. All Gemini branding has been
removed; the underlying agent loop remains.

## Features

- **deepseek-web provider** (default): talks to the DeepSeek web chat without
  any Google account or API key.
- **Thinking toggle** (`/thinking`, default off): DeepThink reasoning via the
  `thinking_enabled` payload flag.
- **Web-search toggle** (`/search`, default on): DeepSeek's built-in web search
  via the `search_enabled` payload flag.
- **YOLO default**: tool calls auto-approve out of the box (`security.autoApprove`,
  default `true`).
- **Resume and session persistence**: every run writes a session under the CLI
  temp directory (`~/.deepseek/tmp/<project>/chats/`); resume with `--resume latest`.
- **DEEPSEEK.md context**: project context is loaded from `DEEPSEEK.md`, with
  `GEMINI.md` still honored as a fallback for upstream projects.
- **Multi-step tool use**: read files, run shell commands, write and modify
  files, recover from errors, and follow up on results.
- **Two models**: `deepseek-chat` (fast) and `deepseek-expert` (default,
  thinking available).

## Installation

From this repository:

```bash
cd /path/to/this/repository
npm install
npm run build
node packages/cli/dist/index.js
```

## Usage

Interactive mode:

```bash
node packages/cli/dist/index.js
```

Headless (one-shot) mode:

```bash
node packages/cli/dist/index.js --skip-trust -y -p "List the files in ~/CLI_harnesses/"
```

Resume the most recent session:

```bash
node packages/cli/dist/index.js --skip-trust -y --resume latest -p "What did we decide?"
```

Useful slash commands:

| Command      | What it does                                            |
| ------------ | ------------------------------------------------------- |
| `/model`     | Open the model picker (`deepseek-chat`, `deepseek-expert`) |
| `/provider`  | Show or switch the backend                              |
| `/thinking`  | On/Off picker for DeepThink reasoning                   |
| `/search`    | On/Off picker for DeepSeek web search                   |
| `/compress`  | Compress the chat history                               |

## Configuration

Settings live in `~/.deepseek/settings.json`. The DeepSeek-relevant block:

```json
{
  "security": {
    "auth": { "selectedType": "deepseek-web" },
    "autoApprove": true
  },
  "model": { "name": "deepseek-expert" },
  "deepseek": {
    "thinking": false,
    "webSearch": true
  }
}
```

`deepseek.thinking` and `deepseek.webSearch` are written by the `/thinking` and
`/search` pickers. A project can also drop a `DEEPSEEK.md` file in its root to
feed context to the agent.

### Local providers (inert)

The fork also ships two optional OpenAI-compatible backends — an
`openai-compatible` provider and a `llamacpp` provider. They are **off by
default**, do not appear in the picker unless explicitly configured, and are
kept for future use. To enable one, add a `providers` block to
`~/.deepseek/settings.json` and point `security.auth.selectedType` at it.

## Licence

Apache License 2.0. See [LICENSE](LICENSE).

Apache License 2.0. See [LICENSE](LICENSE) for the full text and notices.
