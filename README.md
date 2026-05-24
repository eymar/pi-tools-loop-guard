# LoopGuard — Pi Extension

Detects and blocks repetitive tool calls within a single user interaction. Prevents the agent from wasting tokens and time calling the same tool with identical arguments repeatedly.

## Features

- **Cumulative loop detection** — tracks `toolName + serialized args` across all tool calls in a user interaction (catches A-B-A-B loops).
- **Enabled by default** — disable with `/loopguard off`.
- **State-aware** — resets read counters after `write`/`edit` (avoids false positives when re-reading modified files).
- **Per-tool thresholds** — different tools have different repeat limits (see table below).

## Install

```bash
# From git
pi install git:github.com/eymar/pi-tools-loop-guard

# Try without installing
pi -e git:github.com/eymar/pi-tools-loop-guard
```

## Usage

```
/loopguard          # Show status
/loopguard on       # Enable
/loopguard off      # Disable
/loopguard status   # Show current status and thresholds
```

## Default Thresholds

| Tool | Allowed Calls | Steer On | Block On |
|------|-------------|----------|----------|
| `fetch_content` | 2 | 3rd | 4th |
| `web_search` | 2 | 3rd | 4th |
| `code_search` | 2 | 3rd | 4th |
| `read` / `ctx_read` | 3 | 4th | 5th |
| `ctx_grep` / `ctx_find` | 3 | 4th | 5th |
| `bash` | 5 | 6th | 7th |
| default | 3 | 4th | 5th |

## How It Works

1. **Key Derivation:** Each tool call is keyed as `toolName::sortedArgsJSON` (volatile fields like `timeout` and `toolCallId` are stripped).
2. **Cumulative Tracking:** Counts are tracked in a `Map`. Unlike simple consecutive detection, LoopGuard maintains history for the entire user interaction (catches A-B-A-B loops).
3. **Turn Reset:** Counters reset when a new user message is detected, ensuring protection throughout long autonomous tool-call chains.
4. **Steer then block:** When a tool reaches its threshold, a specific steering message is injected telling the model which tool/args to stop calling. If the model retries anyway, the next call is blocked. The threshold means "allow this many calls" — so a threshold of 2 means 2 successful calls, then steer on the 3rd, then block on the 4th.
5. **Modification Awareness:** After `write` or `edit`, read counters for the specifically modified file are cleared, allowing the agent to verify its changes immediately.

## Known Limitations

- **Subagent counters are isolated** — when installed globally, subagents have their own independent LoopGuard counters. The main agent's and a subagent's counts do not share state, so each can independently hit the threshold.
- **Exact-match only** — `read({path: "a.ts", offset: 1})` and `read({path: "a.ts", offset: 2})` are counted separately.
- **Failed calls counted the same as successful ones** — if `bash("npm install")` fails and the model retries, it's counted as a repeat. Retries after errors may trigger false blocks.

## Roadmap

- Argument normalization (fuzzy matching for bash commands)
- Model-adaptive thresholds (lower for small local models, higher for cloud models)
- Result similarity checking (block if the *output* is identical, even if args differ)
- Cross-session config persistence (`settings.json`)

## License

MIT
