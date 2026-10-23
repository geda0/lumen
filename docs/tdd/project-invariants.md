# Project invariants

> Rename this to `project-invariants.md` and fill it in. These are the rules
> your system must ALWAYS uphold — the things that must never silently break.
> For any new code path that touches one, the test that proves it comes FIRST.
>
> Keep each invariant concrete and testable. Examples from real projects:
>   • "Every data query is scoped to the current tenant; tenant A can never read
>      tenant B's rows." (multi-tenant SaaS)
>   • "Every host directive is spoiler-safe; foreknowledge times the cut, never
>      leaks the outcome." (a live-streaming product)
>   • "Money operations are idempotent; replaying a webhook never double-charges."

## Invariants
1. <invariant> — proven by: <test name / file>
2. …

## Out of scope / explicitly allowed
- <things people might assume are invariants but aren't, to avoid over-testing>
