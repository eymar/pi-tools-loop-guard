/**
 * LoopGuard — core logic (pure functions, testable).
 * Imported by loop-guard.ts (the extension shell).
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface LoopGuardConfig {
  thresholds: Record<string, number>;
  disabled: boolean;
}

export interface TurnState {
  callHistory: Map<string, number>;
  blockedCount: number;
  lastStateModifyingTool: string | null;
  steeringInjected: boolean;
}

export interface ToolCallEvent {
  toolName: string;
  input: unknown;
}

export const DEFAULT_THRESHOLDS: Record<string, number> = {
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

export const STATE_MODIFYING_TOOLS = new Set([
  "write",
  "edit",
  "bash",
  "ctx_shell",
]);

// ── Helpers ────────────────────────────────────────────────────────────────────

export function createFreshTurnState(): TurnState {
  return {
    callHistory: new Map(),
    blockedCount: 0,
    lastStateModifyingTool: null,
    steeringInjected: false,
  };
}

export function createDefaultConfig(): LoopGuardConfig {
  return {
    thresholds: { ...DEFAULT_THRESHOLDS },
    disabled: false,
  };
}

/**
 * Fields injected by Pi's tool framework that should be ignored for loop detection.
 */
const VOLATILE_KEYS = new Set([
  "timeout",
  "toolCallId",
  "callId",
  "id",
  "_id",
  "requestId",
  "traceId",
  "spanId",
]);

/**
 * Derive a deterministic key for a tool call.
 * Sorted keys ensure `read({path:"a"})` === `read({path:"a"})` regardless of arg order.
 * Volatile metadata fields (timeout, toolCallId, etc.) are stripped.
 */
export function callKey(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") {
    return `${toolName}::${JSON.stringify(input)}`;
  }
  const args = input as Record<string, unknown>;
  const sortedKeys = Object.keys(args)
    .filter((k) => !VOLATILE_KEYS.has(k))
    .sort();
  const ordered: Record<string, unknown> = {};
  for (const k of sortedKeys) ordered[k] = args[k];
  return `${toolName}::${JSON.stringify(ordered)}`;
}

/**
 * Clear counters for read-type tools targeting a specific resource path.
 */
export function clearCountersForResource(
  turnState: TurnState,
  toolName: string,
  path: string,
): void {
  const prefix = `${toolName}::`;
  for (const key of turnState.callHistory.keys()) {
    if (key.startsWith(prefix) && key.includes(path)) {
      turnState.callHistory.delete(key);
    }
  }
}

/**
 * After a state-modifying tool, reset read counters for affected resources.
 */
export function applyStateReset(
  turnState: TurnState,
  event: ToolCallEvent,
): void {
  if (!STATE_MODIFYING_TOOLS.has(event.toolName)) return;

  turnState.lastStateModifyingTool = event.toolName;

  if (event.toolName === "write" || event.toolName === "edit") {
    const path = (event.input as Record<string, unknown>)?.path as
      | string
      | undefined;
    if (path) {
      clearCountersForResource(turnState, "read", path);
      clearCountersForResource(turnState, "ctx_read", path);
    }
  }
}

/**
 * Record a tool call in the turn state.
 * Returns the new count for this key.
 */
export function recordCall(
  turnState: TurnState,
  event: ToolCallEvent,
): number {
  const key = callKey(event.toolName, event.input);

  const count = (turnState.callHistory.get(key) || 0) + 1;
  turnState.callHistory.set(key, count);
  return count;
}

/**
 * Evaluate a pending tool call against the config and turn state.
 * Returns { block, reason, nudge } or undefined if no action needed.
 */
export function evaluateCall(
  config: LoopGuardConfig,
  turnState: TurnState,
  event: ToolCallEvent,
): { block: true; reason: string } | undefined {
  if (config.disabled) return;

  const key = callKey(event.toolName, event.input);
  const count = turnState.callHistory.get(key) || 0;
  const threshold = config.thresholds[event.toolName] ?? config.thresholds.default;

  if (count >= threshold) {
    return {
      block: true,
      reason: `${event.toolName} called ${count + 1} times with identical args this turn. ` +
        `Prior result is in context. Use it instead of re-calling.`,
    };
  }

  return;
}

/**
 * Count how many unique keys have been repeated (count > 1).
 */
export function countRepeats(turnState: TurnState): number {
  return [...turnState.callHistory.values()].filter((c) => c > 1).length;
}
