#!/usr/bin/env bash
# prompt-directive.sh — UserPromptSubmit hook (ADR 0005, amendment 2). DEFAULT-ON proactive reinforcement:
# re-injects the full-framework directive every prompt so usage stays salient (the once-read SessionStart
# directive was obeyed 0/2 — ADR 0005 amendment 2); opt out with PROMPT_DIRECTIVE=0; trimmed to ~2 lines;
# auto-silent in CI. REFRESHED on update; do NOT edit (local tweaks -> hooks/local.d/).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck disable=SC1091
[ -f "$ROOT/.claude/tdd.config" ] && . "$ROOT/.claude/tdd.config"
[ "${PROMPT_DIRECTIVE:-1}" = "0" ] && exit 0   # default-ON (ADR 0005 amendment 2): inject unless explicitly PROMPT_DIRECTIVE=0
[ -n "${CI:-}" ] && exit 0   # context-aware: no every-prompt injection in CI / automated / non-interactive runs

printf '%s\n' "[team-tactics] Operate the FULL framework, scaled to the task — a trivial ask needs no ceremony, but REAL work gets the team + the red->green loop, not a solo edit."
_team=""; [ -f "$ROOT/.claude/agents/product-owner.md" ] && _team=" Engage the outer team (product-owner accepts vs the brief, architect owns the seams/ADRs, qa-verifier drives the running app, project-manager/dev-ops cut the release)."
printf '%s\n' "  Inner loop: set phase+layer -> red->test-writer / green->implementer, tdd-critic every few cycles. Coordinate on the tic bus; the suite decides done, not you.$_team (Opt out: PROMPT_DIRECTIVE=0.)"
exit 0
