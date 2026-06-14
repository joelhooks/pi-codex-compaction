import { appendFileSync } from "node:fs";
import { assign, setup } from "xstate";

export type Phase = "idle" | "scheduled" | "compacting" | "cooldown";
export type Reason = "startup" | "queued_seam" | "preturn_budget" | "manual" | "session_before_compact";

export type LifecycleContext = {
  phase: Phase;
  lastReason: Reason;
  lastCompactAt: number;
  compactions: number;
  skipped: number;
};

export type LifecycleEvent =
  | { type: "SCHEDULE"; reason: Reason; now: number }
  | { type: "BEGIN"; reason: Reason; now: number }
  | { type: "FINISH"; now: number }
  | { type: "SKIP" }
  | { type: "RESET" };

export type Tuning = {
  proactiveEnabled: boolean;
  cooldownMs: number;
  queuedSeamPercent: number;
  preturnBudgetPercent: number;
  queuedSeamTokens: number;
  preturnBudgetTokens: number;
  toolOutputRewriteThresholdChars: number;
};

export const defaultTuning: Tuning = {
  // Owner mode stays on even when Pi core compaction is enabled: core handles
  // overflow compact-and-retry, while this extension prevents bad model metadata
  // (for example a bogus 400k window) from waiting too long.
  proactiveEnabled: true,
  cooldownMs: 60_000,
  queuedSeamPercent: 65,
  preturnBudgetPercent: 80,
  queuedSeamTokens: 120_000,
  preturnBudgetTokens: 150_000,
  toolOutputRewriteThresholdChars: 8_000,
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
    queuedSeamTokens: numberFromEnv("PI_CODEX_COMPACTION_QUEUED_TOKENS", defaultTuning.queuedSeamTokens),
    preturnBudgetTokens: numberFromEnv("PI_CODEX_COMPACTION_PRETURN_TOKENS", defaultTuning.preturnBudgetTokens),
    toolOutputRewriteThresholdChars: numberFromEnv(
      "PI_CODEX_COMPACTION_TOOL_OUTPUT_CHARS",
      defaultTuning.toolOutputRewriteThresholdChars,
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

function meetsLimit(value: number | null | undefined, limit: number): boolean {
  return value !== null && value !== undefined && value >= limit;
}

export function chooseCompactionReason(args: {
  tokens?: number | null | undefined;
  percent: number | null | undefined;
  hasPendingMessages: boolean;
  tuning?: Tuning;
}): Reason | undefined {
  const tuning = args.tuning ?? defaultTuning;
  const tokens = args.tokens;
  const percent = args.percent;
  const queuedLimitReached =
    meetsLimit(tokens, tuning.queuedSeamTokens) || meetsLimit(percent, tuning.queuedSeamPercent);
  const preturnLimitReached =
    meetsLimit(tokens, tuning.preturnBudgetTokens) || meetsLimit(percent, tuning.preturnBudgetPercent);

  if (args.hasPendingMessages && queuedLimitReached) return "queued_seam";
  if (preturnLimitReached) return "preturn_budget";
  return undefined;
}

export function canTriggerCompaction(args: { context: LifecycleContext; now: number; tuning?: Tuning }): boolean {
  const tuning = args.tuning ?? defaultTuning;
  const state = args.context;
  if (state.phase === "compacting" || state.phase === "scheduled") return false;
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

export function durableCaptureReminder(reason: Reason): string | undefined {
  if (reason !== "queued_seam") return undefined;
  return "Queued seam reminder: if this Pi install has pi-notes/Brain available, preserve any durable decisions, source maps, terms, or reusable context with `/skill:para-operator` before continuing the queued work. Keep it small and source-backed.";
}

export function statusLine(ctx: LifecycleContext) {
  return `${ctx.phase} · ${ctx.lastReason} · ${ctx.compactions} compacted · ${ctx.skipped} skipped`;
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
