# Conventions

## Test-first, always
No production code without a failing test demanding it. The hooks enforce this;
don't try to route around them.

## One behavior per cycle
One failing test per red step. One logical change per commit.

## Commits (Conventional Commits)
`type(scope): summary` — feat, fix, refactor, test, docs, chore. A red->green
cycle is typically one `test:` + one `feat:`/`fix:`, or a single `feat:` that
includes both the test and the code.

## Definition of done
Every acceptance bullet ticked, the full suite green, the relevant
`project-invariants.md` rules proven by tests, `state/progress.md` updated, and
the critic returns PASS.

## Continuation
Before ending a session, update `.claude/state/progress.md` so the next agent
can resume cold. Leave the repo on a green bar when possible.
