# Loop Guard Extension — Design Exploration

> Status: Design phase. Not built yet.

## The Problem

The Pi agent occasionally gets stuck in a loop calling the same tool with identical arguments repeatedly (e.g., `fetch_content` on the same URL 6 times). Wasteful in any scenario, catastrophic with `-np 1` local LLM where each redundant call burns sequential processing time.

---

## 1. Detection Strategies

### 1.1 Exact Match (tool name + serialized args)

```
fetch_content({ url: "https://github.com/x" }) === fetch_content({ url: "https://github.com/x" })
```

**Simple, deterministic, cheap.** But too rigid — doesn't catch:
- `read({ path: "file.ts" })` then `read({ path: "file.ts", mode: "full" })` (same file, different params)
- `bash("ls -la /dir")` then `bash("ls -la /dir")` with minor whitespace differences
- Tool calls that are *semantically* the same but structurally different

### 1.2 Normalized Match

Strip irrelevant fields (timestamps, IDs, `timeout` defaults) before comparing. More complex but catches more real loops.

```typescript
function normalizeArgs(toolName: string, args: Record<string, unknown>) {
  // Strip volatile fields that change between calls but don't affect the result
  const volatile = ["_timestamp", "sessionId", "toolCallId"];
  const cleaned = { ...args };
  volatile.forEach(k => delete cleaned[k]);
  return JSON.stringify(cleaned);
}
```

**Risk:** Over-normalization could cause false positives. `read({ path: "file.ts", offset: 1 })` vs `read({ path: "file.ts", offset: 100 })` are different reads of the same file — is that a loop or legitimate pagination?

### 1.3 Semantic Similarity (LLM-based)

Ask the model "are these two tool calls trying to do the same thing?" — too expensive, defeats the purpose of avoiding LLM calls.

### 1.4 Hybrid: Exact Match + Frequency Heuristic

Start with exact match. If a tool+arg combo hits a high count threshold (e.g., 5x), escalate to a warning even for near-matches. This catches both tight loops and "drifting" loops where the model varies args slightly.

**Recommendation:** Start with exact match. It's the safest baseline. Add normalization later if needed.

---

## 2. Edge Cases

### 2.1 Legitimate Repetition

| Scenario | Is it a loop? | How to handle |
|----------|--------------|---------------|
| `bash("git status")` called 3x in a turn to verify state changes | No — model is checking idempotency | Allow; model is being cautious |
| `fetch_content(url)` on a flaky URL that returned empty content | Maybe — but the *result* was different | Track results too; if results differ, it's not a loop |
| `read(file, offset=1)` then `read(file, offset=100)` — pagination | No — different args | Exact match handles this correctly |
| `bash("npm install")` then `bash("npm install")` — retrying a failed install | No — first call failed | Only count *successful* calls? Or track error state? |
| `web_search("React docs")` then `web_search("React documentation")` — rephrasing | Semantically a loop, but not exact match | Exact match won't catch; normalization might |

### 2.2 Cross-Turn Loops

The model might loop across turns:

```
Turn 1: fetch_content(url-A) → gets content
Turn 2: "Still need more info" → fetch_content(url-A) again
Turn 3: fetch_content(url-A) again
```

**Current design only tracks within a turn.** Cross-turn detection is harder because:
- The context window changes between turns (compaction, new messages)
- The model might genuinely need to re-read after context shifted
- Tracking across turns requires persistent state that survives compaction

**Possible approach:** Maintain a session-level LRU cache of (tool, args, result-hash, timestamp). If the same call appears within a short window (e.g., last 10 turns), flag it. But this adds complexity and memory overhead.

**Recommendation:** Start with per-turn only. Cross-turn is a v2 feature.

### 2.3 Parallel Tool Calls

Pi supports parallel tool execution. Within a single assistant message, the model might emit:

```
[fetch_content(url-A), fetch_content(url-A), bash("ls")]
```

These are preflighted sequentially then executed concurrently. The `tool_call` hook sees them one at a time. If the first `fetch_content(url-A)` is processed, the second identical one should be caught — but only if the hook state is updated between preflights.

