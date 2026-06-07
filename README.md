# pi-codex-compaction

Codex-style compaction lifecycle extension for Pi.

This is installed locally on Joel's machine as a Pi package. It owns proactive compaction because Pi's built-in autocompact is intentionally off.

## Behavior

- Runs owner-mode compaction before a turn when context pressure crosses the configured threshold.
- Customizes manual `/compact` and extension-triggered compaction through `session_before_compact`.
- Produces concise resume checkpoints, not verbose transcripts.
- Preserves objective, constraints, changed/read files, important commands/results, errors, decisions, and next action.
- Records `details.codexStyleCompaction` on compaction entries for receipts.
- Uses a small XState lifecycle machine for `idle -> scheduled -> compacting -> cooldown` instead of boolean soup.

## Defaults

Because Pi's built-in autocompact is currently off, proactive owner mode defaults to on.

| Setting | Default | Env |
| --- | ---: | --- |
| Owner-mode proactive compaction | on | `PI_CODEX_COMPACTION_PROACTIVE=0` disables |
| Pre-turn compaction threshold | `80%` | `PI_CODEX_COMPACTION_PRETURN_PERCENT=80` |
| Queued/pending seam threshold | `65%` | `PI_CODEX_COMPACTION_QUEUED_PERCENT=65` |
| Cooldown | `60000ms` | `PI_CODEX_COMPACTION_COOLDOWN_MS=60000` |
| Oversized tool-result rewrite marker | `8000 chars` | `PI_CODEX_COMPACTION_TOOL_OUTPUT_CHARS=8000` |

If Pi's built-in autocompact is re-enabled, disable owner mode to avoid competing compaction triggers:

```bash
PI_CODEX_COMPACTION_PROACTIVE=0 pi
```

Debug event decisions when testing:

```bash
PI_CODEX_COMPACTION_DEBUG_LOG=/tmp/pi-codex-compaction-debug.jsonl pi
```

## Commands

```text
/codex-compaction
```

Shows lifecycle status.

## Test

```bash
npm install
npm test
```

Real smoke:

```bash
cd /Users/joel/Code/joelhooks
pi --no-session --no-tools --model openai-codex/gpt-5.5 -p "Reply exactly: OK"
```

Forced owner-mode compaction smoke:

1. Use a temp project with Pi compaction disabled:

```json
{
  "compaction": {
    "enabled": false,
    "reserveTokens": 999999,
    "keepRecentTokens": 1
  }
}
```

2. Run two turns with forced low thresholds:

```bash
PI_CODEX_COMPACTION_DEBUG_LOG="$log" PI_CODEX_COMPACTION_PRETURN_PERCENT=0 PI_CODEX_COMPACTION_COOLDOWN_MS=0 pi --session-dir "$sess" --model openai-codex/gpt-5.5 --no-tools -p "First turn. Reply with exactly: FIRST"
PI_CODEX_COMPACTION_DEBUG_LOG="$log" PI_CODEX_COMPACTION_PRETURN_PERCENT=0 PI_CODEX_COMPACTION_COOLDOWN_MS=0 pi --session-dir "$sess" --continue --model openai-codex/gpt-5.5 --no-tools -p "Second turn. Reply with exactly: SECOND"
```

Expected: first fresh turn skips empty context; second turn compacts pre-turn and writes one compaction entry with `details.codexStyleCompaction`.

## Prototype harness

The prototype remains as a dev harness for exercising lifecycle scenarios without launching Pi:

```bash
npm run demo
npm run demo:preturn
npm run demo:midturn
npm run demo:overflow
npm run demo:tool-puke
```

See `src/prototype/compaction-machine.ts`.
