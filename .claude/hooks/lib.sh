#!/usr/bin/env bash
# lib.sh — shared MECHANISM for the TDD pairing hooks (resolver + defaults). Sources the tic
# protocol lib (@ttics/tics) for emit_tic. REFRESHED on every update; do NOT edit.
_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
: "${ROOT:=$(cd "$_lib_dir/../.." && pwd)}"

# 1) Project DATA.
# shellcheck disable=SC1091
[ -f "$ROOT/.claude/tdd.config" ] && . "$ROOT/.claude/tdd.config"

# 2) The tic protocol (emit_tic + the store) — from @ttics/tics.
# shellcheck disable=SC1091
[ -f "$ROOT/.claude/hooks/tics-lib.sh" ] && . "$ROOT/.claude/hooks/tics-lib.sh"

# 3) Mechanism defaults (tdd-pairing).
: "${DEFAULT_TEST_GLOB:=(\.test\.|\.spec\.|(^|/)tests?/|(^|/)__tests__/)}"
: "${DEFAULT_SRC_GLOB:=(^|/)src/}"
: "${ALL_TEST_CMD:=npm test}"
: "${TAIL_LINES:=40}"
: "${TELEMETRY:=1}"
: "${CLAIMS_ENFORCE:=1}"
: "${RED_STREAK_LIMIT:=5}"
: "${SESSION_BASELINE_CHECK:=1}"
: "${BASELINE_CMD:=$ALL_TEST_CMD}"
: "${TEAM_ACCOUNTABILITY:=1}"
: "${SOLO_DRIFT_CYCLES:=3}"

# 4) Resolver (bash 3.2 safe).
resolve_layer() {
  _l="$1"
  eval "TEST_CMD=\"\${TEST_CMD_${_l}:-}\""
  eval "TEST_GLOB=\"\${TEST_GLOB_${_l}:-}\""
  eval "SRC_GLOB=\"\${SRC_GLOB_${_l}:-}\""
  if [ -z "$TEST_CMD" ]; then
    case "$_l" in
      backend)  TEST_CMD="${BE_TEST_CMD:-}" ;;
      frontend) TEST_CMD="${FE_TEST_CMD:-}" ;;
      e2e)      TEST_CMD="${E2E_TEST_CMD:-}" ;;
    esac
  fi
  [ -n "$TEST_CMD" ]  || TEST_CMD="$ALL_TEST_CMD"
  [ -n "$TEST_GLOB" ] || TEST_GLOB="$DEFAULT_TEST_GLOB"
  [ -n "$SRC_GLOB" ]  || SRC_GLOB="$DEFAULT_SRC_GLOB"
}

# Project extension point.
for _f in "$ROOT"/.claude/hooks/local.d/*.sh; do [ -f "$_f" ] && . "$_f"; done
