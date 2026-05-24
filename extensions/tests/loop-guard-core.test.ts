import { describe, it, expect } from "vitest";
import {
  callKey,
  createFreshTurnState,
  createDefaultConfig,
  recordCall,
  evaluateCall,
  clearCountersForResource,
  applyStateReset,
  countRepeats,
  DEFAULT_THRESHOLDS,
  STATE_MODIFYING_TOOLS,
  type ToolCallEvent,
} from "../loop-guard-core";

// ── callKey ───────────────────────────────────────────────────────────────────

describe("callKey", () => {
  it("produces identical keys for same tool + args", () => {
    const input = { path: "file.ts" };
    expect(callKey("read", input)).toBe(callKey("read", input));
  });

  it("ignores key order in args", () => {
    const a = { path: "file.ts", offset: 1 };
    const b = { offset: 1, path: "file.ts" };
    expect(callKey("read", a)).toBe(callKey("read", b));
  });

  it("differs when args differ", () => {
    expect(callKey("read", { path: "a.ts" })).not.toBe(
      callKey("read", { path: "b.ts" }),
    );
  });

  it("differs when tool name differs", () => {
    expect(callKey("read", { path: "a.ts" })).not.toBe(
      callKey("bash", { path: "a.ts" }),
    );
  });

  it("handles null input", () => {
    expect(() => callKey("bash", null)).not.toThrow();
    expect(callKey("bash", null)).toBe("bash::null");
  });

  it("handles undefined input", () => {
    expect(() => callKey("bash", undefined)).not.toThrow();
    expect(callKey("bash", undefined)).toBe("bash::undefined");
  });

  it("handles primitive input", () => {
    expect(() => callKey("bash", "just-a-string")).not.toThrow();
    expect(callKey("bash", "just-a-string")).toBe(
      'bash::"just-a-string"',
    );
  });

  it("strips volatile metadata fields (timeout, toolCallId, etc.)", () => {
    const a = { command: "ls", timeout: 30, toolCallId: "abc-123" };
    const b = { command: "ls", timeout: 60, toolCallId: "xyz-789" };
    expect(callKey("bash", a)).toBe(callKey("bash", b));
    expect(callKey("bash", a)).toBe('bash::{"command":"ls"}');
  });

  it("strips volatile fields from read calls", () => {
    const a = { path: "file.ts", timeout: 10 };
    const b = { path: "file.ts", timeout: 20 };
    expect(callKey("read", a)).toBe(callKey("read", b));
  });
});

// ── recordCall ────────────────────────────────────────────────────────────────

describe("recordCall", () => {
  it("increments count for consecutive identical calls", () => {
    const state = createFreshTurnState();
    const event: ToolCallEvent = { toolName: "read", input: { path: "a.ts" } };

    expect(recordCall(state, event)).toBe(1);
    expect(recordCall(state, event)).toBe(2);
    expect(recordCall(state, event)).toBe(3);
  });

  it("retains counters when a different key appears (cumulative)", () => {
    const state = createFreshTurnState();
    const a: ToolCallEvent = { toolName: "read", input: { path: "a.ts" } };
    const b: ToolCallEvent = { toolName: "read", input: { path: "b.ts" } };

    recordCall(state, a);
    recordCall(state, a);
    expect(state.callHistory.get(callKey("read", a.input))).toBe(2);

    // Different key → NO reset (cumulative)
    recordCall(state, b);
    expect(state.callHistory.get(callKey("read", b.input))).toBe(1);
    expect(state.callHistory.get(callKey("read", a.input))).toBe(2);
  });

  it("retains counters when a different tool is called (cumulative)", () => {
    const state = createFreshTurnState();
    const read: ToolCallEvent = { toolName: "read", input: { path: "a.ts" } };
    const bash: ToolCallEvent = { toolName: "bash", input: { command: "ls" } };

    recordCall(state, read);
    recordCall(state, read);
    expect(state.callHistory.get(callKey("read", read.input))).toBe(2);

    // Different tool → NO reset
    recordCall(state, bash);
    expect(state.callHistory.get(callKey("bash", bash.input))).toBe(1);
    expect(state.callHistory.get(callKey("read", read.input))).toBe(2);
  });
});

// ── evaluateCall ──────────────────────────────────────────────────────────────

