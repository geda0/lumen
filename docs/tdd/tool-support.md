# Tool support — what's automatic, what's manual

team-tactics enforces itself in **three tiers**. Know which your agent gets:

1. **The METHOD — tool-agnostic.** `AGENTS.md` + `docs/` (TDD pairing, the tic protocol, the
   state files). Readable and followable by **any** agent — Claude Code, Cursor, CLI, a human.
   Discipline, no enforcement.
2. **The PORTABLE referee — any tool.** Git hooks (`npx tics install-hooks`) + CI
   (`.github/workflows/tdd-verify.yml`). git runs these no matter which tool made the edit, so
   the green bar and release gate hold across **every** tool and worktree.
3. **The HOST-HOOK referee — host-dependent.** `.claude/settings.json` hooks wire to your host's
   tool/stop events. The phase×layer gate, the security guard, and solo-drift live here. Whether a
   given host runs them is **host-dependent** — Claude Code always does; **one Cursor configuration
   was observed running them (2026-07-07)**, which is a single observation, not a guarantee for
   another Cursor version or config. Don't assume either way — **probe it** (below).

## Claude Code — full enforcement (tier 3)
`.claude/settings.json` wires the hooks to Claude Code's events; they fire automatically:
- **guard-edit-scope** (PreToolUse) blocks edits outside the active phase×layer, and edits to a
  file another scope has `claim`ed.
- **guard-edit-scope security surface** (PreToolUse — same hook as the scope gate, so it fires
  wherever that one does) blocks edits to paths matching
  `SECURITY_GLOB` (set in `tdd.config`) in **every** phase — *including `off`* — until
  `SECURITY_REVIEW=1` is set for the edit. The disarm switch can't slip an auth/secret/CORS edit
  past review. Empty/unset glob = no-op.
- **run-suite** (PostToolUse) runs the active layer's suite and emits a `signal` tic — an
  **unforgeable** objective fact (an agent can't fake green).
- **require-green-to-stop** (Stop) refuses to finish on a red bar.
- **solo-drift-check** (Stop, non-blocking — a `Stop` rung, so it emits no tic and its firing is
  unobservable from the bus in any host) emits a NOTE when a session ran
  `SOLO_DRIFT_CYCLES` (default 3) suite cycles with **zero** REAL `from=subagent` handoffs —
  narrated delegate/handoff tics don't count; you have to actually spawn the role. Silence with
  `TEAM_ACCOUNTABILITY=0`; auto-silent on a `--minimal` install.
- **subagent-handoff / session-green-check** auto-emit handoff tics + warn on a red baseline.

## Cursor and other agents — method, plus a probe for what fires
Whether your host runs the `.claude/settings.json` hooks is **host-dependent** — so don't guess,
**probe it**. After an edit inside the layer's `SRC_GLOB`/`TEST_GLOB`, read the bus
(`.claude/hooks/tics log`): a **hook-signed** tic from `run-suite` (a `signal`) or `guard` (a
`block`) naming your file proves the hooks fired for your tool — those `from` identities are
**unforgeable** (reserved in `.claude/hooks/tic.sh` and the MCP server's `RESERVED_FROM`), so an
agent can't fake them; every other tic is **self-reported** (agent-emitted) — the same
`hook-signed` / `self-reported` split `tics gate` prints. **The probe is one-directional: presence proves you're refereed; absence
proves nothing** (`run-suite` is silent for out-of-glob paths and the guard is silent when it
allows). So on a miss, **assume you are refereed** and self-enforce anyway — it costs nothing if
the hooks fire and is the only thing standing if they don't.

Coverage precision, so you read the bus correctly: only the `PreToolUse` guard, the `PostToolUse`
`run-suite`, and `SubagentStop` leave a tic. The `Stop` rungs — **`require-green-to-stop` and
`solo-drift-check` — emit no tic**, so whether *they* fire is **unobservable from the bus** in any
host; the probe can neither confirm nor deny them.

What you get regardless of host:
- **AGENTS.md + `docs/`** — the full method, readable by any agent. The Cursor agent's loaded
  rule is **`.cursor/rules/tics.mdc`**, which points here for the method.
- **`.claude/hooks/tic.sh` / `.claude/hooks/tics`** — plain scripts you can call by hand to
  emit/read tics.
- `npx tics selftest` confirms the hooks are *installed* — but NOT that your host *fires* them
  (only a hook-signed tic proves that); and the portable referee (tier 2) covers commits + tag
  pushes under any tool once you run `npx tics install-hooks`.

**Self-enforce regardless — per edit:**
- [ ] Read `.claude/state/{phase,layer}`. red → edit only the layer's **tests**; green → only
      **source**; refactor → anything but keep green; off → ungated.
- [ ] Run the layer's test command yourself after each edit; treat red as a stop.
- [ ] Emit the tics the hooks would have — a `signal` after a run, `delegate`/`handoff`/`verdict`
      at the boundaries: `.claude/hooks/tic.sh <from> <to> <kind> "<msg>" <ref> <result>`.
- [ ] **Never** hand-emit a green `signal`/`handoff` while the suite is red — that breaks the
      one invariant the protocol rests on (signals are objective fact).
- [ ] **If a hook blocks you, comply** — never flip `.claude/state/phase` merely to unblock an
      edit. `phase` declares what you are doing; it is not a permission slip.
- [ ] **Parallel worktrees:** share one bus — set `TIC_STORE=spool` + `TICS_DIR` in
      `.claude/tdd.config` (see its "Parallel worktrees" block), or claims/needs fragment per
      worktree and the conductor can't see across them.

## Making it more automatic elsewhere — the portable referee (tier 2)
- **CI (any tool):** `.github/workflows/tdd-verify.yml` (seeded) runs the suite on every
  push/PR — the always-on gate.
- **Local git hooks:** **`npx tics install-hooks`** installs **three** portable git hooks into
  the repo (git runs them under any tool, covering every worktree):
  - **pre-commit — green-bar gate:** a red suite blocks the commit. Disable `PRECOMMIT_GATE=0`.
  - **post-commit — `commit`-tic emitter:** every commit lands on the bus, so cross-tool
    visibility holds no matter which agent committed. Disable `COMMIT_TIC=0`.
  - **pre-push — release gate (GT-2):** on a `v*` **tag** push it runs `tics gate` (=
    product-owner accept + tdd-critic PASS on the bus). **Advisory by default** (prints a NOTE);
    `RELEASE_GATE_ENFORCE=1` makes it block the push; **fail-closed** if no `.claude/hooks/tics`
    reader is installed and enforce is on. Skip with `RELEASE_GATE=0`. (The same hook also runs a
    tag↔`package.json` version lockstep check; skip with `TAGGATE=0`.)
- **Bypass any commit/push hook once:** `git commit --no-verify` / `git push --no-verify`.
- If your tool has its own hook/rules system, wire it to the same scripts.

**The one line to remember:** the **release gate (GT-2) is portable to any tool** via
`install-hooks`; the `.claude/settings.json` referee (phase gate, security guard, solo-drift) is
**host-dependent** — probe the bus for a hook-signed tic to learn whether it fires for your host,
and self-enforce regardless.
