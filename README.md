# dsh-claude-cli

Use the Claude Code CLI you already have installed as a DeepSeek Harness LLM provider.

No API key. The plugin runs `claude` as a subprocess and streams its output back through the harness's LLM seam, so requests authenticate as whatever `claude` is already logged in as — a login you should check your plan's [usage terms](#usage-terms) against before automating.

The harness stays the agent. The CLI's own agent loop, tools, settings, memory files, and MCP servers are all switched off; what is left is the model call, driven by the harness's system prompt, history, and tools.

## Install

Requires a working `claude` on `PATH` ([Claude Code](https://claude.com/claude-code)), Node `^22.19 || >=24`, and a harness with `@deepseek-ai/dsh-llm`.

Install it into the profile you actually run, pointing at your checkout of this repository. The package declares `dsh.bundle`, so it joins that profile's layer stack and the `anthropic-claude-cli` route is composed on every start:

```bash
dsh plugin --profile web add ../dsh-claude-cli
```

A path relative to where you run the command is fine here. This plugin is not on npm, so the directory is the only way to install it today.

Restart the harness afterwards — a profile's layer stack is read at startup, so a running server keeps the composition it booted with. The models then appear under **Claude Code CLI** in the model picker.

### Invoking `dsh`

The commands here assume `dsh` resolves. How you reach it depends on how the harness is installed:

| Harness install | Command |
| --- | --- |
| Global | `dsh …` |
| Source checkout | `pnpm dsh …` |
| Neither | `npx @deepseek-ai/dsh …` |

Use the **scoped** name with `npx`. Unscoped `dsh` on npm is an unrelated JavaScript shell, last published in 2022.

That said, the third row is the odd one: this is a plugin for a harness, so a profile to install it into has to exist already. If you have never run `dsh`, install the harness first rather than reaching for `npx`.

<details>
<summary><b>Without installing</b> — run it once from a <code>--patch</code> overlay</summary>

<br>

`cordis.yml` is a standalone `--patch` overlay for trying the plugin in one run, or for a profile you would rather not modify. Replace the placeholder path in it with this directory's absolute path — plugin paths in a patch must be absolute, because a patch contributes configuration without changing the directory the loader resolves module paths from.

```bash
dsh --profile headless --patch /absolute/path/to/dsh-claude-cli/cordis.yml "your task"
```

Unlike the bundle layer, that overlay also repoints `agent-default-model` at `anthropic-claude-cli`, so the one-shot run uses it without a model picker.

</details>

## How tool calls work

The CLI has no "here are some tools, hand their calls back to me" mode, so the plugin declares the harness's tools to it as an MCP server (`bridge.mjs`). The model then emits real `tool_use` blocks with provider-validated arguments, which the plugin translates into harness `tool-call` chunks.

The bridge never executes anything. The harness owns tool execution. The plugin ends the request the moment the model's message ends, so the CLI process is gone before it could dispatch a call of its own.

```
harness request ──▶ claude --print ──▶ model
                         │                │
                    bridge.mjs ◀──────────┘  (tool schemas only)
                         │
harness chunks ◀─────────┘  tool_use → tool-call → the harness runs the tool
```

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `providers` | `['anthropic-claude-cli']` | Provider routes this adapter serves. |
| `executable` | `'claude'` | Path or command name of the CLI. |
| `cwd` | harness cwd | Working directory for the CLI process. |
| `streamIdleTimeoutMs` | `300000` | Maximum gap between CLI output lines before the request fails as `TIMEOUT`. |
| `unsupportedFields` | `'error'` | `error` rejects request fields the CLI cannot honor; `ignore` drops them. |
| `defaultEffort` | — | `low` \| `medium` \| `high` \| `xhigh` \| `max`, used when a request selects none. |
| `extraArgs` | `[]` | Extra arguments for CLI flags this plugin does not model. |

`extraArgs` is passed *before* the plugin's own flags, and an entry naming one of
them is rejected when the plugin loads. Both matter: the CLI keeps the last
occurrence of a repeated flag, so appended arguments would otherwise win. A
single `--tools default` was enough to restore the CLI's full tool set — `Bash`
and `Edit` included — inside the harness's working directory. Use `extraArgs` for
flags the plugin leaves alone, such as `--betas`.

Models are whatever the CLI accepts: the aliases `fable`, `opus`, `sonnet`, `haiku`, or a full id such as `claude-sonnet-5`. The catalog is advisory — an unlisted id is passed to `--model` unchanged.

## Limits

These follow from driving a CLI rather than an HTTP API, and are worth knowing before you switch a long session over to it.

- **No prompt caching between turns.** The harness is the source of truth for history — it compacts, edits, and replays messages the CLI never sees — so each request renders the harness history into one fresh turn. The model's view always equals the harness log, at the cost of re-reading the conversation every turn. Expect this to matter on long sessions and to count against your Claude usage limits.
- **`temperature`, `maxTokens`, and `stop` cannot be honored.** The CLI exposes no flag for any of them. They are reported as `UNSUPPORTED` by default rather than dropped silently; set `unsupportedFields: ignore` if your agent preset sets them for every route.
- **Images are not sent.** An image block renders as a visible placeholder in the transcript.
- **Prior reasoning is not replayed.** The provider discards unsigned thinking from history, so replaying it as text would only spend context.
- **No app-attribution header.** The harness's `attributionHeaders()` cannot reach requests the CLI makes on its own behalf.
- **Rate limits are the account's.** A subscription login is shared with your interactive Claude Code sessions. See [Usage terms](#usage-terms).

## Usage terms

Nothing here bypasses authentication. Requests run through the official CLI, as whatever `claude` is already logged in as, using the same documented `--print` mode Claude Code ships for non-interactive use.

What this plugin adds is different in kind: it makes a subscription login the model backend for *another* agent framework. Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) reserve programmatic access for API keys, saying you may not reach the services "through automated or non-human means, whether through a bot, script, or otherwise". Whether driving the CLI this way falls inside that sentence is Anthropic's call to make, not this README's.

Treat your own plan's terms and the [Usage Policy](https://www.anthropic.com/legal/aup) as the authority over anything written here. In particular:

- Prefer an API key and an HTTP provider for unattended, high-volume, or production traffic. This plugin suits work you would otherwise have run by hand in Claude Code.
- Reselling access, serving other people's requests, and evaluating the models to build a competing product are each separately prohibited, whichever credential you use.

## Development

```bash
npm test          # unit tests, no CLI or tokens needed
npm run test:e2e  # real CLI, spends real tokens
npm run typecheck
npm run build     # emit lib/ so the plugin loads under a released dsh
```

`src/` is what a source launch (`pnpm dsh`, which runs through tsx) loads; `lib/` is what a released `dsh` running plain Node loads. `npm run build` emits the second from the first, and `prepare` runs it on install.

The e2e suite self-skips when `claude` is not installed. It covers text streaming with usage ordering, a native tool call with valid JSON arguments, caller abort, and unsupported-field rejection.

| Module | Responsibility |
|---|---|
| `src/index.ts` | Plugin entry: config schema, adapter registration. |
| `src/adapter.ts` | `LlmAdapter` implementation, invocation assembly, model metadata. |
| `src/cli.ts` | Process lifecycle: line framing, idle watchdog, abort, teardown. |
| `src/protocol.ts` | The CLI's `stream-json` vocabulary, as parsed at the process boundary. |
| `src/translate.ts` | Wire events → harness `StreamChunk` protocol. |
| `src/render.ts` | Harness history → one CLI user turn. |
| `src/tools.ts` | Tool schemas → MCP bridge spec, and tool names back. |
| `src/models.ts` | Advisory model catalog and reasoning efforts. |
| `src/failure.ts` | CLI failures → provider-neutral `LlmFailure` codes. |
| `bridge.mjs` | The stdio MCP server the CLI launches. |

## License

MIT
