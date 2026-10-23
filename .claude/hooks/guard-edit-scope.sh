#!/usr/bin/env bash
# guard-edit-scope.sh — PreToolUse (matcher: Edit|Write|MultiEdit)
# Enforces the TDD contract by phase x layer. The orchestrator writes
# .claude/state/{phase,layer} before each delegation.
#   red      -> only the active layer's TEST files may be edited
#   green    -> the active layer's TEST files may NOT be edited (source only)
#   refactor -> anything; the Stop hook keeps the bar green
# Exit 2 blocks the tool and returns the stderr message to the model; a 'block' tic
# is recorded so the refusal appears in the agent-to-agent thread.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck disable=SC1091
. "$ROOT/.claude/hooks/lib.sh"

PHASE="$(cat "$ROOT/.claude/state/phase" 2>/dev/null || echo unknown)"
LAYER="$(cat "$ROOT/.claude/state/layer" 2>/dev/null || echo unknown)"
resolve_layer "$LAYER"

INPUT="$(cat)"
# Two payload shapes (ADR 0001): Edit|Write|MultiEdit carry a path in .tool_input.file_path|.path;
# Bash carries a shell command in .tool_input.command. Extract all three; the dispatch at the
# bottom picks the branch. Fail OPEN on unparseable input — never crash the tool.
if command -v jq >/dev/null 2>&1; then
  P="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty')"
  TOOL="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')"
  CMD="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')"
else
  P="$(printf '%s' "$INPUT" | grep -oE '"(file_)?path"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
  TOOL="$(printf '%s' "$INPUT" | grep -oE '"tool_name"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
  CMD="$(printf '%s' "$INPUT" | grep -oE '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/^"command"[[:space:]]*:[[:space:]]*"(.*)"$/\1/')"
fi

is_test() { printf '%s' "$1" | grep -qE "$TEST_GLOB"; }
# Docs/ADRs aren't code-under-test — there's no failing test to write first, so the phase gate
# must not block them (esp. in red). Markdown anywhere, or anything under a docs/ tree.
is_doc() { printf '%s' "$1" | grep -qE '\.(md|mdx|markdown)$|(^|/)docs/'; }
# An ADR (architecture decision record) is a published seam — see auto-contract below.
is_adr() { printf '%s' "$1" | grep -qE '(^|/)docs/decisions/'; }
# The loop's own control plane (.claude/state/phase|layer|scope|session, progress/backlog, the bus).
# Writing it is how the orchestrator DRIVES the gate — never project code-under-test — so the phase
# gate must not block it (else you can't leave red: writing phase=green is itself refused in red).
is_control() { printf '%s' "$1" | grep -qE '(^|/)\.claude/state/'; }

# Context map (ADR 0019): on an edit, surface what we know about this path — the learned crumbs
# (landmark/route/caveat) earlier agents left, via `tics where`. Opt-in (CONTEXT_MAP=1), ADVISORY:
# printed to stderr, NEVER blocks. Silent when the reader returns nothing.
landmark_hint() {
  [ "${CONTEXT_MAP:-0}" = "1" ] || return 0
  [ -x "$ROOT/.claude/hooks/tics" ] || return 0
  _lh="$("$ROOT/.claude/hooks/tics" where "$1" 2>/dev/null)"
  [ -n "$_lh" ] || return 0
  printf 'NOTE (context map) — what we know about %s:\n%s\n' "$1" "$_lh" >&2
  return 0
}

# P1: enforced claims — block an edit to a path held by ANOTHER scope, and AUTO-CLAIM a
# still-unclaimed path for the editing scope, so disjoint-write fan-out is collision-safe
# with zero manual bookkeeping (the first toucher owns it; rivals are then blocked).
claim_guard() {
  [ "${CLAIMS_ENFORCE:-1}" = "1" ] || return 0
  [ -x "$ROOT/.claude/hooks/tics" ] || return 0          # no reader -> fail-open
  _ms="$(cat "$ROOT/.claude/state/scope" 2>/dev/null)"
  # An unscoped editor proceeds with no enforcement — scoping is an opt-in claim/observability
  # convention; git worktrees (ADR 0015) provide write-isolation, so there is no fail-closed guard.
  [ -n "$_ms" ] || return 0
  _hold="$("$ROOT/.claude/hooks/tics" claim-check "$1" "$_ms" 2>/dev/null)"; _rc=$?
  if [ "$_rc" = "3" ]; then                              # genuine cross-scope conflict -> block
    echo "BLOCKED (claim): $1 is held by $_hold. Release it, coordinate via a need tic, or set CLAIMS_ENFORCE=0 to disarm." >&2
    emit_tic guard "*" need "claim conflict on $1 (held by: $_hold)" "$1" blocked
    exit 2
  fi
  # No conflict. Auto-open the section (scope's first component) on first scoped activity,
  # so the partition map (`tics sections`) populates itself — once, never re-opened.
  _sec="${_ms%%/*}"
  _sst="$("$ROOT/.claude/hooks/tics" section-status "$_sec" 2>/dev/null)"
  [ -n "$_sst" ] || emit_tic guard "*" section "auto-open on first edit" "$_sec" open
  # Auto-claim only if still unclaimed — skip if already held (by us) so we
  # don't re-claim on every edit and spam the bus (the telemetry must stay meaningful).
  _own="$("$ROOT/.claude/hooks/tics" claim-owner "$1" 2>/dev/null)"
  [ -n "$_own" ] || emit_tic guard "*" claim "auto-claim on edit" "$1" ""
  return 0
}