**Risk:** In parallel mode, `ctx.sessionManager` may not be fully synchronized between sibling calls. The extension's own in-memory state (not session-based) is more reliable.

### 2.4 Tool Calls That Modify State

```
bash("rm -rf node_modules")
bash("rm -rf node_modules")  // second call is idempotent but harmless
```

Blocking the second call is fine — it's already done. But what about:

```
bash("git add .")
bash("git add .")  // model is being cautious, but blocking changes behavior
```

If the extension blocks the second call, the model might think it succeeded when it didn't (if the first actually failed silently). The model's internal state diverges from reality.

**Mitigation:** When blocking, include in the reason *what happened*: "Blocked: this command was already executed in this turn (result: exit code 0)." This lets the model reason about whether the prior result still applies.

---

## 3. What Can Go Wrong

### 3.1 False Positives (Blocking Legitimate Calls)

**Most likely scenario:** The model calls `read(file)` to check state after a `write(file)`. The extension blocks the second `read` as a repeat. But the file content *changed* between calls.

```
Turn: write("config.json", {...}) → read("config.json") → [BLOCKED: repeat]
```

The model now thinks it read the file but actually didn't. It proceeds with stale or assumed content.

**Mitigation:**
- **Reset the counter after a state-modifying tool** (`write`, `edit`, `bash`). If a write happened between two reads of the same file, it's not a loop.
- **Tool-specific rules:** `read` and `fetch_content` should have higher thresholds (allow 3-4 repeats) since re-reading after writes is common. `bash` should be more lenient since commands are often idempotent.

### 3.2 False Negatives (Missing Real Loops)

**Most likely scenario:** The model varies arguments slightly each iteration:

```
fetch_content("https://github.com/user/repo")
fetch_content("https://github.com/user/repo/blob/main/README.md")
fetch_content("https://github.com/user/repo/tree/main")
```

These are different URLs but the model is flailing — trying to get the same info from different paths.

**Mitigation:**
- **Domain-level tracking:** For `fetch_content` and `web_search`, track the base domain or query topic. If 5+ calls hit the same domain in a turn, warn even if URLs differ.
- **Result similarity:** If the tool result is substantially the same content (e.g., same README returned 3 times), flag it even if args differed. But computing content similarity is expensive.
- **Turn length heuristic:** If a turn has exceeded N tool calls (e.g., 10) without a user message or compaction, something is wrong regardless of exact repetition.

### 3.3 Steering Message Backfires

When the extension injects a steering message ("STOP: you're looping"), the model might:

- **Ignore it** — some models are stubborn about their current trajectory
- **Over-correct** — stop all tool calls entirely and give a poor answer based on assumptions
- **Argue with it** — spend tokens explaining why the call was necessary (wasting more context)
- **Loop on the steering message itself** — the steering message triggers another round of reasoning that leads back to the same tool call

**Mitigation:**
- Make the steering message **authoritative and specific**: "You called `fetch_content` on `https://github.com/x` three times. The content from the first call is still in your context. Use it. Do not call this tool again."
- Include a **concrete reference**: "The result was [N] lines of markdown about [topic]. You have this data."
- **Don't block + steer simultaneously.** Block to stop the call, but let the model see the block reason naturally. Injecting a separate steering message adds another round of LLM processing.

### 3.4 Performance Overhead

Every tool call now triggers:
1. Lookup in the call history map
2. JSON serialization of args
3. Count comparison
4. Potential state update

For a fast local LLM making many small tool calls (e.g., 20 `read` calls in a turn), this adds up. However, this is all in-JS and should be sub-millisecond per call. **Not a real concern.**

### 3.5 State Management Across Compaction

If compaction happens mid-session, `pi.appendEntry()` entries might be summarized away. The extension's in-memory state is the primary tracking mechanism, which is fine within a session. But:

- After `/reload`, in-memory state is lost
- After `/fork` or `/clone`, the new session starts fresh
- After compaction, the model's context changes but the extension's state persists

**This is actually fine.** The extension tracks *current turn* behavior. If the turn ends and a new one starts, the counter resets. Compaction between turns doesn't affect intra-turn tracking.

