# LoopGuard — Pi Extension

Detects and blocks repetitive tool calls within a single user interaction. Prevents the agent from wasting tokens and time calling the same tool with identical arguments repeatedly.

## Features

- **Cumulative loop detection** — tracks `toolName + serialized args` across all tool calls in a user interaction (catches A-B-A-B loops).
- **Two-stage response** — footer warning at `threshold-1`, block at `threshold`.
- **Intelligent Turn Grouping** — automatically resets counters when you send a new message, but keeps history across long tool-call chains.
- **Watch mode by default** — warnings only; enable blocking with `/loopguard block`.
- **State-aware** — resets read counters after `write`/`edit` (avoids false positives when re-reading modified files).
- **Configurable thresholds** — per-tool limits via `/loopguard config`.
- **Session persistence** — configuration is saved in the session tree and survives `/reload`.

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
/loopguard on       # Enable (watch mode)
/loopguard off      # Disable
/loopguard block    # Enable blocking mode
/loopguard watch    # Switch to watch mode (warnings only)
/loopguard status   # Show current config and thresholds
/loopguard config   # Show config widget
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
2. **Cumulative Tracking:** Counts are tracked in a `Map`. Unlike simple consecutive detection, LoopGuard maintains history for the entire user turn.
3. **Stateful Reset:** LoopGuard tracks the ID of the last user message. It only resets counters when a **new user message** is detected, ensuring protection throughout long autonomous loops.
4. **Action:**
   - At `threshold - 1`: footer warning (⚠️ nudge).
   - At `threshold` (block mode): call is blocked with the reason injected into the context for the model to see.
5. **Modification Awareness:** After `write` or `edit`, read counters for the specifically modified file are cleared, allowing the agent to verify its changes immediately.

## Known Limitations

- **Subagent tool calls are not tracked** — subagents run in separate processes with isolated extension hooks. LoopGuard only tracks the main agent's direct tool calls.
- **Exact-match only** — `read({path: "a.ts", offset: 1})` and `read({path: "a.ts", offset: 2})` are counted separately.

## Roadmap

- Argument normalization (fuzzy matching for bash commands)
- Model-adaptive thresholds (lower for small local models, higher for cloud models)
- Result similarity checking (block if the *output* is identical, even if args differ)
- Cross-session config persistence (`settings.json`)

## License

MIT