# Bash write-target extraction: the paths a command would WRITE via redirection (`>`,`>>`,`tee`).
# Conservative by design (ADR 0001) — fd-dups (2>&1), unresolved $vars/globs, and indirect writes
# (sed -i, python -c, scripts) are NOT targets, so reads/builds/tests are never blocked. The
# residual (indirect writes) is a Claude Code limitation; the Stop green-gate is the backstop.
extract_write_targets() {
  printf '%s\n' "$1" \
    | grep -oE '[0-9]*>>?[[:space:]]*[^[:space:]&|;<>()`]+|(^|[[:space:]])tee([[:space:]]+-a)?[[:space:]]+[^[:space:]&|;<>()`-][^[:space:]&|;<>()`]*' \
    | sed -E 's/^[0-9]*>>?[[:space:]]*//; s/^[[:space:]]*tee([[:space:]]+-a)?[[:space:]]+//' \
    | sed -E "s/^[\"']//; s/[\"']\$//" \
    | grep -vE '[$*?`]|^&|^[0-9]+$|^/dev/' || true
}

# Sensitive-surface guard (opt-in): paths matching SECURITY_GLOB (set in tdd.config) require a
# deliberate review pass — set SECURITY_REVIEW=1 to permit the edit. Applies in EVERY phase, INCLUDING
# off, so the disarm switch can't slip auth/secret/CORS edits past review. Empty/unset glob = no-op.
security_guard() {
  [ -n "${SECURITY_GLOB:-}" ] || return 0
  printf '%s' "$1" | grep -qE "$SECURITY_GLOB" || return 0
  [ "${SECURITY_REVIEW:-0}" = "1" ] && return 0
  echo "BLOCKED (security surface): $1 matches SECURITY_GLOB and needs a review pass. Set SECURITY_REVIEW=1 for this edit (after an architect/security review), or adjust SECURITY_GLOB in tdd.config." >&2
  emit_tic guard orchestrator block "security-surface edit refused ($1) — SECURITY_REVIEW not set" "$1" blocked
  exit 2
}

# Decide ONE path under the current phase: returns 0 (allow) or exits 2 (block). Used for the
# Edit/Write file_path AND for each Bash write-target — the verdict is identical either way, so
# a Bash redirect into source is gated exactly like a Write to it.
gate_path() {
  P="$1"
  # The loop's control plane is exempt from the phase gate (writing it operates the gate). This must
  # come FIRST — otherwise transitioning red->green by writing .claude/state/phase is itself blocked.
  if is_control "$P"; then return 0; fi
  # Sensitive surfaces are gated in EVERY phase (incl. off), after the control-plane exemption.
  security_guard "$P"
  # Docs/ADRs are never code-under-test → not blocked in ANY phase (claims still apply). An ADR is
  # a published seam: auto-emit a `contract` when one is first CREATED (once; not on later edits).
  if is_doc "$P"; then
    if is_adr "$P" && ! { [ -f "$P" ] || [ -f "$ROOT/$P" ]; }; then
      emit_tic architect "*" contract "ADR: $(basename "$P")" "$P"
    fi
    claim_guard "$P"; return 0
  fi
  case "$PHASE" in
    red)
      if is_test "$P"; then claim_guard "$P"; return 0; fi
      echo "BLOCKED (phase=red, layer=$LAYER): only $LAYER TEST files may be edited now, not $P. Write the failing test; the implementer makes it pass next." >&2
      emit_tic guard orchestrator block "phase=red layer=$LAYER: source edit refused ($P) — write the failing test first" "$P" blocked
      exit 2 ;;
    green)
      if is_test "$P"; then
        echo "BLOCKED (phase=green, layer=$LAYER): tests are frozen. Do NOT edit $P. Change source to satisfy the existing test. Never weaken a test to reach green." >&2
        emit_tic guard orchestrator block "phase=green layer=$LAYER: test edit refused ($P) — tests are frozen" "$P" blocked
        exit 2
      fi
      claim_guard "$P"; return 0 ;;
    refactor) claim_guard "$P"; return 0 ;;        # anything in the layer; the Stop hook keeps the bar green
    off) return 0 ;;                                # gate disarmed for manual / non-TDD edits
    *)
      # Fail-closed: empty/typo'd/corrupted phase — a missing phase is exactly how the gate would be bypassed.
      echo "BLOCKED: phase='$PHASE' is not recognized, so the TDD gate is failing closed. Set .claude/state/phase to one of: red | green | refactor (during a cycle), or 'off' to disarm for manual edits." >&2
      emit_tic guard orchestrator block "phase='$PHASE' unrecognized — gate fail-closed ($P)" "$P" blocked
      exit 2 ;;
  esac
}

# Dispatch. Edit/Write/MultiEdit: gate the one path (unchanged contract). Bash: gate each write
# REDIRECT target — a read/build/test has no target, so it's allowed (allow-by-default). NOTE: the
# while-loop runs in THIS shell (no pipe) so a block's `exit 2` propagates, not lost in a subshell.
if [ -n "${P:-}" ]; then
  landmark_hint "$P"
  gate_path "$P"
elif [ "$TOOL" = "Bash" ] && [ -n "${CMD:-}" ]; then
  while IFS= read -r _t; do [ -n "$_t" ] && gate_path "$_t"; done <<EOF2
$(extract_write_targets "$CMD")
EOF2
fi
exit 0
