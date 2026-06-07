import assert from "node:assert/strict";
import test from "node:test";
import { createActor } from "xstate";
import {
  canTriggerCompaction,
  chooseCompactionReason,
  countOversizedToolResults,
  createLifecycleMachine,
  defaultTuning,
  durableCaptureReminder,
  statusLine,
} from "../src/extension-core.js";

test("chooses queued seam before preturn budget", () => {
  assert.equal(defaultTuning.queuedSeamPercent, 65);
  assert.equal(defaultTuning.preturnBudgetPercent, 80);
  assert.equal(chooseCompactionReason({ percent: 66, hasPendingMessages: true }), "queued_seam");
  assert.equal(chooseCompactionReason({ percent: 66, hasPendingMessages: false }), undefined);
  assert.equal(chooseCompactionReason({ percent: 81, hasPendingMessages: false }), "preturn_budget");
});

test("cooldown prevents duplicate proactive compactions", () => {
  const actor = createActor(createLifecycleMachine()).start();
  actor.send({ type: "BEGIN", reason: "session_before_compact", now: 999 });
  actor.send({ type: "FINISH", now: 1_000 });

  assert.equal(canTriggerCompaction({ context: actor.getSnapshot().context, now: 1_000 + defaultTuning.cooldownMs }), false);
  assert.equal(canTriggerCompaction({ context: actor.getSnapshot().context, now: 1_001 + defaultTuning.cooldownMs }), true);
});

test("lifecycle machine counts one compaction per session_compact finish", () => {
  const actor = createActor(createLifecycleMachine()).start();

  actor.send({ type: "SCHEDULE", reason: "preturn_budget", now: 100 });
  actor.send({ type: "BEGIN", reason: "session_before_compact", now: 101 });
  actor.send({ type: "FINISH", now: 200 });

  const ctx = actor.getSnapshot().context;
  assert.equal(ctx.phase, "cooldown");
  assert.equal(ctx.compactions, 1);
  assert.equal(ctx.lastCompactAt, 200);
  assert.match(statusLine(ctx), /1 compacted/);
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
