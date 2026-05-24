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

| Tool | Max Repeats |
|------|------------|
| `fetch_content` | 2 |
| `web_search` | 2 |
| `code_search` | 2 |
| `read` / `ctx_read` | 3 |
| `ctx_grep` / `ctx_find` | 3 |
| `bash` | 5 |
| default | 3 |

## How It Works

1. **Key Derivation:** Each tool call is keyed as `toolName::sortedArgsJSON` (volatile fields like `timeout` and `toolCallId` are stripped).
2. **Cumulative Tracking:** Counts are tracked in a `Map`. Unlike simple consecutive detection, LoopGuard maintains history for the entire user interaction (catches A-B-A-B loops).
3. **Turn Reset:** Counters reset when a new user message is detected, ensuring protection throughout long autonomous tool-call chains.
4. **Block:** When a tool exceeds its threshold, the call is blocked and the reason is injected into the context for the model to see.
5. **Modification Awareness:** After `write` or `edit`, read counters for the specifically modified file are cleared, allowing the agent to verify its changes immediately.

## Known Limitations

- **Subagent counters are isolated** — when installed globally, subagents have their own independent LoopGuard counters. The main agent's and a subagent's counts do not share state, so each can independently hit the threshold.
- **Exact-match only** — `read({path: "a.ts", offset: 1})` and `read({path: "a.ts", offset: 2})` are counted separately.

## Roadmap

- Argument normalization (fuzzy matching for bash commands)
- Model-adaptive thresholds (lower for small local models, higher for cloud models)
- Result similarity checking (block if the *output* is identical, even if args differ)
- Cross-session config persistence (`settings.json`)

## License

MIT
