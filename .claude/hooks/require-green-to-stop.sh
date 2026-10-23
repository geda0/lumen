#!/usr/bin/env bash
# require-green-to-stop.sh — Stop AND SubagentStop
# Refuses to finish on a red bar when phase is green/refactor. A red bar in the
# red phase is correct (we just wrote a failing test), so allow it there.
#
# A cached suite-status can be STALE: e.g. the implementer fixed the code but no
# later edit re-fired run-suite, so the last recorded status is still "red". On a
# cached red in green/refactor we RE-VERIFY (re-run the active layer's suite)
# before blocking; if it now passes we correct the status and allow the stop.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck disable=SC1091
. "$ROOT/.claude/hooks/lib.sh"
STATUS="$ROOT/.claude/state/suite-status"
PHASE="$(cat "$ROOT/.claude/state/phase" 2>/dev/null || echo unknown)"
ST="$(cat "$STATUS" 2>/dev/null || echo unknown)"

case "$PHASE" in
  green|refactor)
    if [ "$ST" = "red" ]; then
      # Cache says red — re-verify before trapping the loop (it may be stale).
      LAYER="$(cat "$ROOT/.claude/state/layer" 2>/dev/null || echo unknown)"
      resolve_layer "$LAYER"
      if OUT="$(cd "$ROOT" && eval "$TEST_CMD" 2>&1)"; then
        echo "green" > "$STATUS"     # stale red — the suite actually passes now
        exit 0
      fi
      echo "red" > "$STATUS"
      echo "Cannot stop: phase=$PHASE but the $LAYER suite is RED. Keep going until green (or revert the refactor). Do NOT edit tests to force green. Last ${TAIL_LINES:-40} lines:" >&2
      # Red-storm breaker: a long run of reds usually means the failing TEST is wrong, not the code.
      _rs=$(cat "$ROOT/.claude/state/red-streak" 2>/dev/null || echo 0)
      if [ "$_rs" -ge "${RED_STREAK_LIMIT:-5}" ]; then
        echo "WARNING: $_rs suite runs RED in a row — the failing test may be OVER-CONSTRAINED or CONTRADICTORY, not the code. Stop grinding: re-read the test; if it cannot be satisfied, route back to test-writer to fix it (never weaken it silently) or ask the navigator." >&2
      fi
      printf '%s\n' "$OUT" | tail -n "${TAIL_LINES:-40}" >&2
      exit 2
    fi ;;
esac
exit 0
