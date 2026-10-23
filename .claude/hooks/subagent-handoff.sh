#!/usr/bin/env bash
# subagent-handoff.sh — SubagentStop. Auto-emits a 'handoff' tic recording that a subagent
# returned + the current suite result, so agents don't hand-emit handoffs (less overhead, a
# complete thread). Non-blocking (exit 0); the green gate is require-green-to-stop.sh.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck disable=SC1091
. "$ROOT/.claude/hooks/lib.sh"
ST="$(cat "$ROOT/.claude/state/suite-status" 2>/dev/null || echo unknown)"
emit_tic subagent orchestrator handoff "subagent returned (suite: $ST)" "" "$ST"
exit 0
