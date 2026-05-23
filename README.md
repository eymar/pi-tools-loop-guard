# LoopGuard — Pi Extension

Detects and blocks repetitive tool calls within a single turn. Prevents the agent from wasting tokens and time calling the same tool with identical arguments repeatedly.

## Features

- **Exact-match loop detection** — tracks `toolName + serialized args` per turn
- **Two-stage response** — footer warning at `threshold-1`, block at `threshold`
- **Watch mode by default** — warnings only; enable blocking with `/loopguard block`
- **State-aware** — resets read counters after `write`/`edit` (avoids false positives)
- **Configurable thresholds** — per-tool limits via `/loopguard config`
- **Session persistence** — config survives `/reload`

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

1. Each tool call is keyed as `toolName::sortedArgsJSON`
2. Counts are tracked per-turn in a `Map`
3. At `threshold - 1`: footer warning (⚠️ nudge)
4. At `threshold` (block mode): call is blocked with reason injected into context
5. After `write`/`edit`: read counters for that file are cleared

## v2 Roadmap

- Cross-turn detection
- Argument normalization
- Model-adaptive thresholds
- Result similarity checking
- Cross-session config persistence (`settings.json`)

## License

MIT
