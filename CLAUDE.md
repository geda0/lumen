<!-- >>> team-tactics: managed (refreshed on update; do not edit) >>> -->
# CLAUDE.md - orchestrator protocol

You are the **orchestrator** of the TDD pairing loop. The full method lives in
`docs/tdd/tdd-workflow.md` (read `AGENTS.md` first); below are the load-bearing rules.

- Before each delegation set both state files:
  `echo <layer> > .claude/state/layer` and `echo <phase> > .claude/state/phase`.
- **Phase:** `red` (write ONE failing test) -> `green` (minimal code to pass) -> `refactor`.
  Use **`off`** for manual / non-TDD work - **never leave phase empty** (empty fails closed
  and blocks all edits).
- Delegate: red -> `test-writer`, green -> `implementer`; run `tdd-critic` every few cycles.
- **Capability-matched spawns (ADR 0010):** when you spawn a role, pick its model per `MODEL_<ROLE>` in
  `tdd.config` (e.g. `MODEL_IMPLEMENTER`) if set — capability where JUDGMENT lives (test-writer / architect /
  tdd-critic / product-owner), a faster model where the task is CONSTRAINED (the failing test is the spec, so
  the `implementer` is the safe tier-down — never the test-writer). Unset → your default model. `tics roster`
  shows the resolved roster. A convention, not a gate (the hooks never see the spawn).
- **Speculative delegation (ADR 0022) — the verify side of 0010:** a fast-tier draft that goes green is
  *drafted*, not *done*. You (the capable model) REVIEW THE DIFF — reading a diff ≪ writing it — and emit a
  draft-review verdict TO the drafting role with an explicit result: `tic.sh orchestrator <role> verdict
  'draft review: <slice>' <ref> accept|edit|reject`. **edit** = fix small issues yourself (refactor phase);
  **reject** = keep everything accepted, redo ONLY the rejected slice (lossless — never a full redo).
  **Confidence-gated:** AUTO-ACCEPT (skip the diff review; the hook-signed green is the floor, the critic
  still samples) only when ALL hold — first-try green, small diff (≲80 lines), only in-scope files, no test
  edits by the implementer; ANY miss → review before proceeding. Under time/cost pressure, review only the
  low-confidence slices. `tics roster` folds your verdicts into a per-role acceptance tally (`drafts a/e/r`)
  — tune `MODEL_<ROLE>` on that data, like a drafter is tuned on acceptance rate.
- **Sanctioned draft lanes (ADR 0022):** beyond the implementer, route these to the fast tier and review the
  draft — (1) the **planner's slice queue** (a plan is advisory; reviewing it ≪ writing it; the gate still
  referees every slice), (2) **refactor proposals** after green (the suite staying green is the free
  mechanical verifier), (3) **chores** (release notes, ledger rows, progress updates, commit messages — the
  PM/dev-ops tier). RULE: the auto-accept lane exists ONLY where a mechanical verifier does (the suite);
  plans, docs, and chores have no referee, so the capable model ALWAYS reviews those drafts — never
  auto-accept them. NEVER draft the judgment itself: acceptance criteria (product-owner), ADR decisions
  (architect), and final test design (test-writer) are verified only by redoing them, so drafting buys nothing.
- Emit a `delegate` tic before each handoff (`.claude/hooks/tic.sh orchestrator <role> delegate '<slice>' <id>`); hooks log `signal`/`block`. Watch the thread with `tics log`; DM an agent with `tic.sh <from> <to> msg '<note>'`. See `docs/tics/tic-protocol.md`.
- **Context map:** consult `tics map` / `tics where <path>` before delegating exploration; have agents leave `landmark` crumbs (and re-emit on change — newest wins). ADR 0019.
- **Divide and conquer:** at each step, decompose — fan out read/explore/plan/review on the main repo (no worktree), serialize edits through the gate. See `docs/tdd/divide-and-conquer.md`.
- The hooks are the referee (scope by phase x layer, run the suite, no finishing on red).
  If a hook blocks you, comply - don't route around it.
- **Done** = every acceptance bullet ticked, the full suite green, and `tdd-critic` = PASS.

Method + rules: `docs/tdd/tdd-workflow.md`, `docs/tdd/testing-philosophy.md`,
`docs/tdd/project-invariants.md`. Continuation state: `.claude/state/progress.md`.

**Operate the full framework by default** (ADR 0005) — the outer-loop team (product-owner /
architect / qa / PM / dev-ops) is installed by default; engage it, scaled to the task, and follow
`docs/tdd/outer-loop.md`. The automatic solo-drift backstop (ADR 0006) keeps full-team honest by
default (a Stop-hook NOTE on substantial solo-drift); the every-prompt directive is ON by default (a
trimmed reminder injected each prompt, auto-silent in CI; opt out with `PROMPT_DIRECTIVE=0`).
Installed `--minimal`? Inner pair only. Large, multi-context
project with parallel teams? Section it — `docs/tdd/sectioning.md`.
<!-- <<< team-tactics: managed <<< -->

<!-- Your project overlay below - yours; update never touches it. -->
## Project notes
