/**
 * LoopGuard Extension
 *
 * Detects and blocks repetitive tool calls within a single turn.
 * Starts enabled. Toggle with /loopguard on/off.
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

  // ── Hook registration ────────────────────────────────────────────────────

  pi.on("message_start", handleMessageStart);
  pi.on("tool_call", handleToolCall);

  pi.registerCommand("loopguard", {
    description: "Toggle LoopGuard or view status",
    getArgumentCompletions,
    handler: handleLoopguardCommand,
  });

  // ── Event handlers ───────────────────────────────────────────────────────

  async function handleMessageStart(
    event: Parameters<Parameters<typeof pi.on>[1]>["0"],
    ctx: Parameters<Parameters<typeof pi.on>[1]>["1"],
  ): Promise<void> {
    if (event.message.role !== "user") return;

    turnState = createFreshTurnState();
    updateFooter(ctx);
  }

  // NOTE: counting happens here because tool_call has event.input.
  //       tool_execution_end only has result/isError, not input.
  async function handleToolCall(
    event: Parameters<Parameters<typeof pi.on>[1]>["0"],
    ctx: Parameters<Parameters<typeof pi.on>[1]>["1"],
  ): Promise<void | { block: true; reason: string }> {

    if (config.disabled) return;

    // Intercept bash calls with echo '/loopguard reset' so the LLM can reset counters
    if (event.toolName === "bash" && isResetCommand(event.input)) {
      turnState = createFreshTurnState();
      updateFooter(ctx);
      return;
    }

    const toolEvent = { toolName: event.toolName, input: event.input };

    // Evaluate BEFORE recording (evaluateCall includes +1 for the current call)
    const result = evaluateCall(config, turnState, toolEvent);

    // Steer: inject a specific message so the LLM self-corrects before we block
    if (result?.steer) {
      const key = callKey(event.toolName, event.input);
      turnState.steeredKeys.add(key);

      const argsSummary = typeof event.input === "object" && event.input
        ? JSON.stringify(event.input).slice(0, 120)
        : String(event.input).slice(0, 120);

      pi.sendMessage({
        customType: "loopguard-steering",
        content: `LoopGuard: ${result.toolName} called ${result.count} times with identical args (${argsSummary}). ` +
          `The result from the first call is still in your context. Do not call ${result.toolName} with these args again — ` +
          `the next call in this turn will be blocked. Use the prior result instead. ` +
          `If you're sure that LoopGuard's signal is false positive, then you may call bash with command: echo '/loopguard reset'.`,
        display: true,
      });

      // Still record — the call was allowed, model chose to proceed
      recordCall(turnState, toolEvent);
      applyStateReset(turnState, toolEvent);
      updateFooter(ctx);
      return;
    }

    // Block (don't record, don't count)
    if (result?.block) {
      turnState.blockedCount++;
      const count = turnState.callHistory.get(callKey(event.toolName, event.input)) || 0;
      ctx.ui.notify(
        `LoopGuard: blocked ${event.toolName} (${count + 1}x repeat)`,
        "warn",
      );
      updateFooter(ctx);

      return {
        block: true,
        reason: `LoopGuard: ${result.reason}`,
      };
    }

    // No action — record the call normally
    recordCall(turnState, toolEvent);
    applyStateReset(turnState, toolEvent);
    updateFooter(ctx);
  }

  // ── /loopguard command ───────────────────────────────────────────────────

  async function handleLoopguardCommand(
    args: string,
    ctx: Parameters<Parameters<typeof pi.on>[1]>["1"],
  ): Promise<void> {
    const arg = args.trim().toLowerCase();

    switch (arg) {
      case "on":
        config.disabled = false;
        ctx.ui.notify("LoopGuard enabled", "info");
        break;

      case "off":
        config.disabled = true;
        ctx.ui.notify("LoopGuard disabled", "info");
        break;

      case "status":
        ctx.ui.notify(
          `LoopGuard: ${config.disabled ? "disabled" : "enabled"} | ` +
            `thresholds: ${Object.entries(config.thresholds)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")}`,
          "info",
        );
        break;

      default:
        ctx.ui.notify(
          `LoopGuard: ${config.disabled ? "disabled" : "enabled"} | ` +
            `use: on|off|status`,
          "info",
        );
    }

    updateFooter(ctx);
  }

  function isResetCommand(input: unknown): boolean {
    if (typeof input !== "object" || !input) return false;
    const command = (input as { command?: string }).command;
    if (typeof command !== "string") return false;
    const trimmed = command.trim().toLowerCase();
    return trimmed === "echo '/loopguard reset'" || trimmed === 'echo "/loopguard reset"';
  }

  function getArgumentCompletions(prefix: string) {
    const cmds = ["on", "off", "status"];
    const filtered = cmds.filter((c) => c.startsWith(prefix));
    return filtered.length > 0
      ? filtered.map((c) => ({ value: c, label: c }))
      : null;
  }

  // ── Footer status indicator ──────────────────────────────────────────────

  function updateFooter(
    ctx: Parameters<Parameters<typeof pi.on>[1]>["1"],
  ): void {
    if (config.disabled) {
      ctx.ui.setStatus("loop-guard", "👁️ LoopGuard: off");
      return;
    }

    const repeats = countRepeats(turnState);

    if (repeats === 0) {
      ctx.ui.setStatus("loop-guard", "👁️ LoopGuard: ok");
    } else {
      ctx.ui.setStatus(
        "loop-guard",
        `👁️ LoopGuard: ${repeats} repeat${repeats > 1 ? "s" : ""}, ${turnState.blockedCount} blocked`,
      );
    }
  }

}
