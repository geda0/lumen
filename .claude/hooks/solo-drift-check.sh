#!/usr/bin/env bash
# solo-drift-check.sh — Stop hook (NON-BLOCKING). Notes when a session shipped
# substantial solo work despite full-team being installed. Purely advisory: always
# exits 0. Set TEAM_ACCOUNTABILITY=0 in tdd.config to silence it entirely.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck disable=SC1091
. "$ROOT/.claude/hooks/lib.sh"

[ "${TEAM_ACCOUNTABILITY:-1}" = "1" ] || exit 0
[ -f "$ROOT/.claude/agents/product-owner.md" ] || exit 0   # minimal install -> no team -> silent

marker="$(cat "$ROOT/.claude/state/session-started" 2>/dev/null)"; [ -n "$marker" ] || exit 0

TF="$ROOT/.claude/state/tics.jsonl"; TD="$ROOT/.claude/state/tics.d"
count_since() {
  { cat "$TF" 2>/dev/null; cat "$TD"/*.json 2>/dev/null; } \
    | grep "\"kind\":\"$1\"" \
    | sed -n 's/.*"ts":"\([^"]*\)".*/\1/p' \
    | awk -v m="$marker" '$0 >= m' \
    | wc -l | tr -d ' '
}

# Count REAL delegations: handoffs stamped from=subagent, emitted ONLY by the SubagentStop hook
# (subagent-handoff.sh, via emit_tic). Agents cannot forge this — `subagent` is in RESERVED_FROM, so
# tic_emit/tic.sh reject it (ADR 0018); narrated delegate/handoff tics carry a role `from`, not subagent.
# (This is a per-CC-session backstop: a cross-tool Cursor `from=cursor` handoff is intentionally not counted.)
count_real_handoffs() {
  { cat "$TF" 2>/dev/null; cat "$TD"/*.json 2>/dev/null; } \
    | grep '"kind":"handoff"' | grep '"from":"subagent"' \
    | sed -n 's/.*"ts":"\([^"]*\)".*/\1/p' \
    | awk -v m="$marker" '$0 >= m' \
    | wc -l | tr -d ' '
}

cycles="$(count_since signal)"; handoffs="$(count_real_handoffs)"

if [ "${cycles:-0}" -ge "${SOLO_DRIFT_CYCLES:-3}" ] && [ "${handoffs:-0}" -eq 0 ]; then
  echo "" >&2
  echo "NOTE: the full TEAM is installed but wasn't engaged this session." >&2
  echo "  $cycles suite cycles ran with 0 REAL delegations (subagent handoffs —" >&2
  echo "  narrating delegate/handoff tics does NOT count; actually spawn test-writer/implementer)." >&2
  echo "  Delegate red->test-writer, green->implementer, etc. so the team does its job." >&2
  echo "  To opt out: add TEAM_ACCOUNTABILITY=0 to .claude/tdd.config" >&2
fi
exit 0
