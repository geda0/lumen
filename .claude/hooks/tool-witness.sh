#!/usr/bin/env bash
# tool-witness.sh — PostToolUse (matcher: *) opt-in observer.
# Emits one note tic per tool use when TOOL_WITNESS=1. Default: off (fast no-op).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck disable=SC1091
. "$ROOT/.claude/hooks/lib.sh"

# Gate: TOOL_WITNESS must be explicitly 1 — default off.
[ "${TOOL_WITNESS:-0}" = "1" ] || exit 0

INPUT="$(cat)"
if command -v jq >/dev/null 2>&1; then
  TOOL="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)"
  EDITED="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null)"
else
  TOOL="$(printf '%s' "$INPUT" | grep -oE '"tool_name"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
  EDITED="$(printf '%s' "$INPUT" | grep -oE '"(file_)?path"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
fi

[ -n "${TOOL:-}" ] || exit 0
emit_tic witness "*" note "used $TOOL" "${EDITED:-}"
exit 0