describe("evaluateCall", () => {
  const event: ToolCallEvent = {
    toolName: "fetch_content",
    input: { url: "https://example.com" },
  };

  it("returns undefined when disabled", () => {
    const config = createDefaultConfig();
    config.disabled = true;
    const state = createFreshTurnState();
    expect(evaluateCall(config, state, event)).toBeUndefined();
  });

  it("returns undefined below threshold", () => {
    const config = createDefaultConfig();
    const state = createFreshTurnState();
    expect(evaluateCall(config, state, event)).toBeUndefined();
  });

  it("blocks at threshold", () => {
    const config = createDefaultConfig();
    const state = createFreshTurnState();
    // fetch_content threshold = 2, block at count >= 2
    recordCall(state, event);
    recordCall(state, event);

    const result = evaluateCall(config, state, event);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("fetch_content");
    expect(result?.reason).toContain("3 times");
  });

  it("does NOT block when disabled", () => {
    const config = createDefaultConfig();
    config.disabled = true;
    const state = createFreshTurnState();
    recordCall(state, event);
    recordCall(state, event);

    const result = evaluateCall(config, state, event);
    expect(result?.block).not.toBe(true);
  });

  it("uses default threshold for unknown tools", () => {
    const config = createDefaultConfig();
    const state = createFreshTurnState();
    const unknown: ToolCallEvent = { toolName: "some_new_tool", input: {} };

    // default threshold = 3, so need 3 prior calls to block
    recordCall(state, unknown);
    recordCall(state, unknown);
    recordCall(state, unknown);

    const result = evaluateCall(config, state, unknown);
    expect(result?.block).toBe(true);
  });
});

// ── clearCountersForResource ──────────────────────────────────────────────────

describe("clearCountersForResource", () => {
  it("removes counters for the matching tool + path", () => {
    const state = createFreshTurnState();
    recordCall(state, { toolName: "read", input: { path: "config.json" } });
    recordCall(state, { toolName: "read", input: { path: "config.json" } });
    recordCall(state, { toolName: "read", input: { path: "other.ts" } });

    clearCountersForResource(state, "read", "config.json");

    expect(state.callHistory.has(callKey("read", { path: "config.json" }))).toBe(
      false,
    );
    expect(state.callHistory.has(callKey("read", { path: "other.ts" }))).toBe(
      true,
    );
  });

  it("does not affect other tools", () => {
    const state = createFreshTurnState();
    recordCall(state, { toolName: "read", input: { path: "a.ts" } });
    recordCall(state, { toolName: "bash", input: { command: "ls" } });

    clearCountersForResource(state, "read", "a.ts");

    expect(state.callHistory.has(callKey("read", { path: "a.ts" }))).toBe(false);
    expect(state.callHistory.has(callKey("bash", { command: "ls" }))).toBe(true);
  });
});

// ── applyStateReset ───────────────────────────────────────────────────────────

describe("applyStateReset", () => {
  it("clears read counters after write to same file", () => {
    const state = createFreshTurnState();
    recordCall(state, { toolName: "read", input: { path: "config.json" } });
    recordCall(state, { toolName: "read", input: { path: "config.json" } });

    applyStateReset(state, {
      toolName: "write",
      input: { path: "config.json", content: "{}" },
    });

    expect(state.callHistory.has(callKey("read", { path: "config.json" }))).toBe(
      false,
    );
  });

  it("clears read counters after edit to same file", () => {
    const state = createFreshTurnState();
    recordCall(state, { toolName: "ctx_read", input: { path: "app.ts" } });

    applyStateReset(state, {
      toolName: "edit",
      input: { path: "app.ts", edits: [] },
    });

    expect(state.callHistory.has(callKey("ctx_read", { path: "app.ts" }))).toBe(
      false,
    );
  });

  it("does NOT clear counters for non-state-modifying tools", () => {
    const state = createFreshTurnState();
    recordCall(state, { toolName: "read", input: { path: "a.ts" } });

    applyStateReset(state, {
      toolName: "read",
      input: { path: "a.ts" },
    });

    expect(state.callHistory.has(callKey("read", { path: "a.ts" }))).toBe(true);
  });

  it("does NOT clear counters when paths differ", () => {
    const state = createFreshTurnState();
    recordCall(state, { toolName: "read", input: { path: "a.ts" } });

    applyStateReset(state, {
      toolName: "write",
      input: { path: "b.ts", content: "" },
    });

    expect(state.callHistory.has(callKey("read", { path: "a.ts" }))).toBe(true);
  });
});

