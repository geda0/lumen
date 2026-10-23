<!-- >>> team-tactics: managed (refreshed on update; do not edit) >>> -->
# AGENTS.md - start here, every agent, every session

This project is built by **test-driven agent pairing** (the `team-tactics` kit).
The method is single-sourced in `docs/tdd/` - read it; don't re-document it here.

> **Use the full framework by default** (ADR 0005, ADR 0020). Engage the whole loop and the
> team, scaled to the task — don't self-classify work as "plumbing" and drop to `off` to dodge
> TDD. If there's testable logic, it gets a red→green slice. This holds for **every** tool
> (Claude Code enforces it with hooks; other agents self-enforce — the discipline is the same).

- **Read first:** `docs/tdd/tdd-workflow.md` (the loop), `docs/tdd/testing-philosophy.md`,
  and `docs/tdd/project-invariants.md` (the rules this project must uphold).
- **Continue prior work** from `.claude/state/progress.md` (+ `design-notes.md`); run the
  suite for ground truth. State lives in files, never memory.
- **Roles:** `test-writer` (one failing test), `implementer` (minimal green), `tdd-critic`
  (read-only audit), the orchestrator (`CLAUDE.md`), and the human navigator.
- **The rails** (hooks): phase is `red`/`green`/`refactor` during a cycle, or `off` for
  manual work - **never empty** (empty fails closed). Edits are scoped by layer; you can't
  finish on a red bar. If a hook blocks you, it's doing its job.
- **Visual/untestable work?** Don't default to `off`. Split the testable predicate out of
  the pixels (`snowsToday(date)`, `allocate(mode) -> count`, a reducer/layout calc) and TDD
  it; only the irreducible render is `off`-exempt (get a qa-verifier verdict). See
  `docs/tdd/tdd-workflow.md`.
- **Tics** record agent-to-agent handoffs in `.claude/state/tics.jsonl` (structured, not chat): hooks log `signal`/`block`; you emit `delegate`/`handoff`/`verdict`/`msg` via `.claude/hooks/tic.sh`, and read your inbox with `tics inbox <role>`. See `docs/tics/tic-protocol.md`.
- **Context map (learned crumbs):** before exploring an area, check what earlier agents learned — `tics map` (the whole index), `tics where <path>` ("what do we know about this file"), `tics how <task>` ("the recipe to do X"). Leave a crumb when you learn something durable: `.claude/hooks/tic.sh <role> '*' landmark '<what you learned>' <path-or-area> <landmark|route|caveat>` (or `mcp__tics__tic_emit` kind=landmark). FRESHNESS: when you change something you have a crumb about, emit a FRESH crumb — newest-per-ref wins, so the map always shows the latest (a `↻ verify` mark just nudges a re-emit when code changed). Crumbs are self-reported — trust accordingly. Opt-in edit-time hints: set CONTEXT_MAP=1. See ADR 0019.
- **Divide and conquer:** before any step, ask if the work decomposes — fan out read-only work (explore/review/plan) on the main repo by default and synthesize; serialize edits through the gate. See `docs/tdd/divide-and-conquer.md`.
- **Tool support:** the gate is **Claude Code's hooks** (`.claude/settings.json`) — they auto-run the suite, block out-of-phase / cross-claim edits, and emit `signal`/`block` tics. **Other agents (Cursor, etc.) don't run these hooks**, so enforcement doesn't fire: the method, `docs/`, and the `tic.sh`/`tics` scripts are portable, but you self-enforce phase×layer, run the suite yourself, and emit tics by hand. See `docs/tdd/tool-support.md`.
<!-- <<< team-tactics: managed <<< -->

<!-- Your project overlay below - yours; update never touches it. -->
## Project notes
