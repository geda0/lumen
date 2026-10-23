# Sectioning a large project (DDD) — parallel teams, one tic bus

The inner loop builds one behavior; the outer loop builds one feature. **Sectioning**
lets *multiple pairs* build *different parts of the system at once* without colliding —
a dev pair can finish one area while the product-owner, PM, or architect work another.

A **section** is a **bounded context**: a vertical slice of the domain (across layers)
with a clear boundary. Sections are *orthogonal* to layers — `frontend`/`backend` are
layers (the *how*), `ranking`/`narrate`/`checkout` are sections (the *what*). Scope is
hierarchical: `section/pair`.

Opt-in. **Most projects are one section — do not section a small one.**

## When to section (the architect proposes; the product-owner calls it)
Section only when *several* of these hold:
- The domain has **2+ clear bounded contexts** joined by thin, nameable seams (an event,
  an API shape, a shared type) — not a tangle.
- **More than one pair/role is free to work in parallel** (two dev pairs, or a pair
  building while PO/PM/architect work elsewhere). No parallelism → no need to section.
- The backlog has **independent tracks** that don't queue on the same files.
- The repo is **big enough** that a single orchestrator thread is the bottleneck.

If you're sectioning to organize *one* worker's tasks, stop — that's just the backlog.

## How to section (the architect, recorded in `.claude/state/sections.md`)
1. **Cut along domain seams, not layers.** Each section owns a bounded context end to
   end. Keep the **shared kernel** (types/files that >1 section needs) as small as possible.
2. **Name each seam as a contract.** For every cross-section dependency, the providing
   section publishes a `contract:<X>` — the shape the consumer builds against. This is the
   architect's usual seam job, now *between sections*. Record each in the **context map**.
3. **Assign an owner** (pair/role) per section in the sections table.
4. **Write one ADR** for the sectioning decision (why these boundaries) when it's load-bearing.

## How to work a sectioned project — one worktree per track, one shared bus (ADR 0015)
**Git isolates; the bus observes.** Each section/track is its own **git worktree**: a separate
tree, index, and `.claude/state` (phase/layer/scope/suite-status). Git provides write-isolation,
so one track's in-progress red bar can't block another — there is no in-tree session protocol.
- **One worktree per track.** Create a worktree per section you'll work in parallel
  (`git worktree add ../team-<section> <branch>`). The worktree's existence *is* the registry;
  removing it is unambiguous. Each runs its own orchestrator + inner loop.
- **All worktrees share ONE spool bus.** In `.claude/tdd.config` set `TIC_STORE=spool`
  (concurrent writers each append their own file — no clobber) and point every worktree at one
  bus at the git common dir (shared by all worktrees):
  `TICS_DIR="$(cd "$ROOT" && cd "$(git rev-parse --git-common-dir)" && pwd)/tics-bus"`.
  Without it each worktree keeps its own `.claude/state/`, the bus fragments, and the conductor
  can't correlate a `need` in one section with the `contract` that fills it. The reader's
  cross-worktree merge (`loadTicsAll`) unions every worktree's bus so `tics conductor`/`board`/
  `claims` correlate across them; a peer worktree's claim is visible and blocks.
- **Scope each track to its section:** `echo <section>/<pair> > .claude/state/scope` in that
  worktree. Then `tics log --scope <section>` is the section's whole thread, `--scope
  <section>/<pair>` is one pair, and a pair also sees its section-level + global tics.
  `tics sections` is the live per-section map across all worktrees.
- **Coordinate seams with coupling-tics, not chat:**
  - `contract` — "here is the shape I publish" (provider → consumers).
  - `need` — "I'm blocked on your seam" (consumer → provider).
  - `claim` / `release` — claim a file before editing it, release when done (a claim is freed
    only by release-on-section-done). With `CLAIMS_ENFORCE` (default on), the guard **blocks**
    an edit to a file held by another scope — including a peer worktree's scope — and emits a
    `need`, so two tracks can't edit one file. `tics claims` shows what's held;
    `tics conductor` shows cross-track coupling that needs attention.
- **Each section still runs the full red→green inner loop** and keeps the **whole** suite
  green. A section is a *coordination* boundary, not a quality boundary.

## Roles
- **architect** — proposes sectioning, draws the boundaries + context map, owns the seam
  contracts *between* sections.
- **product-owner** — decides *when* parallelism is worth sectioning, assigns sections,
  keeps each section's backlog track unblocked.
- **orchestrator** — sets `scope` per pair, runs the inner loop within a section, watches
  `tics conductor` for cross-section blocks.
- **project-manager** — releases at the milestone, across sections.

## Don't
- Don't section a small/simple project, or to organize one worker's tasks.
- Don't cut along layers — that's not a bounded context.
- Don't let the shared kernel grow; a fat kernel means the seam is in the wrong place.
- Don't coordinate seams in chat — publish a `contract`/`need` tic so it's recorded.
