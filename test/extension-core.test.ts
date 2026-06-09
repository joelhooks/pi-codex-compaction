import assert from "node:assert/strict";
import test from "node:test";
import { createActor } from "xstate";
import {
  canTriggerCompaction,
  chooseCompactionReason,
  chooseToolResultRewriteReason,
  countOversizedToolResults,
  createLifecycleMachine,
  defaultTuning,
  durableCaptureReminder,
  rewriteToolResultContent,
  statusLine,
} from "../src/extension-core.js";

test("chooses early seams with a hard budget ceiling", () => {
  assert.equal(defaultTuning.queuedSeamPercent, 40);
  assert.equal(defaultTuning.preturnBudgetPercent, 50);
  assert.equal(defaultTuning.hardBudgetPercent, 65);
  assert.equal(chooseCompactionReason({ percent: 41, hasPendingMessages: true }), "queued_seam");
  assert.equal(chooseCompactionReason({ percent: 41, hasPendingMessages: false }), undefined);
  assert.equal(chooseCompactionReason({ percent: 51, hasPendingMessages: false }), "preturn_budget");
  assert.equal(chooseCompactionReason({ percent: 66, hasPendingMessages: false }), "hard_budget");
  assert.equal(chooseCompactionReason({ percent: 66, hasPendingMessages: true }), "hard_budget");
});

test("cooldown prevents duplicate proactive compactions unless hard budget forces it", () => {
  const actor = createActor(createLifecycleMachine()).start();
  actor.send({ type: "BEGIN", reason: "session_before_compact", now: 999 });
  actor.send({ type: "FINISH", now: 1_000 });

  assert.equal(canTriggerCompaction({ context: actor.getSnapshot().context, now: 1_000 + defaultTuning.cooldownMs }), false);
  assert.equal(
    canTriggerCompaction({ context: actor.getSnapshot().context, now: 1_000 + defaultTuning.cooldownMs, force: true }),
    true,
  );
  assert.equal(canTriggerCompaction({ context: actor.getSnapshot().context, now: 1_001 + defaultTuning.cooldownMs }), true);
});

test("lifecycle machine counts compactions and dieted tool results", () => {
  const actor = createActor(createLifecycleMachine()).start();

  actor.send({ type: "SCHEDULE", reason: "preturn_budget", now: 100 });
  actor.send({ type: "TOOL_REWRITE" });
  actor.send({ type: "BEGIN", reason: "session_before_compact", now: 101 });
  actor.send({ type: "FINISH", now: 200 });

  const ctx = actor.getSnapshot().context;
  assert.equal(ctx.phase, "cooldown");
  assert.equal(ctx.compactions, 1);
  assert.equal(ctx.toolResultsRewritten, 1);
  assert.equal(ctx.lastCompactAt, 200);
  assert.match(statusLine(ctx), /1 compacted/);
  assert.match(statusLine(ctx), /1 tool results dieted/);
});

test("queued seam adds a PARA capture reminder", () => {
  assert.match(durableCaptureReminder("queued_seam") ?? "", /\/skill:para-operator/);
  assert.equal(durableCaptureReminder("preturn_budget"), undefined);
});

test("counts oversized tool outputs only for tool-ish messages", () => {
  const giant = "x".repeat(101);
  const messages = [
    { role: "toolResult", content: [{ type: "text", text: giant }] },
    { role: "bashExecution", output: giant },
    { role: "assistant", content: giant },
    { role: "toolResult", content: [{ type: "text", text: "small" }] },
  ];

  assert.equal(countOversizedToolResults(messages, 100), 2);
});

test("chooses tool result rewrite for single puke or cumulative tool-loop budget", () => {
  const tuning = {
    ...defaultTuning,
    toolOutputRewriteThresholdChars: 100,
    toolLoopOutputBudgetChars: 150,
    toolOutputPreviewChars: 20,
  };

  assert.equal(chooseToolResultRewriteReason({ resultChars: 10, toolLoopResultChars: 200, tuning }), undefined);
  assert.equal(chooseToolResultRewriteReason({ resultChars: 101, toolLoopResultChars: 0, tuning }), "single_result");
  assert.equal(chooseToolResultRewriteReason({ resultChars: 80, toolLoopResultChars: 80, tuning }), "tool_loop_budget");
});

test("rewrites large tool results into explicit head tail placeholders", () => {
  const tuning = {
    ...defaultTuning,
    toolOutputRewriteThresholdChars: 100,
    toolLoopOutputBudgetChars: 150,
    toolOutputPreviewChars: 20,
  };
  const body = `HEAD-${"x".repeat(10_000)}-TAIL`;
  const rewritten = rewriteToolResultContent({
    toolName: "bash",
    toolCallId: "call-1",
    input: { command: "generate a huge result" },
    content: [{ type: "text", text: body }],
    reason: "single_result",
    tuning,
  });

  assert.ok(rewritten);
  assert.equal(rewritten.originalChars, body.length);
  assert.ok(rewritten.replacementChars < body.length);
  assert.match(rewritten.content[0].text, /compressed before model context/);
  assert.match(rewritten.content[0].text, /HEAD-/);
  assert.match(rewritten.content[0].text, /-TAIL/);
});
