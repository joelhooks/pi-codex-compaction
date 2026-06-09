import { createActor } from "xstate";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { compact } from "@mariozechner/pi-coding-agent";
import {
  canTriggerCompaction,
  chooseCompactionReason,
  chooseToolResultRewriteReason,
  countOversizedToolResults,
  createLifecycleMachine,
  debugLog,
  durableCaptureReminder,
  rewriteToolResultContent,
  statusLine,
  toolResultText,
  tuningFromEnv,
} from "./src/extension-core.js";

export default function piCodexCompaction(pi: ExtensionAPI) {
  const tuning = tuningFromEnv();
  const actor = createActor(createLifecycleMachine()).start();
  let toolLoopResultChars = 0;

  function updateStatus(ctx: { ui?: { setStatus?: (key: string, value: string) => void } }) {
    ctx.ui?.setStatus?.("codex-compaction", statusLine(actor.getSnapshot().context));
  }

  pi.on("session_start", async (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    toolLoopResultChars = 0;
    updateStatus(ctx);
  });

  pi.on("turn_start", async (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("tool_result", async (event, ctx) => {
    const resultChars = toolResultText(event.content).length;
    const reason = chooseToolResultRewriteReason({ resultChars, toolLoopResultChars, tuning });
    if (!reason) {
      toolLoopResultChars += resultChars;
      return undefined;
    }

    const rewritten = rewriteToolResultContent({
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      input: event.input,
      content: event.content,
      reason,
      tuning,
    });

    if (!rewritten) {
      toolLoopResultChars += resultChars;
      return undefined;
    }

    actor.send({ type: "TOOL_REWRITE" });
    toolLoopResultChars += rewritten.replacementChars;
    debugLog("tool_result_rewrite", {
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      reason,
      originalChars: rewritten.originalChars,
      replacementChars: rewritten.replacementChars,
      toolLoopResultChars,
      state: actor.getSnapshot().context,
    });
    updateStatus(ctx);

    return {
      content: rewritten.content,
      details: {
        ...(typeof event.details === "object" && event.details !== null ? event.details : { originalDetails: event.details }),
        codexCompactionRewrite: {
          version: 1,
          reason,
          originalChars: rewritten.originalChars,
          replacementChars: rewritten.replacementChars,
          tuning,
        },
      },
    };
  });

  async function runOwnerCompaction(ctx: ExtensionContext, reason: string) {
    return new Promise<boolean>((resolve) => {
      try {
        ctx.compact({
          customInstructions: `Codex-style lifecycle compaction. Phase: ${reason}. Keep the summary compact, source-grounded, and resume-ready. Preserve current goal, files touched, commands/results that matter, and exact next action. Treat huge tool outputs as rewritten placeholders unless their exact content is essential.`,
          onComplete: () => {
            debugLog("proactive_complete", { state: actor.getSnapshot().context });
            resolve(true);
          },
          onError: (error) => {
            actor.send({ type: "RESET" });
            debugLog("proactive_error", { message: error.message, state: actor.getSnapshot().context });
            resolve(false);
          },
        });
      } catch (error) {
        actor.send({ type: "RESET" });
        debugLog("proactive_throw", { message: error instanceof Error ? error.message : String(error) });
        resolve(false);
      }
    });
  }

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!tuning.proactiveEnabled) {
      debugLog("before_agent_start_skip", { reason: "proactive_disabled" });
      return undefined;
    }

    const usage = ctx.getContextUsage();
    const hasPendingMessages = ctx.hasPendingMessages();
    const reason = usage?.tokens && usage.tokens > 0
      ? chooseCompactionReason({
          percent: usage?.percent,
          hasPendingMessages,
          tuning,
        })
      : undefined;
    debugLog("before_agent_start", { usage, hasPendingMessages, chosenReason: reason, state: actor.getSnapshot().context });

    if (!reason) {
      updateStatus(ctx);
      return undefined;
    }

    const now = Date.now();
    if (!canTriggerCompaction({ context: actor.getSnapshot().context, now, tuning, force: reason === "hard_budget" })) {
      actor.send({ type: "SKIP" });
      debugLog("proactive_skip", { reason: "cooldown_or_inflight", compactionReason: reason, state: actor.getSnapshot().context });
      updateStatus(ctx);
      return undefined;
    }

    actor.send({ type: "SCHEDULE", reason, now });
    debugLog("proactive_schedule", { reason, state: actor.getSnapshot().context });
    updateStatus(ctx);

    await runOwnerCompaction(ctx, reason);
    return undefined;
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const now = Date.now();
    debugLog("session_before_compact", {
      messagesToSummarize: event.preparation.messagesToSummarize.length,
      turnPrefixMessages: event.preparation.turnPrefixMessages.length,
      tokensBefore: event.preparation.tokensBefore,
    });
    const beforeCompactState = actor.getSnapshot().context;
    const lifecycleReason = beforeCompactState.phase === "scheduled" ? beforeCompactState.lastReason : "session_before_compact";
    actor.send({ type: "BEGIN", reason: lifecycleReason, now });
    updateStatus(ctx);

    const oversizedToolResults = countOversizedToolResults(
      [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages],
      tuning.toolOutputRewriteThresholdChars,
    );

    const customInstructions = [
      event.customInstructions,
      "Codex-style checkpoint: concise memento, not a transcript.",
      "Preserve: current objective, constraints, changed/read files, commands run, errors, decisions, and next action.",
      "Avoid: verbose chronology, repeated tool output, generic encouragement.",
      durableCaptureReminder(lifecycleReason),
      oversizedToolResults > 0
        ? `${oversizedToolResults} oversized tool result(s) were detected; summarize their semantic result and mention that raw output was intentionally not preserved.`
        : undefined,
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const model = ctx.model;
      if (!model) return undefined;
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) return undefined;

      const result = await compact(
        event.preparation,
        model,
        auth.apiKey,
        auth.headers,
        customInstructions,
        event.signal,
      );

      return {
        compaction: {
          summary: result.summary,
          firstKeptEntryId: result.firstKeptEntryId,
          tokensBefore: result.tokensBefore,
          details: {
            ...(typeof result.details === "object" && result.details !== null ? result.details : {}),
            codexStyleCompaction: {
              version: 1,
              oversizedToolResults,
              lifecycle: actor.getSnapshot().context.lastReason,
              tuning,
            },
          },
        },
      };
    } catch (error) {
      if (!event.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Codex-style compaction failed; falling back to Pi default: ${message}`, "warning");
      }
      return undefined;
    }
  });

  pi.on("session_compact", async (_event, ctx) => {
    debugLog("session_compact", { state: actor.getSnapshot().context });
    actor.send({ type: "FINISH", now: Date.now() });
    updateStatus(ctx);
  });

  pi.registerCommand("codex-compaction", {
    description: "Show codex-style compaction lifecycle status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Codex compaction: ${statusLine(actor.getSnapshot().context)}`, "info");
    },
  });
}
