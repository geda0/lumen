# KICKOFF — your first message to the orchestrator

Pick the path that matches where you are.

## One-shot (you're already in a coding agent)
Paste this — the agent installs team-tactics **and** bootstraps the repo in one go:

```
Install and bootstrap team-tactics in this repo. Run: npx tics .  — then read
AGENTS.md and CLAUDE.md, detect the stack and set LAYERS + the test command(s) in
.claude/tdd.config, and draft docs/tdd/project-invariants.md for my OK. If this is an
existing codebase, adopt it and bring it up to standard (characterization tests, a
green baseline, CI) before new work. Then build with the red->green loop: <what you
want built>.
```

## After `npx tics` (two-step) — paste this as your first message
Read `AGENTS.md` and `CLAUDE.md` first, then set up the harness once:
1. Detect the stack and set `LAYERS` + the test command(s) in `.claude/tdd.config`.
2. Draft `docs/tdd/project-invariants.md` from the codebase for my confirmation.

Then, depending on the repo:

**New project — build a feature:**

FEATURE: <one line — the unit of work you want>

ACCEPTANCE  (each → one or more red→green cycles; tag the layer)
- [<layer>] given … when … then …
- [<layer>] <a project invariant from docs/tdd/project-invariants.md it must prove>

**Existing project — adopt + upgrade to standard:**
- **architect** maps the seams + writes short ADRs; **product-owner** drafts the
  invariants and a backlog (a documented green baseline, characterization tests on the
  load-bearing-but-untested paths, CI), then runs the loop. Never regress the suite.

Set `.claude/state/{layer,phase}` before each step, delegate red→`test-writer` /
green→`implementer`, run `tdd-critic` every ~3 cycles. Done when every bullet is
ticked, the suite is green, and the critic = PASS. (Method: `docs/tdd/tdd-workflow.md`.)
