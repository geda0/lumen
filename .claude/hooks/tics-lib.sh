#!/usr/bin/env bash
# tics-lib.sh — the TIC PROTOCOL mechanism (emit_tic + the store). Method-agnostic coordination
# substrate; sourced by tic.sh and by tdd-pairing's lib.sh. REFRESHED on update; do NOT edit.
_tics_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
: "${ROOT:=$(cd "$_tics_lib_dir/../.." && pwd)}"
# shellcheck disable=SC1091
[ -f "$ROOT/.claude/tdd.config" ] && . "$ROOT/.claude/tdd.config"
: "${TICS:=1}"
: "${TIC_STORE:=jsonl}"
# Append one structured agent-to-agent communication unit. Store = .claude/state/tics.jsonl
# (append) or, with TIC_STORE=spool, one file per tic under .claude/state/tics.d/ (concurrency-safe).
# scope is ambient: TICS_SCOPE (per-call, for fan-out) else .claude/state/scope, else the active
# LAYER, else "*". TICS_DIR shares one spool across worktrees; TICS_FILE overrides the jsonl path.
# emit_tic FROM TO KIND MSG [REF] [RESULT] [EXTRA_JSON]
_tic_esc() { printf '%s' "$1" | tr -d '\r\n' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
emit_tic() {
  [ "${TICS:-1}" = "1" ] || return 0
  _tf="${TICS_FILE:-$ROOT/.claude/state/tics.jsonl}"
  _td="${TICS_DIR:-$ROOT/.claude/state/tics.d}"
  mkdir -p "$ROOT/.claude/state" 2>/dev/null || true
  _seq=$(( $({ cat "$_tf" 2>/dev/null; cat "$_td"/*.json 2>/dev/null; } | wc -l) + 1 ))
  _ph="$(cat "$ROOT/.claude/state/phase" 2>/dev/null || echo unknown)"
  _ly="$(cat "$ROOT/.claude/state/layer" 2>/dev/null || echo unknown)"
  _sc="${TICS_SCOPE:-$(cat "$ROOT/.claude/state/scope" 2>/dev/null)}"
  if [ -z "$_sc" ]; then
    if [ -n "$_ly" ] && [ "$_ly" != "unknown" ]; then _sc="$_ly"; else _sc="*"; fi
  fi
  # session identity (ADR 0002): which session emitted this tic — TICS_SESSION (per-process) else
  # .claude/state/session, else empty. Lets claims/commits tell which LIVE session owns what.
  _se="${TICS_SESSION:-$(cat "$ROOT/.claude/state/session" 2>/dev/null)}"
  if [ "${TIC_STORE:-jsonl}" = "spool" ]; then
    mkdir -p "$_td" 2>/dev/null || true
    _out="$_td/$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM:-0}.json"
  else
    _out="$_tf"
  fi
  printf '{"ts":"%s","seq":%s,"kind":"%s","from":"%s","to":"%s","phase":"%s","layer":"%s","scope":"%s","session":"%s","msg":"%s","ref":"%s","result":"%s"%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$_seq" \
    "$(_tic_esc "${3:-note}")" "$(_tic_esc "${1:-?}")" "$(_tic_esc "${2:-*}")" \
    "$(_tic_esc "$_ph")" "$(_tic_esc "$_ly")" "$(_tic_esc "$_sc")" "$(_tic_esc "$_se")" \
    "$(_tic_esc "${4:-}")" "$(_tic_esc "${5:-}")" "$(_tic_esc "${6:-}")" "${7:-}" \
    >> "$_out" 2>/dev/null || true
}
