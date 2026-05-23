/**
 * LoopGuard Extension
 *
 * Detects and blocks repetitive tool calls within a single turn.
 * Starts in watch mode (footer warnings only). Enable blocking with /loopguard block.
 *
 * Core logic lives in loop-guard-core.ts (testable pure functions).
 * This file is the extension shell — event handlers + UI.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createDefaultConfig,
  createFreshTurnState,
  callKey,
  applyStateReset,
  recordCall,
  evaluateCall,
  countRepeats,
  type LoopGuardConfig,
  type TurnState,
} from "./loop-guard-core";

// ── Extension factory ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let config: LoopGuardConfig = createDefaultConfig();
  let turnState: TurnState = createFreshTurnState();
  let lastProcessedMessageId: string | null = null;

  // ── Session lifecycle — restore / persist config ─────────────────────────

  const CUSTOM_ENTRY_TYPE = "loop-guard-config";

  pi.on("session_start", async (_event, ctx) => {
    turnState = createFreshTurnState();
    lastProcessedMessageId = null;
    const entries = ctx.sessionManager.getEntries();
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === CUSTOM_ENTRY_TYPE) {
        const data = entry.data as LoopGuardConfig | undefined;
        if (data) {
          // Merge: persisted values first, then new defaults on top.
          // This ensures code-level default changes (e.g. watch→block) take effect.
          config = { ...createDefaultConfig(), ...data };
          ctx.ui.notify(
            `LoopGuard restored: ${config.disabled ? "disabled" : config.mode}`,
            "info",
          );
        }
        break;
      }
    }
    updateFooter(ctx);
  });

  function persistConfig(
    ctx: Parameters<Parameters<typeof pi.on>[1]>["1"],
  ): void {
    pi.appendEntry(CUSTOM_ENTRY_TYPE, config);
  }

  pi.on("session_shutdown", async (_event, ctx) => {
    persistConfig(ctx);
  });

  // ── Turn lifecycle ───────────────────────────────────────────────────────

  pi.on("turn_start", async (_event, ctx) => {
    // Detect if this turn was triggered by a new user message.
    // Every tool call is its own turn in this framework, but we only
    // want to reset our loop history when the user provides a new prompt.
    // We search backwards for the last USER message to track the ID.
    const entries = ctx.sessionManager.getEntries();
    let lastUserMessageEntry = null;

    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (
        entry.type === "message" &&
        (entry.message as any)?.role === "user"
      ) {
        lastUserMessageEntry = entry;
        break;
      }
    }

    if (
      lastUserMessageEntry &&
      (lastUserMessageEntry as any).id !== lastProcessedMessageId
    ) {
      turnState = createFreshTurnState();
      lastProcessedMessageId = (lastUserMessageEntry as any).id;
    }

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

  // ── Tool call hook — count, nudge, and potentially block ─────────────────
  // NOTE: counting happens here because tool_call has event.input.
  //       tool_execution_end only has result/isError, not input.

  pi.on("tool_call", async (event, ctx) => {
    if (config.disabled) return;

    const toolEvent = { toolName: event.toolName, input: event.input };

    // Evaluate BEFORE recording (check existing count)
    const result = evaluateCall(config, turnState, toolEvent);

    // Stage 1: Nudge (don't block, but warn)
    if (result?.nudge) {
      const count = turnState.callHistory.get(callKey(event.toolName, event.input)) || 0;
      ctx.ui.setStatus(
        "loop-guard",
        `⚠️ ${event.toolName} repeated ${count + 1}x`,
      );
      // Still record the call (user chose to proceed)
      recordCall(turnState, toolEvent);
      applyStateReset(turnState, toolEvent);
      updateFooter(ctx);
      return;
    }

    // Stage 2: Block (don't record, don't count)
    if (result?.block) {
      turnState.blockedCount++;
      const count = turnState.callHistory.get(callKey(event.toolName, event.input)) || 0;
      ctx.ui.notify(
        `LoopGuard: blocked ${event.toolName} (${count + 1}x repeat)`,
        "warn",
      );
      updateFooter(ctx);

      // After first block, inject a steering message so the LLM stops retrying.
      if (!turnState.steeringInjected) {
        turnState.steeringInjected = true;
        pi.sendMessage({
          customType: "loopguard-steering",
          content: `Important: LoopGuard has blocked repeated tool calls. ` +
            `Do NOT retry the same tool with the same arguments — it will be blocked again. ` +
            `Use the results you already have from prior calls, or try a different approach.`,
          display: true,
        });
      }

      return {
        block: true,
        reason: `LoopGuard: ${result.reason}`,
      };
    }

    // No action needed — record the call normally
    recordCall(turnState, toolEvent);
    applyStateReset(turnState, toolEvent);
    updateFooter(ctx);
  });

  // ── Tool execution end — update footer after completion ───────────────────

  pi.on("tool_execution_end", async (_event, ctx) => {
    if (config.disabled) return;
    updateFooter(ctx);
  });

  // ── /loopguard command ───────────────────────────────────────────────────

  pi.registerCommand("loopguard", {
    description: "Toggle LoopGuard or view status",
    getArgumentCompletions: (prefix) => {
      const cmds = ["on", "off", "block", "watch", "status", "config"];
      const filtered = cmds.filter((c) => c.startsWith(prefix));
      return filtered.length > 0
        ? filtered.map((c) => ({ value: c, label: c }))
        : null;
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

  function updateFooter(
    ctx: Parameters<Parameters<typeof pi.on>[1]>["1"],
  ): void {
    if (config.disabled) {
      ctx.ui.setStatus("loop-guard", "👁️ LoopGuard: off");
      return;
    }

    const repeats = countRepeats(turnState);
    const mode = config.mode === "block" ? "🔒" : "👁️";

    if (repeats === 0) {
      ctx.ui.setStatus("loop-guard", `${mode} LoopGuard: ok`);
    } else {
      ctx.ui.setStatus(
        "loop-guard",
        `${mode} LoopGuard: ${repeats} repeat${repeats > 1 ? "s" : ""}, ${turnState.blockedCount} blocked`,
      );
    }
  }

  // ── Config display helper ────────────────────────────────────────────────

  function showConfig(
    ctx: Parameters<Parameters<typeof pi.on>[1]>["1"],
  ): void {
    const lines = [
      `Mode: ${config.disabled ? "disabled" : config.mode}`,
      "",
      "Thresholds (max repeats before action):",
      ...Object.entries(config.thresholds).map(
        ([tool, count]) => `  ${tool}: ${count}`,
      ),
    ];
    ctx.ui.setWidget("loop-guard-config", lines);
  }
}
