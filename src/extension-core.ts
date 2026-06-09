import { appendFileSync } from "node:fs";
import { assign, setup } from "xstate";

export type Phase = "idle" | "scheduled" | "compacting" | "cooldown";
export type Reason = "startup" | "queued_seam" | "preturn_budget" | "hard_budget" | "manual" | "session_before_compact";
export type ToolRewriteReason = "single_result" | "tool_loop_budget";

export type LifecycleContext = {
  phase: Phase;
  lastReason: Reason;
  lastCompactAt: number;
  compactions: number;
  skipped: number;
  toolResultsRewritten: number;
};

export type LifecycleEvent =
  | { type: "SCHEDULE"; reason: Reason; now: number }
  | { type: "BEGIN"; reason: Reason; now: number }
  | { type: "FINISH"; now: number }
  | { type: "SKIP" }
  | { type: "TOOL_REWRITE" }
  | { type: "RESET" };

export type Tuning = {
  proactiveEnabled: boolean;
  cooldownMs: number;
  queuedSeamPercent: number;
  preturnBudgetPercent: number;
  hardBudgetPercent: number;
  toolOutputRewriteThresholdChars: number;
  toolLoopOutputBudgetChars: number;
  toolOutputPreviewChars: number;
};

export const defaultTuning: Tuning = {
  // Owner mode by default because Joel runs Pi's built-in autocompact off.
  // Disable with PI_CODEX_COMPACTION_PROACTIVE=0 if Pi autocompact is re-enabled.
  proactiveEnabled: true,
  cooldownMs: 60_000,
  // Compact at seams long before Codex is under pressure. Huge tool loops are handled
  // separately by tool-result dieting so this does not need to fire every few calls.
  queuedSeamPercent: 40,
  preturnBudgetPercent: 50,
  // Emergency ceiling: ignore cooldown, but still refuse concurrent compactions.
  hardBudgetPercent: 65,
  toolOutputRewriteThresholdChars: 24_000,
  toolLoopOutputBudgetChars: 48_000,
  toolOutputPreviewChars: 6_000,
};

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function booleanFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.toLowerCase();
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  return fallback;
}

export function tuningFromEnv(): Tuning {
  return {
    proactiveEnabled: booleanFromEnv("PI_CODEX_COMPACTION_PROACTIVE", defaultTuning.proactiveEnabled),
    cooldownMs: numberFromEnv("PI_CODEX_COMPACTION_COOLDOWN_MS", defaultTuning.cooldownMs),
    queuedSeamPercent: numberFromEnv("PI_CODEX_COMPACTION_QUEUED_PERCENT", defaultTuning.queuedSeamPercent),
    preturnBudgetPercent: numberFromEnv("PI_CODEX_COMPACTION_PRETURN_PERCENT", defaultTuning.preturnBudgetPercent),
    hardBudgetPercent: numberFromEnv("PI_CODEX_COMPACTION_HARD_PERCENT", defaultTuning.hardBudgetPercent),
    toolOutputRewriteThresholdChars: numberFromEnv(
      "PI_CODEX_COMPACTION_TOOL_OUTPUT_CHARS",
      defaultTuning.toolOutputRewriteThresholdChars,
    ),
    toolLoopOutputBudgetChars: numberFromEnv(
      "PI_CODEX_COMPACTION_TOOL_LOOP_OUTPUT_CHARS",
      numberFromEnv("PI_CODEX_COMPACTION_TURN_TOOL_OUTPUT_CHARS", defaultTuning.toolLoopOutputBudgetChars),
    ),
    toolOutputPreviewChars: numberFromEnv(
      "PI_CODEX_COMPACTION_TOOL_OUTPUT_PREVIEW_CHARS",
      defaultTuning.toolOutputPreviewChars,
    ),
  };
}

export function createLifecycleMachine() {
  return setup({
    types: {} as { context: LifecycleContext; events: LifecycleEvent },
    actions: {
      schedule: assign(({ context, event }) =>
        event.type === "SCHEDULE" ? { ...context, phase: "scheduled", lastReason: event.reason } : context,
      ),
      begin: assign(({ context, event }) =>
        event.type === "BEGIN" ? { ...context, phase: "compacting", lastReason: event.reason } : context,
      ),
      finish: assign(({ context, event }) =>
        event.type === "FINISH"
          ? {
              ...context,
              phase: "cooldown",
              lastCompactAt: event.now,
              compactions: context.compactions + 1,
            }
          : context,
      ),
      skip: assign(({ context }) => ({ ...context, skipped: context.skipped + 1 })),
      toolRewrite: assign(({ context }) => ({ ...context, toolResultsRewritten: context.toolResultsRewritten + 1 })),
      reset: assign(({ context }) => ({ ...context, phase: "idle" })),
    },
  }).createMachine({
    id: "piCodexCompactionLifecycle",
    initial: "idle",
    context: {
      phase: "idle",
      lastReason: "startup",
      lastCompactAt: 0,
      compactions: 0,
      skipped: 0,
      toolResultsRewritten: 0,
    },
    on: {
      TOOL_REWRITE: { actions: "toolRewrite" },
    },
    states: {
      idle: {
        on: {
          SCHEDULE: { target: "scheduled", actions: "schedule" },
          BEGIN: { target: "compacting", actions: "begin" },
          SKIP: { actions: "skip" },
        },
      },
      scheduled: {
        on: {
          BEGIN: { target: "compacting", actions: "begin" },
          RESET: { target: "idle", actions: "reset" },
          SKIP: { actions: "skip" },
        },
      },
      compacting: {
        on: {
          FINISH: { target: "cooldown", actions: "finish" },
          RESET: { target: "idle", actions: "reset" },
        },
      },
      cooldown: {
        on: {
          SCHEDULE: { target: "scheduled", actions: "schedule" },
          BEGIN: { target: "compacting", actions: "begin" },
          RESET: { target: "idle", actions: "reset" },
          SKIP: { actions: "skip" },
        },
      },
    },
  });
}

