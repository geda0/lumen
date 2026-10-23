# Sections — the context map

_Owned by the architect (with the product-owner). For LARGE projects only — when the domain has
clear bounded contexts worth building in parallel. Small projects: leave this single-section.
A section is a vertical slice (a bounded context across layers); its contracts are the seams.
See `docs/tdd/sectioning.md` for when + how to section._

## Sections
| section | owner (team/pair) | boundary contracts (seams) | status |
|---------|-------------------|----------------------------|--------|
| <name>  | <pair/role>       | <contract:X it provides / consumes> | planned |

## Context map (cross-section seams)
- `contract:<X>` — <provider section> -> <consumer section>: <the published shape>

## Conventions
- Scope a pairing session under its section: `echo <section>/<pair> > .claude/state/scope`
  (then `tics log --scope <section>` shows the whole section, `--scope <section>/<pair>` one pair).
- Coordinate seams with coupling-tics: `contract` (publish), `need` (request), `claim`/`release`
  (own a shared file). Watch with `tics conductor` and `tics sections`.
- Don't over-section: cut along real domain seams; keep the shared kernel minimal.
