# The tic protocol

A **tic** is a single unit of agent-to-agent **in-session communication** — a structured,
append-only, file-mediated record. It is *not* a chat box: agents still coordinate through the
files, the suite, and the hooks. The tic protocol **names and records** those gated handoffs
(and adds a slack-like message channel) as one auditable log.

## The record
One JSON object per line in `.claude/state/tics.jsonl` (transient — gitignored, like
`suite-status`):

| field | filled by | meaning |
|-------|-----------|---------|
| `ts` | auto | UTC ISO-8601 |
| `seq` | auto | monotonic per-file counter |
| `kind` | caller | one of the kinds below |
| `from` / `to` | caller | emitter role / addressee role (`*` = broadcast) |
| `phase` / `layer` | auto | from `.claude/state/{phase,layer}` |
| `scope` | auto | `TICS_SCOPE` (per-call override) if set, else `.claude/state/scope` (e.g. `pair:S2`), else the active layer, else `*` |
| `msg` | caller | one-line summary |
| `ref` | caller | pointer to the objective artifact (slice id / file / test) |
| `result` | caller | `green`/`red`/`pass`/`concerns`/`block`/`blocked` |

## The kinds
| kind | from → to | meaning |
|------|-----------|---------|
| `delegate` | orchestrator → subagent | hands a slice down (before delegating) |
| `handoff` | subagent → orchestrator | returns control (carries the observed result) |
| `signal` | run-suite / guard → `*` | machine fact (suite green/red); **hook-emitted, unforgeable** |
| `block` | guard → orchestrator | a scope refusal (why an edit was stopped) |
| `verdict` | tdd-critic / qa-verifier → orchestrator | a review / acceptance ruling |
| `msg` | any → role or `*` | **slack-like in-session message** — contact/update another agent |
| `note` | any → `*` | a log-only annotation |
| `landmark` | any → `*` | a **context-map crumb** (learned navigation): `ref`=path/area, `result`=`landmark`\|`route`\|`caveat`\|`retract`, `msg`=the recall sentence; surfaced by `tics map`/`where`/`how`, not the thread. See `context-map.md`. |

`signal` subsumes the old suite-telemetry event (it carries `exit` + `durationSec`), so
`tics.jsonl` is the single process log.

## Emitting
Hooks emit automatically: `run-suite` → `signal`, `guard` → `block`. Agents emit one line via
the wrapper (mechanism is `emit_tic` in `.claude/hooks/lib.sh`; gated by `TICS=1`):

```
.claude/hooks/tic.sh FROM TO KIND MSG [REF] [RESULT]
```

- orchestrator, before delegating: `tic.sh orchestrator test-writer delegate "slice S2" S2`
- a subagent, on return:           `tic.sh test-writer orchestrator handoff "added failing test" live.test.ts red`
- anyone, to contact an agent:     `tic.sh navigator architect msg "use option B for the seam"`

## Scope — the signal/noise + coupling axis
Every tic carries a `scope`, read ambiently from `.claude/state/scope` (set it per pairing
session like phase/layer: `echo pair:S2 > .claude/state/scope`). For a **fan-out**, each branch sets `TICS_SCOPE=<task>/<branch>` per call (highest precedence) so concurrent branches self-scope onto one shared bus without touching the global file. A **pairing-tic** is scoped to
its pair (`pair:S2`) — signal to that pair, noise to others. A **coupling-tic** uses a broader
scope (`feature:auth`, `contract:RankedFeed`, `*`) and reaches everyone coupled to it — so a
pairing-tic is just a tightly-scoped coupling-tic. Filtering by scope keeps a view 100% signal:
`tics log --scope pair:S2` shows that pair plus global (`*`) tics and hides the rest.

## Viewing
Use the installed reader `.claude/hooks/tics <cmd>` (agents) or `npx team-tactics <cmd>` (shell); `tic.sh` only EMITS.
- `tics log [--scope <s>]` — the thread. **Merges every git worktree's bus BY DEFAULT** (whole picture — a detached worktree's tics aren't invisible from the main checkout); pass `--here` to restrict to the local bus. With `--scope`, just that scope + global (`*`). (Same default for `conductor`/`claims`/`sections`/`gate`.)
- `tics inbox <role> [--scope <s>]` — your inbox: tics where `to ∈ {<role>, *}` (and scope, if given). Read it at the start of your
  turn and address any directed `msg`.