export function chooseCompactionReason(args: {
  percent: number | null | undefined;
  hasPendingMessages: boolean;
  tuning?: Tuning;
}): Reason | undefined {
  const tuning = args.tuning ?? defaultTuning;
  const percent = args.percent;
  if (percent === null || percent === undefined) return undefined;
  if (percent >= tuning.hardBudgetPercent) return "hard_budget";
  if (args.hasPendingMessages && percent >= tuning.queuedSeamPercent) return "queued_seam";
  if (percent >= tuning.preturnBudgetPercent) return "preturn_budget";
  return undefined;
}

export function canTriggerCompaction(args: {
  context: LifecycleContext;
  now: number;
  tuning?: Tuning;
  force?: boolean;
}): boolean {
  const tuning = args.tuning ?? defaultTuning;
  const state = args.context;
  if (state.phase === "compacting" || state.phase === "scheduled") return false;
  if (args.force) return true;
  return args.now - state.lastCompactAt > tuning.cooldownMs;
}

export function messageText(message: unknown): string {
  const msg = message as { content?: unknown; output?: string; summary?: string };
  if (typeof msg.content === "string") return msg.content;
  if (typeof msg.output === "string") return msg.output;
  if (typeof msg.summary === "string") return msg.summary;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((block) => {
        const b = block as { text?: string; thinking?: string; arguments?: unknown };
        if (typeof b.text === "string") return b.text;
        if (typeof b.thinking === "string") return b.thinking;
        if (b.arguments) return JSON.stringify(b.arguments);
        return "";
      })
      .join("\n");
  }
  return "";
}

export function countOversizedToolResults(messages: unknown[], thresholdChars = defaultTuning.toolOutputRewriteThresholdChars): number {
  let count = 0;
  for (const message of messages) {
    const msg = message as { role?: string };
    if (msg.role === "toolResult" || msg.role === "bashExecution") {
      if (messageText(message).length > thresholdChars) count++;
    }
  }
  return count;
}

export function toolResultText(content: unknown[]): string {
  return content
    .map((block) => {
      const b = block as { text?: string; type?: string };
      return typeof b.text === "string" ? b.text : "";
    })
    .join("\n");
}

export function chooseToolResultRewriteReason(args: {
  resultChars: number;
  toolLoopResultChars: number;
  tuning?: Tuning;
}): ToolRewriteReason | undefined {
  const tuning = args.tuning ?? defaultTuning;
  if (args.resultChars <= tuning.toolOutputPreviewChars) return undefined;
  if (args.resultChars > tuning.toolOutputRewriteThresholdChars) return "single_result";
  if (args.toolLoopResultChars + args.resultChars > tuning.toolLoopOutputBudgetChars) return "tool_loop_budget";
  return undefined;
}

function truncateForMetadata(value: unknown, maxChars: number): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

export function rewriteToolResultContent(args: {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  content: unknown[];
  reason: ToolRewriteReason;
  tuning?: Tuning;
}): { content: { type: "text"; text: string }[]; originalChars: number; replacementChars: number } | undefined {
  const tuning = args.tuning ?? defaultTuning;
  const text = toolResultText(args.content);
  if (text.length <= tuning.toolOutputPreviewChars) return undefined;

  const headChars = Math.max(1, Math.floor(tuning.toolOutputPreviewChars / 2));
  const tailChars = Math.max(1, tuning.toolOutputPreviewChars - headChars);
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  const omittedChars = Math.max(0, text.length - head.length - tail.length);
  const inputSummary = truncateForMetadata(args.input, 600);

  const replacement = `[pi-codex-compaction] Large ${args.toolName} tool result compressed before model context.\n` +
    `Reason: ${args.reason}. Original chars: ${text.length}. Omitted chars: ${omittedChars}. Tool call: ${args.toolCallId}.\n` +
    `Input summary: ${inputSummary}\n` +
    `If exact output is needed, rerun a narrower command/read with offsets instead of relying on this compressed result.\n\n` +
    `--- BEGIN KEPT HEAD (${head.length} chars) ---\n${head}\n--- END KEPT HEAD ---\n\n` +
    `--- BEGIN KEPT TAIL (${tail.length} chars) ---\n${tail}\n--- END KEPT TAIL ---`;

  return {
    content: [{ type: "text", text: replacement }],
    originalChars: text.length,
    replacementChars: replacement.length,
  };
}

export function durableCaptureReminder(reason: Reason): string | undefined {
  if (reason !== "queued_seam") return undefined;
  return "Queued seam reminder: if this Pi install has pi-notes/Brain available, preserve any durable decisions, source maps, terms, or reusable context with `/skill:para-operator` before continuing the queued work. Keep it small and source-backed.";
}

export function statusLine(ctx: LifecycleContext) {
  return `${ctx.phase} · ${ctx.lastReason} · ${ctx.compactions} compacted · ${ctx.skipped} skipped · ${ctx.toolResultsRewritten} tool results dieted`;
}

export function debugLog(event: string, data: unknown): void {
  const path = process.env.PI_CODEX_COMPACTION_DEBUG_LOG;
  if (!path) return;
  try {
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), event, data }) + "\n");
  } catch {
    // Debug logging must never affect Pi.
  }
}
