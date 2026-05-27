# AGENTS.md

## Project

LoopGuard is a [Pi](https://github.com/earendil-works/pi-coding-agent) extension that detects and blocks repetitive tool calls within a single turn.

`loop-guard-core.ts` — pure logic (types, key derivation, evaluation)
`loop-guard.ts` — extension shell (event handlers, Pi API). Keep it thin; new logic belongs in core.

## Setup

- Install deps: `npm install`
- Run tests: `npm test`
- Tests: `extensions/tests/loop-guard-core.test.ts`

## Key conventions

- **Thresholds** mean "allow N calls" — threshold of 2 = 2 allowed, steer on 3rd, block on 4th
- **Loop key** = `toolName::sortedArgsJSON` (volatile fields stripped); for `edit`, `newText` is stripped
- **State-modifying tools** (`write`, `edit`) reset read counters for the affected file
- **Time-based reset** clears all counters after 2 minutes
- New tool-specific behavior → update `DEFAULT_THRESHOLDS` and `VOLATILE_KEYS` in `loop-guard-core.ts`
