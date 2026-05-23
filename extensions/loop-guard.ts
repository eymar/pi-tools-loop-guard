/**
 * LoopGuard Extension
 *
 * Detects and blocks repetitive tool calls within a single turn.
 * Starts in watch mode (footer warnings only). Enable blocking with /loopguard block.
 *
 * §8 MVP — All 7 steps complete:
 * 1. Skeleton — turn_start/turn_end, tool_call hook, /loopguard command
 * 2. Counting — tool_execution_end with callKey derivation
 * 3. Nudge — footer warning at threshold-1
 * 4. Blocking — tool_call block at threshold (block mode only)
 * 5. State reset — clear read counters after write/edit (§3.1 mitigation)
 * 6. Persistence — pi.appendEntry for config across /reload
 * 7. Polish — session_shutdown, TUI notifications, footer status
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Configuration ──────────────────────────────────────────────────────────────

interface LoopGuardConfig {
  mode: "watch" | "block";
  thresholds: Record<string, number>;
  disabled: boolean;
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

// ── Per-turn state ─────────────────────────────────────────────────────────────

interface TurnState {
  callHistory: Map<string, number>;
  blockedCount: number;
  lastStateModifyingTool: string | null;
}

function createFreshTurnState(): TurnState {
  return {
    callHistory: new Map(),
    blockedCount: 0,
    lastStateModifyingTool: null,
  };
}

// ── Extension factory ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let config: LoopGuardConfig = {
    mode: "watch",
    thresholds: { ...DEFAULT_THRESHOLDS },
    disabled: false,
  };

  let turnState: TurnState = createFreshTurnState();

  // ── Session lifecycle — restore / persist config ─────────────────────────

  const CUSTOM_ENTRY_TYPE = "loop-guard-config";

  pi.on("session_start", async (_event, ctx) => {
    // Restore config from previous session entries
    const entries = ctx.sessionManager.getEntries();
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === CUSTOM_ENTRY_TYPE) {
        const data = entry.data as LoopGuardConfig | undefined;
        if (data) {
          config = data;
          ctx.ui.notify(`LoopGuard restored: ${config.disabled ? "disabled" : config.mode}`, "info");
        }
        break;
      }
    }
    updateFooter(ctx);
  });

  function persistConfig(ctx: Parameters<Parameters<typeof pi.on>[1]>["1"]): void {
    pi.appendEntry(CUSTOM_ENTRY_TYPE, config);
  }

  pi.on("session_shutdown", async (_event, ctx) => {
    persistConfig(ctx);
  });

  // ── Turn lifecycle ───────────────────────────────────────────────────────

  pi.on("turn_start", async (_event, ctx) => {
    turnState = createFreshTurnState();
    updateFooter(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (turnState.blockedCount > 0) {
      ctx.ui.notify(
        `LoopGuard: blocked ${turnState.blockedCount} repeat${turnState.blockedCount > 1 ? "s" : ""} this turn`,
        "info",
      );
    }
    updateFooter(ctx);
  });

  // ── Call key derivation ──────────────────────────────────────────────────

  function callKey(toolName: string, input: unknown): string {
    const args = input as Record<string, unknown>;
    const sortedKeys = Object.keys(args).sort();
    const ordered: Record<string, unknown> = {};
    for (const k of sortedKeys) ordered[k] = args[k];
    return `${toolName}::${JSON.stringify(ordered)}`;
  }

  // ── State-modifying tools (§3.1 mitigation) ─────────────────────────────

  const STATE_MODIFYING_TOOLS = new Set(["write", "edit", "bash", "ctx_shell"]);

  function applyStateReset(event: { toolName: string; input: unknown }): void {
    if (!STATE_MODIFYING_TOOLS.has(event.toolName)) return;

    turnState.lastStateModifyingTool = event.toolName;

    // After write/edit, reset read counters for the affected file
    if (event.toolName === "write" || event.toolName === "edit") {
      const path = (event.input as Record<string, unknown>)?.path as string | undefined;
      if (path) {
        clearCountersForResource("read", path);
        clearCountersForResource("ctx_read", path);
      }
    }
  }

  function clearCountersForResource(toolName: string, path: string): void {
    const prefix = `${toolName}::`;
    for (const key of turnState.callHistory.keys()) {
      if (key.startsWith(prefix) && key.includes(path)) {
        turnState.callHistory.delete(key);
      }
    }
  }

  // ── Tool execution end — count calls + state reset ───────────────────────

  pi.on("tool_execution_end", async (event, ctx) => {
    if (config.disabled) return;
    const key = callKey(event.toolName, event.input);
    const count = (turnState.callHistory.get(key) || 0) + 1;
    turnState.callHistory.set(key, count);
    applyStateReset(event);
    updateFooter(ctx);
  });

  // ── Tool call hook — nudge at threshold-1, block at threshold ───────────

  pi.on("tool_call", async (event, ctx) => {
    if (config.disabled) return;

    const key = callKey(event.toolName, event.input);
    const count = turnState.callHistory.get(key) || 0;
    const threshold = config.thresholds[event.toolName] ?? config.thresholds.default;

    // Stage 1: Nudge at threshold - 1 (footer warning, don't block)
    if (count === threshold - 1) {
      ctx.ui.setStatus("loop-guard", `⚠️ ${event.toolName} repeated ${count + 1}x`);
      return;
    }

    // Stage 2: Block at threshold (only in block mode)
    if (count >= threshold && config.mode === "block") {
      turnState.blockedCount++;
      ctx.ui.notify(`LoopGuard: blocked ${event.toolName} (${count + 1}x repeat)`, "warn");
      updateFooter(ctx);
      return {
        block: true,
        reason: `LoopGuard: ${event.toolName} called ${count + 1} times with identical args this turn. ` +
          `Prior result is in context. Use it instead of re-calling.`,
      };
    }
  });

  // ── /loopguard command ───────────────────────────────────────────────────

  pi.registerCommand("loopguard", {
    description: "Toggle LoopGuard or view status",
    getArgumentCompletions: (prefix) => {
      const cmds = ["on", "off", "block", "watch", "status", "config"];
      const filtered = cmds.filter((c) => c.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((c) => ({ value: c, label: c })) : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      switch (arg) {
        case "on":
          config.disabled = false;
          persistConfig(ctx);
          ctx.ui.notify("LoopGuard enabled (watch mode)", "info");
          break;

        case "off":
          config.disabled = true;
          persistConfig(ctx);
          ctx.ui.notify("LoopGuard disabled", "info");
          break;

        case "block":
          config.disabled = false;
          config.mode = "block";
          persistConfig(ctx);
          ctx.ui.notify("LoopGuard: blocking enabled", "warn");
          break;

        case "watch":
          config.disabled = false;
          config.mode = "watch";
          persistConfig(ctx);
          ctx.ui.notify("LoopGuard: watch mode (no blocking)", "info");
          break;

        case "status":
          ctx.ui.notify(
            `LoopGuard: ${config.disabled ? "disabled" : config.mode} | ` +
              `thresholds: ${Object.entries(config.thresholds)
                .map(([k, v]) => `${k}=${v}`)
                .join(", ")}`,
            "info",
          );
          break;

        case "config":
          showConfig(ctx);
          break;

        default:
          ctx.ui.notify(
            `LoopGuard: ${config.disabled ? "disabled" : `${config.mode} mode`} | ` +
              `use: on|off|block|watch|status|config`,
            "info",
          );
      }

      updateFooter(ctx);
    },
  });

  // ── Footer status indicator ──────────────────────────────────────────────

  function updateFooter(ctx: Parameters<Parameters<typeof pi.on>[1]>["1"]) {
    if (config.disabled) {
      ctx.ui.setStatus("loop-guard", "👁️ LoopGuard: off");
      return;
    }

    const repeats = [...turnState.callHistory.values()].filter((c) => c > 1);
    const mode = config.mode === "block" ? "🔒" : "👁️";

    if (repeats.length === 0) {
      ctx.ui.setStatus("loop-guard", `${mode} LoopGuard: ok`);
    } else {
      ctx.ui.setStatus(
        "loop-guard",
        `${mode} LoopGuard: ${repeats.length} repeat${repeats.length > 1 ? "s" : ""}, ${turnState.blockedCount} blocked`,
      );
    }
  }

  // ── Config display helper ────────────────────────────────────────────────

  function showConfig(ctx: Parameters<Parameters<typeof pi.on>[1]>["1"]) {
    const lines = [
      `Mode: ${config.disabled ? "disabled" : config.mode}`,
      "",
      "Thresholds (max repeats before action):",
      ...Object.entries(config.thresholds).map(([tool, count]) => `  ${tool}: ${count}`),
    ];
    ctx.ui.setWidget("loop-guard-config", lines);
  }
}
