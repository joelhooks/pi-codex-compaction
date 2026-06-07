#!/usr/bin/env tsx
/**
 * THROWAWAY PROTOTYPE.
 *
 * Question: what compaction lifecycle gets Pi closer to Codex's "I never notice it" feel?
 *
 * Run: npm run demo
 * Run one: npm run demo:preturn | npm run demo:midturn | npm run demo:overflow | npm run demo:tool-puke
 */

import { assign, createActor, setup } from "xstate";

type ScenarioName = "preturn" | "midturn" | "overflow" | "tool-puke";

type CompactionReason = "none" | "context_limit" | "overflow_recovery" | "model_followup";
type CompactionPhase = "none" | "pre_turn" | "mid_turn";

type Ctx = {
  activeTokens: number;
  prefixTokens: number;
  bodyTokens: number;
  autoLimit: number;
  contextWindow: number;
  keepRecentTokens: number;
  largestToolOutputTokens: number;
  queuedInput: boolean;
  modelNeedsFollowup: boolean;
  overflowRecoveryAttempted: boolean;
  compactions: number;
  lastReason: CompactionReason;
  lastPhase: CompactionPhase;
  rewrittenToolOutputs: number;
  visibleInterruptions: number;
  notes: string[];
};

type Ev =
  | { type: "USER"; tokens: number }
  | { type: "ASSISTANT"; tokens: number; needsFollowup?: boolean }
  | { type: "TOOL_OUTPUT"; tokens: number }
  | { type: "QUEUE_INPUT"; tokens: number }
  | { type: "CHECK_PRE_TURN" }
  | { type: "CHECK_MID_TURN" }
  | { type: "OVERFLOW" }
  | { type: "COMPACT"; phase: CompactionPhase; reason: CompactionReason }
  | { type: "DONE" };

const initialContext: Ctx = {
  activeTokens: 120,
  prefixTokens: 90,
  bodyTokens: 30,
  autoLimit: 140,
  contextWindow: 190,
  keepRecentTokens: 45,
  largestToolOutputTokens: 0,
  queuedInput: false,
  modelNeedsFollowup: false,
  overflowRecoveryAttempted: false,
  compactions: 0,
  lastReason: "none",
  lastPhase: "none",
  rewrittenToolOutputs: 0,
  visibleInterruptions: 0,
  notes: ["body-after-prefix budget starts after stable prompt/context prefix"],
};

const tokenLimitReached = ({ context }: { context: Ctx }) =>
  context.bodyTokens >= context.autoLimit || context.activeTokens >= context.contextWindow;

const shouldMidTurnCompact = ({ context }: { context: Ctx }) =>
  tokenLimitReached({ context }) && (context.modelNeedsFollowup || context.queuedInput);

const shouldRewriteToolOutput = ({ context }: { context: Ctx }) => context.largestToolOutputTokens > 64;

const compactedContext = (ctx: Ctx, phase: CompactionPhase, reason: CompactionReason): Ctx => {
  const rewrote = ctx.largestToolOutputTokens > 64;
  const afterBody = Math.min(ctx.bodyTokens, ctx.keepRecentTokens);
  const afterActive = ctx.prefixTokens + afterBody;

  return {
    ...ctx,
    activeTokens: afterActive,
    bodyTokens: afterBody,
    largestToolOutputTokens: rewrote ? 8 : ctx.largestToolOutputTokens,
    compactions: ctx.compactions + 1,
    lastReason: reason,
    lastPhase: phase,
    rewrittenToolOutputs: ctx.rewrittenToolOutputs + (rewrote ? 1 : 0),
    // Pre/mid turn compaction is deliberately quiet. Overflow recovery is visible once.
    visibleInterruptions: ctx.visibleInterruptions + (reason === "overflow_recovery" ? 1 : 0),
    modelNeedsFollowup: false,
    queuedInput: false,
    notes: [
      ...ctx.notes,
      `${phase}: compacted for ${reason}; active ${ctx.activeTokens} -> ${afterActive}`,
      ...(rewrote ? ["rewrote oversized tool output before summarization"] : []),
    ],
  };
};

