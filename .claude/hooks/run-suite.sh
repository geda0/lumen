#!/usr/bin/env bash
# run-suite.sh — PostToolUse (matcher: Edit|Write|MultiEdit)
# The arbiter. Runs the ACTIVE LAYER's suite after an edit, records green/red, surfaces
# the result, and emits one SIGNAL tic per run (.claude/state/tics.jsonl) so the PROCESS
# can be measured (cycles, retries, durations, per-layer pass rates).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck disable=SC1091
. "$ROOT/.claude/hooks/lib.sh"
mkdir -p "$ROOT/.claude/state"
STATUS="$ROOT/.claude/state/suite-status"
LAYER="$(cat "$ROOT/.claude/state/layer" 2>/dev/null || echo unknown)"
PHASE="$(cat "$ROOT/.claude/state/phase" 2>/dev/null || echo unknown)"
resolve_layer "$LAYER"

# P2-10: skip the suite for an edit that matches no layer glob — a README/config/doc edit
# must not trigger a test run. Empty stdin (manual invocation) yields no path, so it runs.
INPUT="$(cat)"
if command -v jq >/dev/null 2>&1; then
  EDITED="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null)"
else
  EDITED="$(printf '%s' "$INPUT" | grep -oE '"(file_)?path"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
fi
if [ -n "${EDITED:-}" ] && ! printf '%s' "$EDITED" | grep -qE "$TEST_GLOB" && ! printf '%s' "$EDITED" | grep -qE "$SRC_GLOB"; then
  exit 0
fi

START="$(date +%s)"
OUT="$(cd "$ROOT" && eval "$TEST_CMD" 2>&1)"; CODE=$?
# Honest green by default: if no TYPECHECK_CMD is configured, auto-detect one so a green signal
# is trustworthy (the suite alone misses type errors — e.g. noUncheckedIndexedAccess slipping past
# vitest). Prefer the project's own `typecheck` script; else `tsc --noEmit` for a TS project.
# Opt out with TYPECHECK_AUTO=0 (or set TYPECHECK_CMD explicitly).
if [ -z "${TYPECHECK_CMD:-}" ] && [ "${TYPECHECK_AUTO:-1}" = "1" ]; then
  _pm=npm; [ -f "$ROOT/pnpm-lock.yaml" ] && _pm=pnpm; [ -f "$ROOT/yarn.lock" ] && _pm=yarn
  if [ -f "$ROOT/package.json" ] && grep -q '"typecheck"[[:space:]]*:' "$ROOT/package.json" 2>/dev/null; then
    TYPECHECK_CMD="$_pm run typecheck"
  elif [ -f "$ROOT/tsconfig.json" ]; then
    if [ "$_pm" = npm ]; then TYPECHECK_CMD="npx tsc --noEmit"; else TYPECHECK_CMD="$_pm exec tsc --noEmit"; fi
  fi
fi
# Green means GREEN: on a passing suite, also run the type-check so a tests-green / tsc-red
# cycle can't pass the signal.
if [ "$CODE" -eq 0 ] && [ -n "${TYPECHECK_CMD:-}" ]; then
  TCOUT="$(cd "$ROOT" && eval "$TYPECHECK_CMD" 2>&1)"; TC=$?
  if [ "$TC" -ne 0 ]; then CODE=$TC; OUT="[typecheck RED] ($TYPECHECK_CMD)
$TCOUT"; fi
fi
DUR=$(( $(date +%s) - START ))

if [ "$CODE" -eq 0 ]; then
  echo "green" > "$STATUS"; RESULT="green"
  echo "[OK] [$LAYER] SUITE GREEN — all tests pass."
else
  echo "red" > "$STATUS"; RESULT="red"
  echo "[X] [$LAYER] SUITE RED (exit $CODE). Last ${TAIL_LINES:-40} lines:"
  printf '%s\n' "$OUT" | tail -n "${TAIL_LINES:-40}"
fi

# Red-storm breaker: track consecutive reds (reset on green). When the streak hits the limit,
# emit a `stuck` tic — a long red run usually means the failing TEST is over-constrained or
# contradictory, not that the code is wrong. Surfaces the suspicion instead of grinding.
STREAK="$ROOT/.claude/state/red-streak"
if [ "$RESULT" = "green" ]; then
  echo 0 > "$STREAK"
else
  _rs=$(( $(cat "$STREAK" 2>/dev/null || echo 0) + 1 )); echo "$_rs" > "$STREAK"
  _lim="${RED_STREAK_LIMIT:-5}"; [ "$_lim" -ge 1 ] 2>/dev/null || _lim=1   # guard the `% _lim` below against a 0/garbage misconfig
  if [ "$_rs" -ge "$_lim" ]; then
    if [ "$_rs" -ge $(( _lim * 2 )) ]; then
      _rsmsg="[red-storm] STOP grinding — $_rs reds in a row on [$LAYER]. The failing TEST is almost certainly over-constrained or wrong, not the code. Go back to phase=red and have the test-writer FIX the test, or ask the navigator — do not keep editing source."
    else
      _rsmsg="[red-storm] $_rs reds in a row on [$LAYER] — the failing test is likely over-constrained or contradictory; reconsider it (route to test-writer) or ask the navigator, don't keep grinding."
    fi
    echo "$_rsmsg"
    [ $(( _rs % _lim )) -eq 0 ] && emit_tic run-suite orchestrator stuck "$_rsmsg" "${EDITED:-}" "$_rs"
  fi
fi

# Tic: record the suite SIGNAL (subsumes the old telemetry event) — one per run, hook-emitted
# (agents cannot forge a signal). 'tics report' aggregates these; 'tics log' shows the thread.
emit_tic run-suite "*" signal "[$LAYER] suite $RESULT" "${EDITED:-}" "$RESULT" ",\"exit\":$CODE,\"durationSec\":$DUR"
exit 0