### 3.6 Interaction with Other Extensions

If multiple extensions hook `tool_call`, they run in load order. A permission-gate extension (e.g., "confirm before `rm`") might block a call, and the loop guard might count the blocked call as an execution.

**Mitigation:** Only count calls that *actually execute*. Hook into `tool_execution_end` instead of `tool_call` for counting, but use `tool_call` for blocking. Or check the block status before counting.

### 3.7 Model-Specific Behavior

Different models have different loop proneness:

| Model type | Loop tendency | Recommended threshold |
|------------|--------------|----------------------|
| Small local models (7B-13B) | High — tend to repeat when uncertain | Low (2 repeats = block) |
| Medium models (13B-34B) | Moderate | Medium (3 repeats) |
| Large models (70B+) | Low — better at self-correction | High (4-5 repeats) |
| Cloud models (Claude, GPT) | Very low | Very high or disabled |

**The extension should adapt thresholds based on the active model.** Detect model size/class from `ctx.model` and adjust.

---

## 4. Advanced Use Cases

### 4.1 Not Just Loops — General Tool Misuse

The same detection infrastructure could catch:

- **Excessive tool calls in a turn** — if a turn has 15+ tool calls, the model is probably lost
- **Tool call without using the result** — model calls `read(file)`, gets content, then calls `bash("cat file")` instead of using the read result
- **Ignoring previous results** — model calls `web_search("X")`, gets 5 results, then calls `web_search("X")` again instead of using `fetch_content` on the results
- **Infinite exploration** — model keeps calling `ctx_find` or `bash("find")` with slightly different patterns, never narrowing down

### 4.2 Context Budget Awareness

With a local LLM and limited context window, the extension could track:

- **Context growth per turn** — if a turn is adding more than X tokens of tool results, warn
- **Result size awareness** — if `fetch_content` returns 50KB of markdown, that's 10K+ tokens. Three of those in one turn is 30K+ tokens of context consumption
- **Proactive compaction suggestion** — if context is approaching the limit due to tool results, suggest `/compact`

### 4.3 Learning From History

Over multiple sessions, the extension could learn:

- Which URLs the model repeatedly fetches unnecessarily
- Which tools the model overuses in certain patterns
- Common loop patterns specific to the user's workflow

Store this as session-persistent entries and use it to pre-emptively steer.

---

## 5. Design Decisions to Make

| Decision | Options | Recommendation |
|----------|---------|----------------|
| Detection granularity | Per-turn only vs. cross-turn | Start per-turn, add cross-turn later |
| Match type | Exact args vs. normalized | Exact first, normalize later |
| Threshold | Fixed vs. model-adaptive | Model-adaptive (see §3.7) |
| Action on detection | Block only vs. block + steer | Block with informative reason; steer only if block is ignored |
| State storage | In-memory vs. session entries | In-memory for current turn; session entries for cross-turn (v2) |
| Tool scope | All tools vs. configurable whitelist | Configurable — default to guarding `fetch_content`, `web_search`, `read`; allow `bash` freely |
| User feedback | Silent vs. TUI notification | TUI notification + footer status indicator |

---

## 6. Minimal Viable Extension

For a first pass, keep it simple:

1. **Per-turn exact match tracking** — `Map<toolName, Map<argKey, count>>`
2. **Configurable threshold per tool** — defaults: `fetch_content: 2`, `web_search: 2`, `read: 3`, `bash: 5`, `default: 3`
3. **Block on threshold exceeded** — return `{ block: true, reason: "..." }`
4. **TUI notification** — `ctx.ui.notify()` on block
5. **Footer status** — `ctx.ui.setStatus("loop-guard", "🔒 blocked 2 repeats")`
6. **`/loopguard` command** — toggle on/off, view stats, configure thresholds

**Deliberately NOT in v1:**
- Cross-turn tracking
- Argument normalization
- Result similarity checking
- Steering message injection
- Model-adaptive thresholds
- Learning from history

---

## 7. Open Questions — Resolved

