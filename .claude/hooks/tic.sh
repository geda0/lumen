#!/usr/bin/env bash
# tic.sh — EMIT one tic. Not a wired hook; call from Bash:
#   .claude/hooks/tic.sh FROM TO KIND MSG [REF] [RESULT]
# To READ tics, use the reader: .claude/hooks/tics inbox <role> [--scope <s>]  (or log/conductor/claims)
# Kinds: delegate handoff signal block stuck verdict msg note claim release contract need section session commit.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck disable=SC1091
. "$ROOT/.claude/hooks/tics-lib.sh"
# Arg hardening: FROM/TO are positional role names, never flags. A leading '-' means a flag bled
# into a positional slot (shifted args) — reject so garbled junk never reaches the append-only bus.
case "${1:-}" in -*) echo "tic.sh: FROM ('$1') looks like a flag — usage: tic.sh FROM TO KIND MSG [REF] [RESULT]. Nothing recorded." >&2; exit 2 ;; esac
case "${2:-}" in -*) echo "tic.sh: TO ('$2') looks like a flag — usage: tic.sh FROM TO KIND MSG [REF] [RESULT]. Nothing recorded." >&2; exit 2 ;; esac
case "${1:-}" in subagent|run-suite|guard|witness) echo "tic.sh: FROM ('$1') is a hook-only identity — agents cannot self-assert it (reserved for the run-suite/subagent/guard/witness hooks). Nothing recorded." >&2; exit 2 ;; esac
case "${3:-}" in
  delegate|handoff|signal|block|stuck|verdict|msg|note|claim|release|contract|need|section|session|commit|landmark)
    emit_tic "$@" ;;
  log|inbox|conductor|claims|sections|cycle|report|-*)
    echo "tic.sh EMITS tics; it does not read them. To READ, run the reader: .claude/hooks/tics <log | inbox <role> | conductor | claims | sections> [--scope <scope>]. Nothing recorded." >&2
    exit 2 ;;
  *)
    echo "tic.sh: '${3:-}' is not a tic kind. Valid: delegate handoff signal block stuck verdict msg note claim release contract need section session commit landmark. Nothing recorded. Usage: tic.sh FROM TO KIND MSG [REF] [RESULT]" >&2
    exit 2 ;;
esac