- `tics report` — process metrics aggregated from the `signal` tics. Green suite results are split by **provenance** (ADR 0009): a green with `from=run-suite` is **hook-signed** (the CC referee produced it — `run-suite.sh` is a PostToolUse hook), while a green a role hand-emitted (per AGENTS.md, outside CC) is **self-reported**. `report` shows the split and loudly calls out any self-reported greens so they can't silently inflate the pass rate; an all-refereed bus gets no call-out. Provenance, not signature — honest-by-default (ADR 0006). When the **per-tool witness** is on (`TOOL_WITNESS=1`, ADR 0013), `report` also shows a per-tool usage tally from the `note` tics the PostToolUse witness emits (`from=witness`, "used <Tool>"); those notes are hidden from `tics log` by default (`tics log --witness` reveals them) so the coordination thread stays readable. A record, never a gate.
- `tics conductor` — the cross-pair coupling tics only (claim/release/contract/need/msg).
- `tics claims` — active file/module claims (claim minus release), by scope.
- `tics cycle` — inner-loop dashboard: phase/layer/scope + last suite signal + cycles since the last tdd-critic verdict (nudges a critic pass when overdue) + a one-line fleet-health summary (STUCK/collision counts + a live/idle/stale/unknown liveness tally).
- `tics board` — the fleet board (ADR 0008): one row per session/member grouped by held scope (an `unscoped` bucket for the rest), each with a locally-computed **liveness** tier (`live`/`idle`/`stale`/`unknown` from last-tic age vs `LIVENESS_IDLE_SEC`/`LIVENESS_STALE_SEC`), plus loud call-outs — **STUCK** (holds a scope yet is stale) and **collisions** (a scope touched by ≥2 distinct sessions). A pure read-side fold over the bus; degrade-safe (never invents a tier, never false-alarms).
- `tics gate` — release gate: exits non-zero unless the required outer-loop verdicts (product-owner accept + tdd-critic PASS) are on the bus; the project-manager runs it before tagging. It also surfaces **attestation** (ADR 0009): if greens exist but NONE is hook-signed (all self-reported — the honest non-CC degradation), the gate prints a loud "no hook-signed green evidence" line. By default that is flag-only (the verdict gate's exit code is unchanged); set `ATTEST_ENFORCE=1` in `tdd.config` to make that case a hard block. An empty/old bus, or a bus with ≥1 hook-signed green, adds no new block and no false alarm.
- `tics review` — the **answerable-asks** queue (ADR 0012): the OPEN `need` tics — questions awaiting an answer — each with a handle (the need's `ref`, else `n<seq>`), the asker, the scope, and the question; ref-less needs are grouped "unaddressable (no ref)". Without it a `need` dies in the inbox; this is the navigator's queue. A pure read-side fold; empty bus → "no open needs", exit 0.
- `tics answer <handle> <text> [--from <role>]` — answer an open need (the one `tics` command that WRITES): emits a directed `msg` to the asker carrying the need's token with `result=answered` — which both lands in the asker's inbox AND settles the need (it leaves `tics review`). Keying on `result=answered` (not bare ref) means an ordinary `msg` can never false-settle a need. `from` defaults to `navigator`. An unknown/closed handle exits non-zero and emits nothing (idempotent). A convention/queue, not a hook gate — nothing blocks on an open need.

## Parallel pairs (the coupling kit)
Run independent slices as **parallel pairs**, coordinated by coupling-tics:
- `claim` / `release` — a pair claims a file/module (`ref`) so two pairs don't edit the same
  thing; release when done. With `CLAIMS_ENFORCE` (default on) the guard blocks an edit to a file held by another scope and emits a `need`. **Claiming is automatic:** when a scope is set, the guard auto-claims a still-unclaimed file on first edit (first toucher owns it; rivals are then blocked) — no manual bookkeeping. `tics claims` lists what's owned (claim minus release), by scope; `tics claim-owner <file>` reports who holds one (empty if free).
- `commit` — a VCS landing event from the post-commit git hook; git runs it under ANY tool, so commits land on the bus even where the Claude Code hooks don't fire (e.g. Cursor) — the cross-tool visibility bridge.
- `section` — the lifecycle of a partition (the scope's first component, `ref`). **Opening is automatic:** the guard auto-opens a section on first scoped edit, so the partition map fills itself — mark it shipped with `tic.sh <pair> '*' section done <name> done`, which **auto-releases that section's claims** (release-on-done) so the partition frees up for reassignment. `tics sections` is the live map (each section's `[open|active|done]` status + tics/claims/contracts/needs); `tics section-status <name>` reports one section's latest status (empty if unopened).
- `contract` — the architect publishes a seam (a coupling-tic) that unblocks dependent pairs. **Auto-published:** creating an ADR (`docs/decisions/*.md`) auto-emits a `contract`, so design decisions surface as coupling telemetry even in solo/serial work — no scope or parallel pairs required.
- `need` — a pair signals a dependency ("need contract C").

The **conductor** (orchestrator) watches `tics conductor` — a per-scope summary (each working
unit's section `[open|active|done]` status, its active claims, needs, and contracts — claims read
`(freed)` once the section is done) over the cross-pair coupling thread, with each pair's
high-frequency pairing-tics filtered out as noise — and assigns conflict-free
scopes. Each pair works in its scope (`echo pair:S2 > .claude/state/scope`) and reads its own
thread via `tics log --scope pair:S2`.

### Sections (DDD bounded contexts)
For large projects the architect maps **sections** (bounded contexts) in
`.claude/state/sections.md` and scopes work hierarchically: `echo ranking/S2 > .claude/state/scope`.
Then `tics log --scope ranking` shows the whole section (all its pairs), `--scope ranking/S2` one
pair, and a pair also sees its section-level + global tics. `tics sections` summarizes per-section
live activity (tics, open claims, contracts, needs). Sections coordinate across their seams with
`contract`/`need`/`claim` tics — opt-in; small projects stay single-section.

### The shared bus (store)
For parallel writers sharing one log, set `TIC_STORE=spool` in `.claude/tdd.config`: each tic
becomes its own file under `.claude/state/tics.d/` — concurrency-safe (no shared-file append or
seq race). Default `TIC_STORE=jsonl` (one append-only file) suits a single session; the views
merge either store transparently. SQLite is intentionally avoided — it would break the zero-dep
/ Node>=16 / bash-hook portability invariants for wins not needed at session scale.

## Parallel work — one git worktree per track (ADR 0015, supersedes 0002/0003/0004)
Run parallel tracks as **separate git worktrees**, not multiple sessions on one tree: git isolates
each worktree's tree, index, and `.claude/state` for free — no shared `phase`/`suite-status` to
entangle, no in-tree session protocol needed. The tic bus is the shared **observer** across them:
point every worktree at ONE spool bus (`TIC_STORE=spool` +
`TICS_DIR="$(git rev-parse --git-common-dir)/tics-bus"`), and the reader merges them by default
(`loadTicsAll`) so `tics conductor`/`board`/`claims` correlate across worktrees and a peer
worktree's `claim` is visible and **blocks** an overlapping edit. Coordinate seams with
coupling-tics exactly as within one tree — `contract` (publish a seam), `need` (request),
`claim`/`release` (own a file). **Git isolates; the bus observes.** See `docs/tdd/sectioning.md`.

## Red-storm breaker
A long run of red suites usually means the failing TEST is over-constrained or contradictory,
not that the code is wrong. `run-suite` counts consecutive reds (reset on green); at
`RED_STREAK_LIMIT` (default 5) it emits a `stuck` tic, `tics cycle` flags the streak, and the Stop
hook escalates from "keep going" to "reconsider the test (route to test-writer) or ask the
navigator." Stops the loop grinding on an impossible test instead of surfacing the suspicion.

## Why it stays faithful to "never through chat"
- `signal`/`block` are produced by the hooks — agents cannot forge an objective fact.
- Every handoff is still gated by the RED/GREEN suite; tics **record** the handoff, they do not
  replace the gate.
- The channel is a structured, append-only, durable file — auditable, not ephemeral chat.