| # | Question | Decision | Rationale |
|---|----------|----------|----------|
| 1 | Should blocked calls appear in the session log? | **Yes** | Pi's `tool_call` hook returns `{ block: true, reason: "..." }` which Pi logs as the tool result. The model sees the block reason and can adapt. Hiding it causes the model to retry blindly. |
| 2 | Require explicit opt-in before blocking? | **Yes — "watch mode" by default** | Extension starts in watch-only mode (footer warnings, no blocking). User enables blocking via `/loopguard block`. Safer than blocking by default; user builds trust before enabling enforcement. |
| 3 | Skills/workflows that intentionally repeat calls? | **Per-tool config solves this** | If a skill needs repeated `read`, set threshold high or disable for that tool. The `/loopguard config` command handles exceptions. |
| 4 | "Nudge" before blocking? | **Yes — two-stage** | At `threshold - 1` repeats: footer warning ("⚠️ fetch_content repeated 2x"). At `threshold`: block (if enabled) + TUI notification. Gives the model one chance to self-correct. |
| 5 | Track `edit` calls on same file? | **No for v1** | Multiple edits per file are normal. Guard only read/inspect tools: `fetch_content`, `web_search`, `read`, `code_search`, `ctx_read`, `ctx_grep`, `ctx_find`. |

---

## 8. MVP Implementation Plan

### 8.1 File Structure

```
~/.pi/agent/extensions/loop-guard.ts
```

Single file, no dependencies, no `package.json` needed. Fits in ~150 lines.

### 8.2 Configuration

**In-memory only for v1.** Persisted via `/loopguard config` command → `pi.appendEntry()` for session survival, but no cross-session persistence. (v2 can add `settings.json` integration.)

```typescript
interface LoopGuardConfig {
  mode: "watch" | "block";           // watch = notify only, block = enforce
  thresholds: Record<string, number>; // toolName -> max repeats before action
  disabled: boolean;                  // global on/off
}

const DEFAULT_THRESHOLDS: Record<string, number> = {
  fetch_content: 2,
  web_search: 2,
  code_search: 2,
  read: 3,
  ctx_read: 3,
  ctx_grep: 3,
  ctx_find: 3,
  bash: 5,
  default: 3,
};
```

### 8.3 Core Data Structures

```typescript
// Per-turn state (in-memory, reset on turn_start)
interface TurnState {
  callHistory: Map<string, number>;   // "toolName::argKey" -> count
  blockedCount: number;               // total blocks this turn
  lastStateModifyingTool: string | null; // track last write/edit/bash for counter reset
}
```

Key derivation:
```typescript
function callKey(toolName: string, input: unknown): string {
  // Serialize args deterministically, sorted keys
  const normalized = JSON.stringify(input, Object.keys(input as object).sort());
  return `${toolName}::${normalized}`;
}
```

### 8.4 Counter Reset Logic (§3.1 mitigation)

After a state-modifying tool executes, reset counters for tools that read the same resources:

```typescript
const STATE_MODIFYING_TOOLS = new Set(["write", "edit", "bash", "ctx_shell"]);

// In tool_execution_end handler:
if (STATE_MODIFYING_TOOLS.has(event.toolName)) {
  // Reset counters for read-type tools that target the same resource
  if (event.toolName === "write" || event.toolName === "edit") {
    const path = (event.input as any)?.path;
    if (path) {
      // Clear any "read::path" counters for this file
      clearCountersForResource("read", path);
      clearCountersForResource("ctx_read", path);
    }
  }
  // For bash, don't reset — too broad. Model legitimately re-runs bash commands.
}
```

### 8.5 Event Handlers

