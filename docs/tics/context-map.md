# The context map (learned crumbs)

The **context map** is a durable, indexed, self-reported layer of *navigational* context, so
agents don't re-explore ground a peer already walked. Where a tic records a **handoff**, a crumb
records a **finding about the codebase** — "X lives in Y", "to do Z touch A,B,C in order", "watch
out for W" — and keeps it where the next agent will look. A **crumb is a `landmark` tic**: same
append-only bus, same wrapper, surfaced by its own views (`tics map` / `where` / `how`). It is the
middle rung of the escalation ladder below — heavier than a thread tic, lighter than an ADR.

Read `tic-protocol.md` first: the crumb rides the bus and obeys its rules; this doc only adds the
navigational layer on top.

## What a crumb is
A self-reported note left at a location so the next visitor recalls it without re-deriving it. Three
shapes, by what they help you do:
- a **landmark** — "X lives in Y" (where a thing is),
- a **route** — "to do Z, touch A,B,C in order" (how a task threads the code),
- a **caveat** — "watch out for W" (a trap to avoid).

Crumbs are **unrefereed** — no hook checks them, unlike a `signal`. A wrong crumb misleads, so the
contract is: keep yours current (see Freshness).

## The crumb schema
A crumb is a tic with `kind=landmark`:

| field | value | meaning |
|-------|-------|---------|
| `kind` | `landmark` | marks this tic as a context-map crumb |
| `ref` | path or area key | what the crumb is *about* — a file (`backend/src/feed/rank.ts`) or an area (`area:feed`) |
| `result` | `landmark` \| `route` \| `caveat` \| `retract` | the crumb's shape (`retract` tombstones a ref) |
| `msg` | the recall sentence | what you'd want to read on arrival |
| `from` | your role | who left it |

`result=retract` is a **tombstone**: it withdraws the crumb(s) at that `ref` (a thing moved, a
caveat no longer holds) without rewriting history — the old crumb stays on the bus, the views stop
surfacing it.

## Write a crumb
Bash (Claude Code), broadcast to `*` so any role can recall it:

```
.claude/hooks/tic.sh <role> '*' landmark '<what>' <path-or-area> <type>
```

- a landmark: `tic.sh implementer '*' landmark 'ranking weights live here' backend/src/feed/rank.ts landmark`
- a route:    `tic.sh architect '*' landmark 'add a feed source: register in registry.ts, then rank.ts, then the DTO' area:feed route`
- a caveat:   `tic.sh test-writer '*' landmark 'rank.ts mutates the input array — clone first' backend/src/feed/rank.ts caveat`
- a retract:  `tic.sh implementer '*' landmark 'weights moved to config' backend/src/feed/rank.ts retract`

MCP / Cursor: `mcp__tics__tic_emit` with `kind=landmark` and the same `ref` / `result` / `msg`.

## Read the map
- `tics map` — the whole index, grouped **Landmarks / Routes / Caveats / Decisions**. Your first
  stop in unfamiliar code.
- `tics where <path>` — crumbs whose `ref` overlaps a path (the file itself or an `area:` it falls
  under). Use it before editing a file to surface its caveats.
- `tics how <task>` — the **route** recipes matching a task — the ordered "touch A,B,C" recipes.
- the `tics_map` MCP tool (optional `path` / `task` args) — the same three views for Cursor:
  no arg → the index, `path` → `where`, `task` → `how`.

## Freshness — newest-per-ref wins
The map is **self-healing by recency**: searches return the **latest crumb per `ref`**, so when you
change a thing, **re-emit a fresh crumb** and it supersedes the old one. The stale crumb is not
deleted — it stays on the bus for history — it's just no longer what the views return. You never
edit or delete a crumb; you emit a newer one (or a `retract`).

A crumb whose `ref` was touched in the code *after* the crumb was written carries a soft
`↻ verify (code changed since)` mark in the views. That mark is **only a nudge** to re-emit — it
**never hides** the crumb. You still see it; you're just reminded it may have drifted.

## Push (opt-in)
By default the map is **pull** — you go look. Set `CONTEXT_MAP=1` in `.claude/tdd.config` and the
edit guard becomes **push**: when you edit a file, it surfaces that file's crumbs inline (the same
set `tics where <path>` would return). Advisory only — it never blocks the edit — and **Claude Code
only** (it rides the CC edit guard).

## Cold start — ADRs seed the map
A fresh bus isn't empty. Every ADR is published as a `contract` tic (see `tic-protocol.md`), and the
map folds those in as **Decisions** — so `tics map` shows the project's recorded design decisions
from day one, before any crumb is dropped. Crumbs are the fast, local layer *over* that durable base.

## The escalation ladder
Three rungs, increasing in weight and durability — use the lightest that fits:

1. **thread tic** (`msg` / `note`) — in-session, ephemeral coordination. "I'm editing rank.ts now."
2. **landmark crumb** — durable, indexed, **self-reported** navigation. "rank.ts is where weights
   live." Unrefereed: a wrong one misleads, so keep it current.
3. **ADR** (`contract`) — the durable, *refereed* decision of record. "we rank server-side; here's
   why." Never edited — superseded by a new ADR.

A crumb is the rung you reach for when a fact is worth keeping past this session but isn't a
decision worth an ADR. When in doubt about whether something is a load-bearing decision, write the
ADR — the crumb is for the navigation *around* the decisions, not for the decisions themselves.
