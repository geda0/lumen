# The outer loop (full-team preset)

The inner loop (`docs/tdd/tdd-workflow.md`) turns one behavior into tested code.
The **outer loop** turns intent into accepted, released features, and is run by the
orchestrator with the roles below. Install/refresh them with
`npx tics --preset full-team`.

## Roles
| Role | Owns | Writes |
|------|------|--------|
| product-owner | the prioritized backlog + acceptance | backlog.md, design-notes.md |
| architect | contract seams + ADRs | docs/decisions/*, architecture docs |
| qa-verifier | experience-level acceptance (the running app) | a verdict (files defects) |
| project-manager | the milestone→release pipeline | releases.md |
| dev-ops | git + deploy mechanics + infra/ | infra/, the deploy |
| orchestrator | runs the loop, delegates, records | progress.md |
| navigator (human) | final authority on scope/brand/risk | decisions |

### Model tiering (ADR 0010)
Spend capability where **judgment** lives; economize where the task is **constrained**. When the
orchestrator spawns a role it picks that role's model from `MODEL_<ROLE>` in `tdd.config` (e.g.
`MODEL_IMPLEMENTER`), defaulting to its own model when unset. Recommended tiers: **capable** for
test-writer / architect / tdd-critic / product-owner (deciding *what to assert*, the contract, the
over-build audit, prioritization); **faster** for the implementer (minimal green is constrained by the
failing test — which is why the implementer, not the test-writer, is the safe tier-down) and the
mechanics roles (qa-verifier / project-manager / dev-ops). `tics roster` shows the resolved roster. This
is an orchestrator convention (config + this guidance), not a hook gate — the hooks never see the spawn.
Model tiering and **slice-sizing** are one convention: size the red→green slice to the executor too — a
tiered-down implementer (faster model) gets a finer slice, a capable test-writer/role a coarser one (same
one-behavior-per-red invariant at both; see "Slice granularity" in `docs/tdd/divide-and-conquer.md`, ADR 0010).

### Speculative delegation (ADR 0022) — the verify side
Tiering says who *drafts*; ADR 0022 says how the draft is *verified* (the shape of speculative decoding
at the agent level: a fast drafter proposes, the big model verifies — verifying is far cheaper than
generating). The pipeline per slice: fast-tier draft → the **free mechanical verify** (the gate + the
hook-signed suite green) → a **confidence-gated diff review** by the orchestrator (the capable model),
whose ruling is a draft-review `verdict` tic TO the drafting role with an explicit result —
**accept** / **edit** (the orchestrator fixes small issues itself, refactor phase) / **reject** (keep
everything accepted, redo only the rejected slice — lossless, never a full redo). The review is skipped
(AUTO-ACCEPT: the green is the floor, the tdd-critic still samples) only when every confidence signal
holds — first-try green, small diff, only in-scope files, no test edits; any miss → review before
proceeding; under time/cost pressure review only the low-confidence slices. `tics roster` folds the
draft-review verdicts into a per-role `drafts a/e/r` tally — tune `MODEL_<ROLE>` on that acceptance
data, exactly as a speculative-decoding drafter is tuned on its acceptance rate.

**Sanctioned draft lanes.** The same draft/verify shape extends beyond the implementer: the **planner's
slice queue** (advisory — the orchestrator reviews ordering/sizing; the gate still referees every slice),
**refactor proposals** after green (the suite staying green is the mechanical verifier), and **chores**
(release notes, ledger rows, progress updates, commit messages — already the PM/dev-ops fast tier). The
line that keeps this honest: **auto-accept exists only where a mechanical verifier does.** A green suite
can vouch for a refactor; nothing mechanical vouches for a plan or a doc, so those drafts are always
reviewed by the capable model. And judgment is never drafted — acceptance criteria, ADR decisions, and
final test design can only be verified by redoing them.

## The loop, per feature
1. **PLAN** — product-owner selects the next backlog item and writes its acceptance
   criteria (observable behaviors) into `design-notes.md`. Surface decisions to the
   navigator.
2. **DESIGN** — if the feature adds/changes a contract or crosses a layer, the
   architect confirms/extends the seam and records an ADR. Skip for additive work on
   an existing contract.
3. **BUILD** — run the inner red→green→refactor loop for each acceptance bullet
   (for cross-layer features: backend contract → frontend → one e2e journey).
4. **ACCEPT** — for UX features, someone drives the running app and emits an experience
   `verdict` tic (see "The QA seam" below); then the product-owner signs off against
   acceptance, citing that verdict, or files follow-ups/defects.
5. **RECORD** — product-owner updates `backlog.md`; orchestrator updates
   `progress.md`.
6. **RELEASE** — at a milestone boundary (accepted, bar green), the project-manager
   (with dev-ops) commits, git-tags, and deploys the milestone, verifies health, and
   records it in `releases.md`. Surface release blockers; then take the next feature.

### The QA seam — the verdict tic, not the agent (ADR 0024)
The seam at ACCEPT is a **verdict tic**, **not the `qa-verifier` agent**. An experience ruling that
isn't on the bus does not exist. So **whoever observed** — with whatever instrument — emits it:
`kind=verdict`, `from` = the role that actually looked, `to` = `product-owner`, an explicit
`result` (`pass|concerns|block`, never inferred from prose), and a `msg` that **names the
instrument**.

The instrument vocabulary is a closed set (extend only by ADR):

| instrument | what it is | what it can answer |
|---|---|---|
| `smoke` | the `smoke-verify.cjs` CLI (ADR 0021) | *only* "is this **text marker** in the rendered DOM" |
| `browser-mcp` | a host browser tool (screenshot / eval / console) | pixel- and console-level; host-specific; self-reported |
| `human` | the navigator looked | anything; final authority |
| `none` | no instrument was used | **nothing** |

`instrument=none` ⇒ the only permitted result is `concerns` (msg must say *unverified*) — **never a
`pass` without an instrument.** And `smoke`'s range is a hard limit: it sees **text markers**; it
**cannot see** **appearance** — a pixel/appearance bullet ("the trail never clears") is outside its
range and needs `browser-mcp` or `human`.

Who observes is **whoever holds the instrument — including the orchestrator** when it is the one
with the browser tool. But it emits the verdict under **its own `from`**: emitting as
`from=qa-verifier` when the `qa-verifier` agent didn't run is identity **launder**ing (nothing
mechanical stops it — `qa-verifier` is agent-assertable — so the discipline must). The
**product-owner**'s accept on a milestone with any **experience**-level bullet must **cite** the
experience verdict(s) it relies on; with no experience verdict on the bus, its ruling is
`concerns`, not accept. (We do **not** extend `tics gate` for this — whether a bullet is
experience-level is judgment, audited by `tdd-critic`, not a mechanical predicate.)

## Reviews on the bus
Every outer-loop ruling is a `verdict` tic, not only a doc edit: the **product-owner** emits
pass/concerns on sign-off, **qa-verifier** on its experience check, **tdd-critic** on its audit,
the **project-manager** on release. The whole review trail then shows in `tics log` / `tics cycle`,
so acceptance and releases are auditable and gate-able — never bury a ruling only in backlog.md. The project-manager runs `tics gate` before tagging; it blocks the release unless the required verdicts (product-owner accept + tdd-critic PASS) are on the bus.

## Parallel sections (large projects)
When the domain has clear bounded contexts and more than one pair/role can work at once,
the architect (called by the product-owner) **sections** the project: each section is a
bounded context built in parallel, scoped `section/pair`, coordinating across seams with
`contract`/`need`/`claim` tics on a shared spool bus. The PO/PM/architect can work one
section while a dev pair finishes another. Opt-in — small projects stay single-section.
Full guide: `docs/tdd/sectioning.md`; the live map is `.claude/state/sections.md`.

## Invariants
- The product-owner accepts; the project-manager ships. Never release on a red bar
  or unaccepted work.
- Acceptance criteria are observable behavior, never "implement X".
- The files are the source of truth (backlog / design-notes / progress / releases);
  every role reads them before acting and writes only its own.
- Sectioning (large projects) is a *coordination* boundary, not a quality one: every
  section keeps the whole suite green and runs the full red→green loop.