```typescript
// Reset on turn start
pi.on("turn_start", () => {
  turnState = { callHistory: new Map(), blockedCount: 0, lastStateModifyingTool: null };
  updateFooter();
});

// Count executed calls (not blocked ones) — addresses §3.6
pi.on("tool_execution_end", (event) => {
  if (config.disabled) return;
  const key = callKey(event.toolName, event.input);
  const count = (turnState.callHistory.get(key) || 0) + 1;
  turnState.callHistory.set(key, count);
  applyStateReset(event); // §3.1 mitigation
  updateFooter();
});

// Block or nudge before execution — addresses §4 (two-stage)
pi.on("tool_call", (event) => {
  if (config.disabled) return;

  const key = callKey(event.toolName, event.input);
  const count = turnState.callHistory.get(key) || 0;
  const threshold = config.thresholds[event.toolName] ?? config.thresholds.default;

  // Stage 1: Nudge at threshold - 1
  if (count === threshold - 1) {
    ctx.ui.setStatus("loop-guard", `⚠️ ${event.toolName} repeated ${count + 1}x`);
    return; // don't block yet
  }

  // Stage 2: Block at threshold (if enabled)
  if (count >= threshold) {
    turnState.blockedCount++;
    ctx.ui.notify(`LoopGuard: blocked ${event.toolName} (${count + 1}x repeat)`, "warn");
    updateFooter();
    return {
      block: true,
      reason: `LoopGuard: ${event.toolName} called ${count + 1} times with identical args this turn. ` +
        `Prior result is in context. Use it instead of re-calling.`,

    };
  }
});

// Reset on turn end
pi.on("turn_end", () => {
  if (turnState.blockedCount > 0) {
    ctx.ui.notify(`LoopGuard: blocked ${turnState.blockedCount} repeats this turn`, "info");
  }
  updateFooter();
});
```

### 8.6 Commands

```typescript
// Toggle on/off
pi.registerCommand("loopguard", {
  description: "Toggle LoopGuard or view status",
  handler: async (args, ctx) => {
    if (args === "on") {
      config.disabled = false;
      ctx.ui.notify("LoopGuard enabled (watch mode)", "info");
    } else if (args === "off") {
      config.disabled = true;
      ctx.ui.notify("LoopGuard disabled", "info");
    } else if (args === "block") {
      config.mode = "block";
      ctx.ui.notify("LoopGuard: blocking enabled", "warn");
    } else if (args === "watch") {
      config.mode = "watch";
      ctx.ui.notify("LoopGuard: watch mode (no blocking)", "info");
    } else if (args === "status") {
      ctx.ui.notify(`LoopGuard: ${config.disabled ? "disabled" : config.mode}, ` +
        `thresholds: ${Object.entries(config.thresholds).map(([k,v]) => `${k}=${v}`).join(", ")}`,
        "info");
    } else {
      ctx.ui.notify(`LoopGuard: ${config.disabled ? "disabled" : `${config.mode} mode`} | ` +
        `use: on|off|block|watch|status|config`, "info");
    }
  },
});
```

### 8.7 Footer Status Indicator

```typescript
function updateFooter() {
  if (config.disabled) {
    ctx.ui.setStatus("loop-guard", "👁️ LoopGuard: off");
    return;
  }

  const totalCalls = turnState.callHistory.size;
  const repeats = [...turnState.callHistory.values()].filter(c => c > 1);
  const mode = config.mode === "block" ? "🔒" : "👁️";

  if (repeats.length === 0) {
    ctx.ui.setStatus("loop-guard", `${mode} LoopGuard: ok`);
  } else {
    ctx.ui.setStatus("loop-guard", `${mode} LoopGuard: ${repeats.length} repeat${repeats.length > 1 ? "s" : ""}, ${turnState.blockedCount} blocked`);
  }
}
```

### 8.8 Implementation Order

1. **Skeleton** — `turn_start`/`turn_end` handlers, empty `tool_call` hook, `/loopguard` command
2. **Counting** — `tool_execution_end` handler with `callKey` derivation and `callHistory` map
3. **Nudge** — footer warning at `threshold - 1`
4. **Blocking** — `tool_call` block at `threshold` (only in block mode)
5. **State reset** — clear counters after `write`/`edit` (§3.1 mitigation)
6. **Persistence** — `pi.appendEntry()` for config across `/reload`
7. **Polish** — TUI notifications, footer status, edge case handling

### 8.9 Known Limitations of MVP

- No cross-turn detection (v2)
- No argument normalization (v2)
- No model-adaptive thresholds (v2)
- Config not persisted across sessions (v2: `settings.json`)
- `bash` counter reset not implemented (too broad — would need command parsing)
- No result similarity checking (v2)
- No "nudge" message injected into LLM context (footer-only warning)