// ── countRepeats ──────────────────────────────────────────────────────────────

describe("countRepeats", () => {
  it("returns 0 when no repeats", () => {
    const state = createFreshTurnState();
    recordCall(state, { toolName: "read", input: { path: "a.ts" } });
    recordCall(state, { toolName: "read", input: { path: "b.ts" } });
    expect(countRepeats(state)).toBe(0);
  });

  it("counts unique keys with count > 1 (cumulative)", () => {
    const state = createFreshTurnState();
    // With cumulative logic, history is NOT cleared.
    recordCall(state, { toolName: "read", input: { path: "a.ts" } });
    recordCall(state, { toolName: "read", input: { path: "a.ts" } });
    recordCall(state, { toolName: "bash", input: { command: "ls" } });
    recordCall(state, { toolName: "bash", input: { command: "ls" } });
    expect(countRepeats(state)).toBe(2); // both have count > 1
  });
});

// ── Constants ─────────────────────────────────────────────────────────────────

describe("DEFAULT_THRESHOLDS", () => {
  it("has expected defaults", () => {
    expect(DEFAULT_THRESHOLDS.fetch_content).toBe(2);
    expect(DEFAULT_THRESHOLDS.web_search).toBe(2);
    expect(DEFAULT_THRESHOLDS.read).toBe(3);
    expect(DEFAULT_THRESHOLDS.bash).toBe(5);
    expect(DEFAULT_THRESHOLDS.default).toBe(3);
  });
});

describe("STATE_MODIFYING_TOOLS", () => {
  it("includes expected tools", () => {
    expect(STATE_MODIFYING_TOOLS.has("write")).toBe(true);
    expect(STATE_MODIFYING_TOOLS.has("edit")).toBe(true);
    expect(STATE_MODIFYING_TOOLS.has("bash")).toBe(true);
    expect(STATE_MODIFYING_TOOLS.has("ctx_shell")).toBe(true);
    expect(STATE_MODIFYING_TOOLS.has("read")).toBe(false);
  });
});

// ── Regression: counting must happen in tool_call, not tool_execution_end ────
// Pi's tool_execution_end event has { toolName, result, isError } — NO input.
// Pi's tool_call event has { toolName, input } — typed args are available.
// Counting in tool_execution_end always produced "toolName::undefined".

describe("regression: counting in wrong hook produces undefined keys", () => {
  it("tool_call input shape produces proper keys", () => {
    // Simulates tool_call event input
    const input = { command: "ls" };
    const key = callKey("bash", input);
    expect(key).toBe('bash::{"command":"ls"}');
    expect(key).not.toContain("undefined");
  });

  it("tool_execution_end input shape (undefined) produces useless keys", () => {
    // Simulates tool_execution_end event — input is undefined
    const key = callKey("bash", undefined);
    expect(key).toBe("bash::undefined");
    // Every call gets the same key regardless of actual args → no loop detection
  });

  it("two identical calls produce same key via tool_call", () => {
    const a: ToolCallEvent = { toolName: "bash", input: { command: "ls" } };
    const b: ToolCallEvent = { toolName: "bash", input: { command: "ls" } };
    expect(callKey(a.toolName, a.input)).toBe(callKey(b.toolName, b.input));
  });

  it("two different calls would collide via tool_execution_end (bug)", () => {
    // Both produce "bash::undefined" — indistinguishable
    const key1 = callKey("bash", undefined);
    const key2 = callKey("bash", undefined);
    expect(key1).toBe(key2); // collision — this is the bug
    expect(key1).toBe("bash::undefined");
  });

  it("full workflow: recordCall + evaluateCall works with real input", () => {
    const config = createDefaultConfig();
    const state = createFreshTurnState();
    const event: ToolCallEvent = {
      toolName: "fetch_content",
      input: { url: "https://example.com" },
    };

    // Call 1: no action, recorded
    expect(evaluateCall(config, state, event)).toBeUndefined();
    recordCall(state, event);

    // Call 2: still under threshold, recorded
    expect(evaluateCall(config, state, event)).toBeUndefined();
    recordCall(state, event);

    // Call 3: block at threshold (fetch_content threshold = 2)
    const block = evaluateCall(config, state, event);
    expect(block?.block).toBe(true);
  });
});