const machine = setup({
  types: {} as { context: Ctx; events: Ev },
  guards: {
    tokenLimitReached,
    shouldMidTurnCompact,
    shouldRewriteToolOutput,
    canRecoverOverflow: ({ context }) => !context.overflowRecoveryAttempted,
  },
  actions: {
    addUser: assign(({ context, event }) => {
      if (event.type !== "USER") return context;
      return {
        ...context,
        activeTokens: context.activeTokens + event.tokens,
        bodyTokens: context.bodyTokens + event.tokens,
        notes: [...context.notes, `user added ${event.tokens} body tokens`],
      };
    }),
    addAssistant: assign(({ context, event }) => {
      if (event.type !== "ASSISTANT") return context;
      return {
        ...context,
        activeTokens: context.activeTokens + event.tokens,
        bodyTokens: context.bodyTokens + event.tokens,
        modelNeedsFollowup: Boolean(event.needsFollowup),
        notes: [
          ...context.notes,
          `assistant added ${event.tokens} tokens${event.needsFollowup ? " and needs follow-up" : ""}`,
        ],
      };
    }),
    addToolOutput: assign(({ context, event }) => {
      if (event.type !== "TOOL_OUTPUT") return context;
      return {
        ...context,
        activeTokens: context.activeTokens + event.tokens,
        bodyTokens: context.bodyTokens + event.tokens,
        largestToolOutputTokens: Math.max(context.largestToolOutputTokens, event.tokens),
        notes: [...context.notes, `tool output added ${event.tokens} tokens`],
      };
    }),
    queueInput: assign(({ context, event }) => {
      if (event.type !== "QUEUE_INPUT") return context;
      return {
        ...context,
        activeTokens: context.activeTokens + event.tokens,
        bodyTokens: context.bodyTokens + event.tokens,
        queuedInput: true,
        notes: [...context.notes, `queued user input added ${event.tokens} tokens`],
      };
    }),
    markOverflowAttempt: assign(({ context }) => ({
      ...context,
      overflowRecoveryAttempted: true,
      notes: [...context.notes, "overflow observed; remove failed assistant error and compact before retry"],
    })),
    compact: assign(({ context, event }) => {
      if (event.type !== "COMPACT") return context;
      return compactedContext(context, event.phase, event.reason);
    }),
    noOpNote: assign(({ context, event }) => ({
      ...context,
      notes: [...context.notes, `${event.type}: no compaction`],
    })),
  },
}).createMachine({
  id: "codexStyleCompactionPrototype",
  initial: "ready",
  context: initialContext,
  states: {
    ready: {
      on: {
        USER: { actions: "addUser" },
        ASSISTANT: { actions: "addAssistant" },
        TOOL_OUTPUT: { actions: "addToolOutput" },
        QUEUE_INPUT: { actions: "queueInput" },
        CHECK_PRE_TURN: [
          {
            guard: "tokenLimitReached",
            target: "compacting",
            actions: assign(({ context }) => compactedContext(context, "pre_turn", "context_limit")),
          },
          { actions: "noOpNote" },
        ],
        CHECK_MID_TURN: [
          {
            guard: "shouldMidTurnCompact",
            target: "compacting",
            actions: assign(({ context }) => compactedContext(context, "mid_turn", "model_followup")),
          },
          { actions: "noOpNote" },
        ],
        OVERFLOW: [
          {
            guard: "canRecoverOverflow",
            target: "retrying",
            actions: ["markOverflowAttempt", assign(({ context }) => compactedContext(context, "pre_turn", "overflow_recovery"))],
          },
          { target: "failed", actions: "noOpNote" },
        ],
        DONE: "done",
      },
    },
    compacting: {
      always: "ready",
    },
    retrying: {
      always: "ready",
    },
    failed: {},
    done: {},
  },
});

const scenarios: Record<ScenarioName, Ev[]> = {
  preturn: [
    { type: "USER", tokens: 60 },
    { type: "ASSISTANT", tokens: 30 },
    { type: "CHECK_PRE_TURN" },
    { type: "DONE" },
  ],
  midturn: [
    { type: "USER", tokens: 20 },
    { type: "ASSISTANT", tokens: 80, needsFollowup: true },
    { type: "CHECK_MID_TURN" },
    { type: "ASSISTANT", tokens: 16 },
    { type: "DONE" },
  ],
  overflow: [
    { type: "USER", tokens: 80 },
    { type: "OVERFLOW" },
    { type: "ASSISTANT", tokens: 18 },
    { type: "DONE" },
  ],
  "tool-puke": [
    { type: "USER", tokens: 20 },
    { type: "TOOL_OUTPUT", tokens: 180 },
    { type: "ASSISTANT", tokens: 10, needsFollowup: true },
    { type: "CHECK_MID_TURN" },
    { type: "DONE" },
  ],
};

function summarize(ctx: Ctx) {
  return {
    stateTokens: `${ctx.activeTokens}/${ctx.contextWindow}`,
    bodyTokens: `${ctx.bodyTokens}/${ctx.autoLimit}`,
    compactions: ctx.compactions,
    last: `${ctx.lastPhase}:${ctx.lastReason}`,
    rewrittenToolOutputs: ctx.rewrittenToolOutputs,
    visibleInterruptions: ctx.visibleInterruptions,
  };
}

function runScenario(name: ScenarioName) {
  const actor = createActor(machine);
  actor.start();

  console.log(`\n=== ${name} ===`);
  console.table([{ event: "START", ...summarize(actor.getSnapshot().context) }]);

  for (const event of scenarios[name]) {
    actor.send(event);
    console.table([{ event: event.type, ...summarize(actor.getSnapshot().context) }]);
  }

  const ctx = actor.getSnapshot().context;
  console.log("notes:");
  for (const note of ctx.notes) console.log(`- ${note}`);

  const answer = ctx.visibleInterruptions > 0
    ? "visible once: overflow recovery is still a user-noticeable fallback"
    : ctx.compactions > 0
      ? "quiet: compaction happened at a seam, user should barely notice"
      : "no compaction: still below the trigger";
  console.log(`decision signal: ${answer}`);
}

const selected = process.argv[2] as ScenarioName | undefined;
if (selected) {
  if (!scenarios[selected]) {
    console.error(`Unknown scenario: ${selected}`);
    console.error(`Known: ${Object.keys(scenarios).join(", ")}`);
    process.exit(1);
  }
  runScenario(selected);
} else {
  for (const name of Object.keys(scenarios) as ScenarioName[]) runScenario(name);
}
