/* eslint-disable -- generated kit reader (CommonJS Node) */
"use strict";
// tics-view.js — the tic READ layer (loadTics + views), shared by the installed reader
// (.claude/hooks/tics) and the package CLI (bin/cli.js). Zero-dep; do NOT edit (refreshed).
const fs = require("fs"), path = require("path"), cp = require("child_process");
const READER_WINDOW = 40;
function storePaths(targetDir, ignoreEnv) {
  const dir = path.join(targetDir, ".claude", "state");
  // TICS_DIR / TICS_FILE let parallel worktree sections share ONE spool bus (see docs/tdd/sectioning.md).
  return { jsonl: (!ignoreEnv && process.env.TICS_FILE) || path.join(dir, "tics.jsonl"), spool: (!ignoreEnv && process.env.TICS_DIR) || path.join(dir, "tics.d") };
}
function loadTics(targetDir, ignoreEnv) {
  const { jsonl, spool } = storePaths(targetDir, ignoreEnv);
  const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
  const out = [];
  try { for (const l of fs.readFileSync(jsonl, "utf8").split("\n")) if (l.trim()) { const o = parse(l); if (o) out.push(o); } } catch (e) {}
  try { for (const f of fs.readdirSync(spool)) if (f.endsWith(".json")) { const o = parse(fs.readFileSync(path.join(spool, f), "utf8").trim()); if (o) out.push(o); } } catch (e) {}
  out.sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")) || ((a.seq || 0) - (b.seq || 0)));
  return out;
}
function worktreeDirs(targetDir) {
  try {
    const out = cp.execFileSync("git", ["-C", targetDir, "worktree", "list", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const dirs = out.split("\n").filter((l) => l.indexOf("worktree ") === 0).map((l) => l.slice(9).trim()).filter(Boolean);
    return dirs.length ? dirs : [targetDir];
  } catch (e) { return [targetDir]; }
}
function loadTicsAll(targetDir) {
  const seen = new Set(), out = [];
  // Dedup key INCLUDES seq: an inherited worktree bus is a byte-copy (same seq+ts+content) and
  // collapses, but two legitimately-distinct tics that merely share a ts (e.g. rapid run-suite
  // signals, or test fixtures) keep their distinct seq and are preserved.
  const push = (arr) => { for (const x of arr) { const k = (x.seq || "") + "|" + (x.ts || "") + "|" + (x.kind || "") + "|" + (x.from || "") + "|" + (x.to || "") + "|" + (x.msg || "") + "|" + (x.scope || "") + "|" + (x.session || "") + "|" + (x.ref || ""); if (!seen.has(k)) { seen.add(k); out.push(x); } } };
  push(loadTics(targetDir));                                  // current bus (env-resolved, e.g. a shared TICS_DIR)
  for (const root of worktreeDirs(targetDir)) push(loadTics(root, true));   // each worktree's own default bus
  out.sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")) || ((a.seq || 0) - (b.seq || 0)));
  return out;
}
function loadFor(targetDir, all) { return all ? loadTicsAll(targetDir) : loadTics(targetDir); }
function loadSignalEvents(targetDir) {
  const { jsonl, spool } = storePaths(targetDir);
  if (fs.existsSync(jsonl) || fs.existsSync(spool))
    return loadTics(targetDir).filter((t) => t.kind === "signal");
  try {
    return fs.readFileSync(path.join(targetDir, ".claude", "state", "telemetry.jsonl"), "utf8")
      .split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter((e) => e && e.event === "suite");
  } catch (e) { return []; }
}
function scopeMatch(s, f) {
  s = s || "*";
  return s === f || s === "*" || f === "*" || s.indexOf(f + "/") === 0 || f.indexOf(s + "/") === 0;
}
function collapseRunSuite(list) {
  // Fold a run of consecutive run-suite signals with the same result into one row (x N) —
  // keeps the thread readable; the store is untouched so report() still sees every run.
  const out = [];
  for (const x of list) {
    const p = out[out.length - 1];
    if (p && p.kind === "signal" && p.from === "run-suite" && x.kind === "signal" && x.from === "run-suite" && (x.result || "") === (p.result || "")) {
      p._count = (p._count || 1) + 1; p.ts = x.ts || p.ts; p.seq = x.seq || p.seq;
    } else { out.push(Object.assign({}, x)); }
  }
  return out;
}
function applyWindow(t, full) {
  const total = t.length;
  const truncated = !full && total > READER_WINDOW;
  return { rows: truncated ? t.slice(-READER_WINDOW) : t, total, truncated };
}
function ticsLog(targetDir, scopeFilter, all, showWitness, full) {
  let t = loadFor(targetDir, all);
  if (scopeFilter) t = t.filter((x) => scopeMatch(x.scope, scopeFilter));
  if (!showWitness) t = t.filter((x) => !(x.kind === "note" && x.from === "witness"));
  if (!t.length) { console.log("No tics yet — the agent thread is empty (.claude/state/tics.jsonl)."); return 0; }
  t = collapseRunSuite(t);
  const { rows, total, truncated } = applyWindow(t, full);
  for (const x of rows) {
    const when = (x.ts || "").slice(11, 19) || "--:--:--";
    const arrow = ((x.from || "?") + " -> " + (x.to || "*")).padEnd(28);
    const kind = (x.kind || "?").padEnd(9);
    const ctx = ("[" + (x.layer || "?") + "/" + (x.phase || "?") + " " + (x.scope || "*") + "]").padEnd(22);
    console.log(String(x.seq || "").padStart(3) + "  " + when + "  " + arrow + kind + ctx + " " + (x.msg || "") + (x._count > 1 ? " x" + x._count : "") + (x.result ? "  (" + x.result + ")" : ""));
  }
  if (truncated) console.log("  … showing last " + READER_WINDOW + " of " + total + " — use --full to see all");
  return 0;
}
function ticsInbox(targetDir, role, scopeFilter, full) {
  if (!role) { console.error("usage: tics inbox <role>   (e.g. tics inbox architect)"); return 2; }
  let t = loadTics(targetDir).filter((x) => (x.to === role || x.to === "*") && x.kind !== "signal");
  if (scopeFilter) t = t.filter((x) => scopeMatch(x.scope, scopeFilter));
  if (!t.length) { console.log("Inbox empty for '" + role + "' (no tics addressed to it or broadcast)."); return 0; }
  t = collapseRunSuite(t);
  const { rows, total, truncated } = applyWindow(t, full);
  console.log("Inbox for " + role + "  (to = " + role + " or *):");
  for (const x of rows) console.log("  #" + (x.seq || "?") + "  " + (x.from || "?") + " [" + (x.kind || "?") + "]  " + (x.msg || "") + (x._count > 1 ? " x" + x._count : "") + (x.result ? "  (" + x.result + ")" : ""));
  if (truncated) console.log("  … showing last " + READER_WINDOW + " of " + total + " — use --full to see all");
  return 0;
}
function ticsConductor(targetDir, all) {
  const COUPLING = ["claim", "release", "contract", "need", "section", "msg"];
  const tics = loadFor(targetDir, all);
  const t = tics.filter((x) => COUPLING.indexOf(x.kind) !== -1);
  if (!t.length) { console.log("No coupling tics yet (claim/release/contract/need/section/msg)."); return 0; }

  // Per-scope summary: each working unit's section status + active claims + needs/contracts.
  // One place the orchestrator sees grouping (sections) + coupling (claims) + who-owns-what.
  const active = claimsFor(targetDir, tics);
  const secStatus = new Map();
  for (const x of tics) if (x.kind === "section" && x.ref && x.result) secStatus.set(x.ref, x.result);
  const scopes = new Map();
  const claimsByScope = new Map();
  for (const x of t) {
    const sc = x.scope || "*";
    if (sc === "*") continue;
    let e = scopes.get(sc);
    if (!e) { e = { needs: [], contracts: [], hadClaim: false }; scopes.set(sc, e); }
    if (x.kind === "claim") e.hadClaim = true;
    if (x.kind === "need") e.needs.push(x.msg || x.ref || "?");
    if (x.kind === "contract") e.contracts.push(x.msg || x.ref || "?");
  }
  for (const x of active.values()) {
    const sc = x.scope || "*"; if (sc === "*") continue;
    let r = claimsByScope.get(sc); if (!r) { r = []; claimsByScope.set(sc, r); }
    r.push(x.ref);
  }
  if (scopes.size) {
    console.log("Conductor view — sections & coupling:");
    for (const sc of [...scopes.keys()].sort()) {
      const e = scopes.get(sc);
      const status = secStatus.get(sc.split("/")[0]) || "active";
      const refs = claimsByScope.get(sc) || [];
      const claimsStr = refs.length ? refs.join(", ") : (status === "done" && e.hadClaim ? "(freed)" : "-");
      let line = "  " + sc.padEnd(14) + ("[" + status + "]").padEnd(9) + "claims: " + claimsStr;
      if (e.needs.length) line += "   needs: " + e.needs.join(", ");
      if (e.contracts.length) line += "   contract: " + e.contracts.join(", ");
      console.log(line);
    }
    console.log("");
  }

  console.log("Cross-pair coupling tics:");
  for (const x of t) {
    const when = (x.ts || "").slice(11, 19);
    console.log("  #" + (x.seq || "?") + " " + when + "  " + (x.from || "?") + " -> " + (x.to || "*") + "  [" + (x.kind || "?") + " " + (x.scope || "*") + "]  " + (x.msg || "") + (x.ref ? " {" + x.ref + "}" : "") + (x.result ? " (" + x.result + ")" : ""));
  }
  return 0;
}
function ticsClaims(targetDir, all) {
  const active = claimsFor(targetDir, loadFor(targetDir, all));
  if (!active.size) { console.log("No active claims."); return 0; }
  console.log("Active claims (claim minus release):");
  for (const x of active.values()) console.log("  " + x.ref + "  <-  " + (x.scope || "?") + "  (#" + (x.seq || "?") + " " + (x.from || "?") + ")");
  return 0;
}
function ticsSections(targetDir, all) {
  const t = loadFor(targetDir, all);
  const sec = {};
  for (const x of t) {
    const sc = x.scope || "*";
    if (sc === "*") continue;
    const name = sc.split("/")[0];
    const e = sec[name] || (sec[name] = { tics: 0, claims: 0, contracts: 0, needs: 0, last: "", status: "" });
    e.tics++;
    if (x.kind === "claim") e.claims++;
    if (x.kind === "release") e.claims--;
    if (x.kind === "contract") e.contracts++;
    if (x.kind === "need") e.needs++;
    if (x.kind === "section" && x.result) e.status = x.result;   // open|done — append order, latest wins
    if ((x.ts || "") > e.last) e.last = x.ts || "";
  }
  const names = Object.keys(sec).sort();
  if (!names.length) { console.log("No sections yet — scope work with: echo <section>/<pair> > .claude/state/scope"); return 0; }
  console.log("Sections (live, from the tic log):");
  for (const n of names) {
    const e = sec[n];
    const st = e.status || "active";   // present in the log but never explicitly opened/closed => active
    console.log("  " + n.padEnd(16) + ("[" + st + "]").padEnd(9) + e.tics + " tics | claims " + Math.max(0, e.claims) + " | contracts " + e.contracts + " | needs " + e.needs + "  (last " + (e.last || "").slice(11, 19) + ")");
  }
  return 0;
}
// Active claims = claim minus release, MINUS any whose section (scope's first component) is
// marked `done` — a closed section auto-releases its claims so the partition frees up for
// reassignment (release-on-done). The single source of truth for every claim consumer.
function activeClaims(tics) {
  const active = new Map();
  const status = new Map();       // section name -> latest lifecycle status (open|done)
  for (const x of tics) {
    if (x.kind === "section" && x.ref && x.result) status.set(x.ref, x.result);
    if (x.kind === "claim" && x.ref) active.set(x.ref, x);
    else if (x.kind === "release" && x.ref) active.delete(x.ref);
  }
  for (const [ref, x] of active) {
    if (status.get((x.scope || "").split("/")[0]) === "done") active.delete(ref);   // release-on-section-done
  }
  return active;
}
// Read a numeric setting from tdd.config (e.g. LIVENESS_IDLE_SEC), default if absent/unreadable.
function cfgNum(targetDir, key, def) {
  try { const m = fs.readFileSync(path.join(targetDir, ".claude", "tdd.config"), "utf8").match(new RegExp("^\\s*" + key + "\\s*=\\s*(\\d+)", "m")); return m ? parseInt(m[1], 10) : def; }
  catch (e) { return def; }
}
function cfgStr(targetDir, key, def) {
  try {
    const m = fs.readFileSync(path.join(targetDir, ".claude", "tdd.config"), "utf8").match(new RegExp("^\\s*" + key + "\\s*=\\s*(.+?)\\s*$", "m"));
    if (!m) return def;
    let v = m[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v;
  } catch (e) { return def; }
}
// Classify a green signal as hook-signed (objective) or self-reported (role), null otherwise.
function greenAttestation(tic) {
  if (!tic) return null;
  if (tic.kind !== "signal" || tic.result !== "green") return null;
  if (tic.from === "run-suite") return "hook-signed";
  if (tic.from && typeof tic.from === "string" && tic.from.length > 0) return "self-reported";
  return null;
}
// Return true only for a red signal emitted by run-suite (hook-signed red).
function isHookSignedRed(tic) {
  if (!tic) return false;
  return tic.kind === "signal" && tic.result === "red" && tic.from === "run-suite";
}
// Fold signals into attestation counts: hook-signed vs self-reported green signals.
function attestationTally(signals) {
  const out = { hookSigned: 0, selfReported: 0, greens: 0 };
  if (!Array.isArray(signals)) return out;
  for (const tic of signals) {
    const a = greenAttestation(tic);
    if (a === "hook-signed") { out.hookSigned++; out.greens++; }
    else if (a === "self-reported") { out.selfReported++; out.greens++; }
  }
  return out;
}
// Classify how fresh a last-tic timestamp is. Aliver tier wins at boundaries (inclusive).
function livenessTier(lastTs, nowMs, idleSec, staleSec) {
  if (lastTs == null) return "unknown";
  const t = Date.parse(lastTs);
  if (isNaN(t)) return "unknown";
  const age = (nowMs - t) / 1000;
  if (age <= idleSec) return "live";
  if (age <= staleSec) return "idle";
  return "stale";
}
// Active claims for a target dir (claim minus release, minus release-on-section-done).
// The single entry every claim consumer uses.
function claimsFor(targetDir, tics) { return activeClaims(tics); }
// Fleet model: fold the bus into members grouped by held scope, with liveness tiers.
// opts.nowMs injectable for tests; idleSec/staleSec come from tdd.config with defaults.
function fleetModel(targetDir, tics, opts) {
  opts = opts || {};
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  const idleSec = cfgNum(targetDir, "LIVENESS_IDLE_SEC", 300);
  const staleSec = cfgNum(targetDir, "LIVENESS_STALE_SEC", 900);
  // One pass here builds sessLatest and the per-scope session sets (for collision detection);
  // claimsFor (below) folds the bus again to apply the release filters.
  const sessLatest = new Map();
  const scopeSessions = new Map(); // scope -> Set of distinct sessions (for collision detection)
  for (const x of tics) {
    const id = x.session || "";
    if (id) { const ts = x.ts || ""; if (ts > (sessLatest.get(id) || "")) sessLatest.set(id, ts); }
    const sc = x.scope || "";
    if (sc && sc !== "*" && id && id !== "*") { let s = scopeSessions.get(sc); if (!s) { s = new Set(); scopeSessions.set(sc, s); } s.add(id); }
  }
  const activeCls = claimsFor(targetDir, tics);
  const sessScope = new Map();
  for (const x of activeCls.values()) {
    if (x.session && x.scope && x.scope !== "*") sessScope.set(x.session, x.scope);
  }
  const members = [];
  for (const [id, lastTs] of sessLatest.entries()) {
    const scope = sessScope.get(id) || null;
    const liveness = livenessTier(lastTs, nowMs, idleSec, staleSec);
    const stuck = scope != null && liveness === "stale";
    members.push({ session: id, scope, liveness, lastTs, stuck });
  }
  const byScope = {};
  for (const m of members) {
    const key = m.scope || "unscoped";
    if (!byScope[key]) byScope[key] = [];
    byScope[key].push(m);
  }
  const tally = { live: 0, idle: 0, stale: 0, unknown: 0 };
  for (const m of members) tally[m.liveness] = (tally[m.liveness] || 0) + 1;
  // Collisions: scopes touched by >=2 distinct sessions.
  const collisions = [];
  for (const [sc, sessSet] of scopeSessions.entries()) {
    if (sessSet.size >= 2) collisions.push({ scope: sc, sessions: [...sessSet].sort() });
  }
  return { members, byScope, tally, collisions };
}
// Roster view (ADR 0010): one row per standard role showing the configured MODEL_<ROLE> or "(default)".
function ticsRoster(targetDir) {
  const ROLES = ["test-writer", "implementer", "architect", "tdd-critic", "product-owner", "qa-verifier", "project-manager", "dev-ops"];
  const t = loadTics(targetDir).filter((x) => x.kind === "verdict" && (x.result === "accept" || x.result === "edit" || x.result === "reject"));
  console.log("Model roster (MODEL_<ROLE> in tdd.config):");
  for (const role of ROLES) {
    const key = "MODEL_" + role.toUpperCase().replace(/-/g, "_");
    const model = cfgStr(targetDir, key, "");
    const shown = model || "(default)";
    const a = t.filter((x) => x.to === role && x.result === "accept").length;
    const e = t.filter((x) => x.to === role && x.result === "edit").length;
    const r = t.filter((x) => x.to === role && x.result === "reject").length;
    const drafts = (a + e + r) > 0 ? "  drafts " + a + "/" + e + "/" + r : "";
    console.log("  " + role.padEnd(16) + shown + drafts);
  }
  return 0;
}
// Review view (ADR 0012): navigator queue — open needs grouped by addressable (has ref) vs unaddressable.
function ticsReview(targetDir, scopeFilter, all) {
  let opens = openNeeds(loadFor(targetDir, all));
  if (scopeFilter) opens = opens.filter((x) => scopeMatch(x.scope, scopeFilter));
  if (!opens.length) { console.log("No open needs — the navigator queue is clear."); return 0; }
  const addressable = opens.filter((x) => x.ref);
  const unaddressable = opens.filter((x) => !x.ref);
  console.log("Open needs (navigator queue):");
  for (const n of addressable) {
    console.log("  " + (n.handle || n.ref).padEnd(16) + (n.from || "?") + " -> " + (n.to || "*") + "  [" + (n.scope || "*") + "]  " + (n.msg || ""));
  }
  if (unaddressable.length) {
    console.log("  --- unaddressable (no ref) — re-ask with a ref to make them answerable ---");
    for (const n of unaddressable) {
      console.log("  " + (n.handle).padEnd(16) + (n.from || "?") + " -> " + (n.to || "*") + "  [" + (n.scope || "*") + "]  " + (n.msg || ""));
    }
  }
  console.log("Answer with: tics answer <handle> \"<text>\"");
  return 0;
}
// Board view (ADR 0008): fleet at a glance — members grouped by held scope with liveness tier.
function ticsBoard(targetDir, all) {
  const tics = loadFor(targetDir, all);
  const model = fleetModel(targetDir, tics);
  if (!model.members.length) { console.log("No fleet activity yet — the agent bus is empty."); return 0; }
  console.log("Fleet board:");
  const scopes = Object.keys(model.byScope).sort((a, b) => {
    if (a === "unscoped") return 1;
    if (b === "unscoped") return -1;
    return a.localeCompare(b);
  });
  for (const sc of scopes) {
    console.log("  [" + sc + "]");
    for (const m of model.byScope[sc]) {
      const when = (m.lastTs || "").slice(11, 19);
      const stuckMark = m.stuck ? "  STUCK" : "";
      console.log("    " + m.session.padEnd(16) + m.liveness.padEnd(8) + when + stuckMark);
    }
  }
  if (model.collisions.length) {
    console.log("Scope collisions (>=2 distinct sessions on one scope):");
    for (const c of model.collisions) {
      console.log("  collision: " + c.scope + "  sessions=" + c.sessions.join(", "));
    }
  }
  return 0;
}
function claimCheck(targetDir, file, myScope) {
  if (!file || !myScope) return null;            // unscoped editor or no path -> no enforcement
  const active = claimsFor(targetDir, loadTicsAll(targetDir));   // ADR 0004 pt2: enforce ACROSS worktrees (the host gives each session its own) so a peer's claim is seen
  for (const x of active.values()) {
    const hit = [x.ref, x.msg].filter(Boolean).some((t) => file === t || file.indexOf(t) !== -1 || t.indexOf(file) !== -1);
    if (hit && !scopeMatch(x.scope || "*", myScope)) return { token: x.ref, scope: x.scope || "*", seq: x.seq, from: x.from };
  }
  return null;
}
function claimCheckCli(targetDir, file, myScope) {
  const c = claimCheck(targetDir, file, myScope);
  if (c) { console.log(c.scope + " (#" + (c.seq || "?") + " " + (c.from || "?") + ", claim:" + c.token + ")"); return 3; }
  return 0;
}
// claimOwner: which scope (if any) actively holds a path — empty when unclaimed. Unlike
// claim-check (a yes/no guard relative to MY scope), this is a plain ownership lookup, so
// the guard can tell "unclaimed" (auto-claim it) from "already mine" (skip — no re-claim spam).
function claimOwner(targetDir, file) {
  if (!file) return "";
  const active = claimsFor(targetDir, loadTicsAll(targetDir));   // ADR 0004 pt2: enforce ACROSS worktrees (the host gives each session its own) so a peer's claim is seen
  for (const x of active.values()) {
    const hit = [x.ref, x.msg].filter(Boolean).some((t) => file === t || file.indexOf(t) !== -1 || t.indexOf(file) !== -1);
    if (hit) return x.scope || "*";
  }
  return "";
}
// claimSession: which SESSION (not scope) holds an active claim on a path — empty if free. The
// cross-session predicate the pre-commit gate uses (ADR 0002 MS3/MS4): a staged file or the
// RELEASE lock held by a session OTHER than mine must block the commit.
function claimSession(targetDir, file) {
  if (!file) return "";
  const active = claimsFor(targetDir, loadTicsAll(targetDir));   // ADR 0004 pt2: enforce ACROSS worktrees (the host gives each session its own) so a peer's claim is seen
  for (const x of active.values()) {
    const hit = [x.ref, x.msg].filter(Boolean).some((t) => file === t || file.indexOf(t) !== -1 || t.indexOf(file) !== -1);
    if (hit) return x.session || "";
  }
  return "";
}
function claimSessionCli(targetDir, file) { const s = claimSession(targetDir, file); if (s) console.log(s); return 0; }
function claimOwnerCli(targetDir, file) {
  const o = claimOwner(targetDir, file);
  if (o) console.log(o);
  return 0;
}
// sectionStatus: the latest lifecycle status of a section (open|done), empty if never opened.
// Lets the guard auto-open a section once on first scoped activity without re-opening it.
function sectionStatus(targetDir, name) {
  if (!name) return "";
  let st = "";
  for (const x of loadTics(targetDir)) {
    if (x.kind === "section" && x.ref === name && x.result) st = x.result;
  }
  return st;
}
function sectionStatusCli(targetDir, name) {
  const s = sectionStatus(targetDir, name);
  if (s) console.log(s);
  return 0;
}
function ticsCycle(targetDir) {
  const st = path.join(targetDir, ".claude", "state");
  const rd = (f) => { try { return fs.readFileSync(path.join(st, f), "utf8").trim(); } catch (e) { return ""; } };
  const phase = rd("phase") || "?", layer = rd("layer") || "?", scope = rd("scope") || "*";
  const t = loadTics(targetDir);
  const lastSig = [...t].reverse().find((x) => x.kind === "signal");
  let since = 0;
  for (let i = t.length - 1; i >= 0; i--) { if (t[i].kind === "verdict") break; if (t[i].kind === "signal" || t[i].kind === "handoff") since++; }
  console.log("Cycle: phase=" + phase + " layer=" + layer + " scope=" + scope);
  console.log("  last suite: " + (lastSig ? (lastSig.result || "?") : "(none yet)"));
  const streak = parseInt(rd("red-streak") || "0", 10);
  if (streak > 0) {
    const lim = cfgNum(targetDir, "RED_STREAK_LIMIT", 5);
    if (streak >= lim) console.log("  red-streak: " + streak + " reds in a row — suspected OVER-CONSTRAINED/CONTRADICTORY test; reconsider it (route to test-writer) or escalate, don't grind.");
    else console.log("  red-streak: " + streak);
  }
  if (since > 5) console.log("  " + since + " cycles since the last tdd-critic verdict — consider a critic pass (rule: every ~3-5 cycles).");
  else console.log("  " + since + " cycles since the last critic verdict.");
  const fm = fleetModel(targetDir, t);
  const stuck = fm.members.filter((m) => m.stuck).length;
  const tl = fm.tally;
  console.log("  Fleet: " + stuck + " stuck, " + fm.collisions.length + " collisions | live " + tl.live + " idle " + tl.idle + " stale " + tl.stale + " unknown " + tl.unknown);
  return 0;
}
function verdictOutcome(x) {
  const r = (x.result || "").toLowerCase();
  if (r === "pass" || r === "accept" || r === "accepted" || r === "approved") return "pass";
  if (r === "concerns" || r === "block" || r === "blocked" || r === "reject" || r === "rejected") return r;
  const m = (x.msg || "").toLowerCase();
  if (/\b(block|concern|fail|reject)/.test(m)) return "concerns";
  if (/\b(pass|accept|approv)/.test(m)) return "pass";
  return "unknown";
}
function ticsGate(targetDir, all) {
  const t = (all ? loadTicsAll(targetDir) : loadTics(targetDir)).filter((x) => x.kind === "verdict");
  const latest = {};
  for (const x of t) latest[x.from] = x;
  const problems = [];
  for (const role of ["product-owner", "tdd-critic"]) {
    const v = latest[role];
    if (!v) { problems.push("no " + role + " verdict on the bus"); continue; }
    const o = verdictOutcome(v);
    if (o !== "pass") problems.push(role + ": " + o + "  (#" + (v.seq || "?") + " " + (v.msg || "").slice(0, 60) + ")");
  }
  const qa = latest["qa-verifier"];
  if (qa && verdictOutcome(qa) !== "pass") problems.push("qa-verifier: " + verdictOutcome(qa));
  const signals = (all ? loadTicsAll(targetDir) : loadTics(targetDir)).filter((x) => x.kind === "signal");
  const att = attestationTally(signals);
  const enforce = cfgNum(targetDir, "ATTEST_ENFORCE", 0) === 1;
  const attestFail = (att.greens >= 1 && att.hookSigned === 0);
  if (attestFail) {
    console.error("  ⚠ no hook-signed green evidence — all " + att.selfReported + " green(s) are self-reported (not signed by the run-suite hook). The referee may not have run for this work. (ATTEST_ENFORCE=" + (enforce ? "1" : "0") + ")");
  }
  if (attestFail && enforce) {
    problems.push("unrefereed greens: all " + att.selfReported + " green(s) are self-reported (not hook-signed); set ATTEST_ENFORCE=0 or supply a hook-signed green (run-suite)");
  }
  const ev = evidenceFor(targetDir, signals);
  const evEnforce = cfgNum(targetDir, "EVIDENCE_ENFORCE", 0) === 1;
  if (ev.anyNotTestFirst) {
    const bad = ev.scopes.filter(function(s) { return s.hasGreen && !s.redBeforeGreen; }).map(function(s) { return s.scope; });
    console.error("  ⚠ green(s) without red-before-green evidence — not proven test-first on: " + bad.join(", ") + " (EVIDENCE_ENFORCE=" + (evEnforce ? "1" : "0") + ")");
    if (evEnforce) {
      problems.push("not-test-first greens on: " + bad.join(", ") + " — supply a hook-signed red-before-green on the scope, or set EVIDENCE_ENFORCE=0");
    }
  }
  if (!problems.length) {
    console.log("Release gate: CLEAR — product-owner + tdd-critic verdicts are pass" + (qa ? " (+ qa-verifier)" : "") + ".");
    return 0;
  }
  console.error("Release gate: BLOCKED — " + problems.length + " issue(s):");
  for (const p of problems) console.error("  - " + p);
  console.error("  Release only when PO-accept + tdd-critic PASS are on the bus (see docs/tdd/outer-loop.md).");
  return 1;
}
// fan-out: the plan-time disjointness gate. Reads a partition spec (one section per line:
// "<section> <file>..."), assigns each a scope (<section>/S<n>), and refuses to greenlight a
// fan-out where two sections claim the same file — auto-claim catches collisions at RUNTIME;
// this catches them before any pair starts. Read-only; the orchestrator sets scopes + delegates.
function fanOut(targetDir, specPath) {
  if (!specPath) { console.error("usage: tics fan-out <partition-spec-file>  (lines: '<section> <file>...')"); return 2; }
  let text;
  try { text = fs.readFileSync(specPath, "utf8"); }
  catch (e) { console.error("fan-out: cannot read spec '" + specPath + "'"); return 2; }
  const sections = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const name = parts.shift();
    sections.push({ name: name, files: parts });
  }
  if (!sections.length) { console.log("fan-out: no sections in spec."); return 0; }
  const owners = new Map();   // file -> [section names]
  for (const s of sections) for (const f of s.files) {
    let o = owners.get(f); if (!o) { o = []; owners.set(f, o); }
    if (o.indexOf(s.name) === -1) o.push(s.name);
  }
  const overlaps = [...owners.entries()].filter(function (e) { return e[1].length > 1; });
  console.log("Fan-out plan (" + sections.length + " sections):");
  sections.forEach(function (s, i) {
    const scope = s.name + "/S" + (i + 1);
    const dup = s.files.some(function (f) { return owners.get(f).length > 1; });
    console.log("  " + s.name.padEnd(12) + (s.files.length + " files").padEnd(9) + " -> scope " + scope.padEnd(16) + (dup ? "[OVERLAP]" : "[disjoint ✓]"));
  });
  if (overlaps.length) {
    for (const e of overlaps) console.log("  ⚠ overlap: " + e[0] + " in " + e[1].join(" + ") + " — serialize, or split the file (fix the seam).");
    console.log("Not safe to fan out as-is — resolve the overlaps above.");
    return 1;
  }
  console.log("All partitions disjoint — safe to fan out. Set each pair's scope and delegate.");
  return 0;
}
function main(argv, defaultRoot) {
  let scope = null, all = true, fromRole = null, showWitness = false, full = false; const rest = [];   // whole-picture by default (merge every worktree's bus); --here restricts to the local bus
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a === "--scope") scope = argv[++i] || ""; else if (a === "--all") all = true; else if (a === "--here") all = false; else if (a === "--from") fromRole = argv[++i] || null; else if (a === "--witness") showWitness = true; else if (a === "--full") full = true; else rest.push(a); }
  const cmd = rest.shift();
  const role = cmd === "inbox" ? rest.shift() : null;
  const cfFile = cmd === "claim-check" ? rest.shift() : null;
  const cfScope = cmd === "claim-check" ? (rest.shift() || scope || "") : null;
  const coFile = cmd === "claim-owner" ? rest.shift() : null;
  const csFile = cmd === "claim-session" ? rest.shift() : null;
  const soName = cmd === "section-status" ? rest.shift() : null;
  const foSpec = cmd === "fan-out" ? rest.shift() : null;
  const whereArg = cmd === "where" ? rest.shift() : null;
  const howArg = cmd === "how" ? rest.shift() : null;
  const ansHandle = cmd === "answer" ? rest.shift() : null;
  const ansText = cmd === "answer" ? rest.join(" ") : null;
  if (cmd === "answer") { rest.length = 0; }
  const target = rest[0] ? path.resolve(rest[0]) : (defaultRoot || process.cwd());
  switch (cmd) {
    case "log": return ticsLog(target, scope, all, showWitness, full);
    case "inbox": return ticsInbox(target, role, scope, full);
    case "conductor": return ticsConductor(target, all);
    case "claims": return ticsClaims(target, all);
    case "sections": return ticsSections(target, all);
    case "map": return ticsLandmarks(target, all);
    case "where": return ticsWhere(target, whereArg, all);
    case "how": return ticsHow(target, howArg, all);
    case "cycle": return ticsCycle(target);
    case "gate": return ticsGate(target, all);
    case "claim-check": return claimCheckCli(target, cfFile, cfScope);
    case "claim-owner": return claimOwnerCli(target, coFile);
    case "claim-session": return claimSessionCli(target, csFile);
    case "section-status": return sectionStatusCli(target, soName);
    case "fan-out": return fanOut(target, foSpec);
    case "board": return ticsBoard(target, all);
    case "roster": return ticsRoster(target);
    case "review": return ticsReview(target, scope, all);
    case "answer": return ticsAnswer(target, ansHandle, ansText, fromRole, all);
    default: console.error("usage: tics <log [--scope S] | inbox <role> [--scope S] | conductor | claims | sections | board | roster | review | answer <handle> \"<text>\" | claim-check <file> <scope> | claim-owner <file> | section-status <name> | fan-out <spec>] [--all]>"); return 2;
  }
}
if (require.main === module) {
  process.exit(main(process.argv.slice(2), path.join(__dirname, "..", "..")) || 0);
}
// Pure fold: does the tic list evidence test-first discipline per scope?
// targetDir is accepted for signature symmetry but the fold reads only the passed tics list.
function evidenceFor(targetDir, tics) {
  if (!Array.isArray(tics)) return { scopes: [], anyGreen: false, anyNotTestFirst: false };
  // Per real-scope buckets: { latestGreenSeq, minHookRedSeq }
  const buckets = new Map();
  let anyGreen = false;
  for (const t of tics) {
    if (greenAttestation(t) === "hook-signed") {
      anyGreen = true;
      const sc = t.scope || "";
      if (sc === "" || sc === "*") continue; // un-replayable, skip per-scope
      const b = buckets.get(sc) || { latestGreenSeq: -Infinity, minHookRedSeq: Infinity };
      const s = (typeof t.seq === "number" ? t.seq : 0);
      if (s > b.latestGreenSeq) b.latestGreenSeq = s;
      buckets.set(sc, b);
    } else if (isHookSignedRed(t)) {
      const sc = t.scope || "";
      if (sc === "" || sc === "*") continue;
      const b = buckets.get(sc) || { latestGreenSeq: -Infinity, minHookRedSeq: Infinity };
      const s = (typeof t.seq === "number" ? t.seq : 0);
      if (s < b.minHookRedSeq) b.minHookRedSeq = s;
      buckets.set(sc, b);
    }
  }
  const scopes = [];
  let anyNotTestFirst = false;
  for (const [scope, b] of buckets.entries()) {
    if (b.latestGreenSeq === -Infinity) continue; // no hook-signed green for this scope
    const hasGreen = true;
    const redBeforeGreen = b.minHookRedSeq < b.latestGreenSeq;
    const honored = hasGreen && redBeforeGreen;
    if (!redBeforeGreen) anyNotTestFirst = true;
    scopes.push({ scope, hasGreen, redBeforeGreen, honored });
  }
  return { scopes, anyGreen, anyNotTestFirst };
}
// Answer an open need: emit a msg+answered tic to the asker.
function ticsAnswer(targetDir, handle, text, fromRole, all) {
  if (!handle || !text) { console.error("usage: tics answer <handle> \"<text>\""); return 2; }
  const opens = openNeeds(loadFor(targetDir, all));
  const want = handle;
  const need = opens.find(function(n) { return n.handle === want || ("n" + n.seq) === want || String(n.seq) === want; });
  if (!need) { console.error("no open need with handle '" + handle + "'"); return 2; }
  const asker = need.from || "*";
  const token = need.handle;
  const from = fromRole || "navigator";
  const ticsh = path.join(targetDir, ".claude", "hooks", "tic.sh");
  try {
    cp.execFileSync(ticsh, [from, asker, "msg", text, token, "answered"], { cwd: targetDir, stdio: "ignore" });
  } catch (e) { console.error("answer: could not emit (" + (e && e.message) + ")"); return 2; }
  console.log("answered " + token + " -> " + asker + ": " + text);
  return 0;
}
// Pure fold: returns the subset of `need` tics that have not yet been answered.
// A need is settled when a `msg` tic with `result==="answered"` references its token
// (ref if present, else "n"+seq). A bare-ref msg without result=answered never settles a need.
function openNeeds(tics) {
  if (!Array.isArray(tics)) return [];
  const answered = new Set();
  for (const x of tics) if (x && x.kind === "msg" && x.result === "answered" && x.ref) answered.add(x.ref);
  const out = [];
  for (const x of tics) {
    if (!x || x.kind !== "need") continue;
    const handle = x.ref ? x.ref : ("n" + x.seq);
    if (!answered.has(handle)) out.push(Object.assign({}, x, { handle }));
  }
  return out;
}
// Pure fold: tally per-tool usage from witness notes (from=witness, msg starts with "used ").
// Returns a map { <tool>: count } or {} if no witness notes match. Never throws.
function toolTally(tics) {
  if (!Array.isArray(tics)) return {};
  const out = {};
  for (const x of tics) {
    if (x && x.kind === "note" && x.from === "witness" && typeof x.msg === "string" && x.msg.indexOf("used ") === 0) {
      const tool = x.msg.slice(5).trim();
      if (tool) out[tool] = (out[tool] || 0) + 1;
    }
  }
  return out;
}
function verifyMark(targetDir, tic) {
  const ref = tic && tic.ref || "";
  // only path-like refs are git-checkable; skip area:/topic keys and bare tokens
  if (ref.indexOf("/") === -1 || ref.indexOf("area:") === 0) return "";
  try {
    const out = cp.execFileSync("git", ["-C", targetDir, "log", "-1", "--format=%cI", "--", ref],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    var c = Date.parse(out), t = Date.parse(tic.ts);
    if (c && t && c > t) return " ↻ verify (code changed since)";
  } catch (e) { /* not a repo / untracked path -> fail safe, no nudge */ }
  return "";
}
function landmarkMap(targetDir, all) {
  const t = loadFor(targetDir, all);
  const map = new Map();
  const TYPE = (x) => (x.kind === "contract" ? "decision" : (x.result || "landmark"));
  for (const x of t) {
    if ((x.kind !== "landmark" && x.kind !== "contract") || !x.ref) continue;
    if (x.kind === "landmark" && x.result === "retract") {
      for (const k of map.keys()) {
        if (k.indexOf(x.ref + " ") === 0 && k !== x.ref + " decision") map.delete(k);
      }
    } else {
      map.set(x.ref + " " + TYPE(x), x);
    }
  }
  return map;
}
function ticsWhere(targetDir, pathArg, all) {
  const map = landmarkMap(targetDir, all);
  const matches = [];
  for (const x of map.values()) {
    const ref = x.ref || "";
    if (ref === pathArg || pathArg.indexOf(ref) !== -1 || ref.indexOf(pathArg) !== -1) matches.push(x);
  }
  if (!matches.length) { return 0; }
  console.log("Context for " + pathArg + ":");
  for (const x of matches) console.log("  " + x.ref + " — " + x.msg + verifyMark(targetDir, x));
  return 0;
}
function ticsHow(targetDir, taskArg, all) {
  const map = landmarkMap(targetDir, all);
  const lower = (taskArg || "").toLowerCase();
  const matches = [];
  for (const x of map.values()) {
    if (x.result !== "route") continue;
    if ((x.ref + " " + x.msg).toLowerCase().indexOf(lower) !== -1) matches.push(x);
  }
  if (!matches.length) { console.log("no route for " + taskArg); return 0; }
  for (const x of matches) console.log("  " + x.ref + " — " + x.msg);
  return 0;
}
function ticsLandmarks(targetDir, all) {
  const map = landmarkMap(targetDir, all);
  if (!map.size) {
    console.log("No crumbs yet — leave one: tic.sh <role> '*' landmark '<what>' <path> <landmark|route|caveat>");
    return 0;
  }
  const groups = { landmark: [], route: [], caveat: [], decision: [] };
  for (const x of map.values()) {
    const type = x.kind === "contract" ? "decision" : ((x.result === "route" || x.result === "caveat") ? x.result : "landmark");
    groups[type].push(x);
  }
  for (const g of ["landmark", "route", "caveat", "decision"]) groups[g].sort(function(a, b) { return (a.ref || "") < (b.ref || "") ? -1 : 1; });
  console.log("Context map (learned crumbs — self-reported):");
  if (groups.landmark.length) {
    console.log("  Landmarks");
    for (const x of groups.landmark) console.log("    " + x.ref + " — " + x.msg + "  (" + x.from + ", " + (x.ts || "").slice(11, 19) + ")" + verifyMark(targetDir, x));
  }
  if (groups.route.length) {
    console.log("  Routes");
    for (const x of groups.route) console.log("    " + x.ref + " — " + x.msg + "  (" + x.from + ", " + (x.ts || "").slice(11, 19) + ")" + verifyMark(targetDir, x));
  }
  if (groups.caveat.length) {
    console.log("  Caveats");
    for (const x of groups.caveat) console.log("    " + x.ref + " — " + x.msg + "  (" + x.from + ", " + (x.ts || "").slice(11, 19) + ")" + verifyMark(targetDir, x));
  }
  if (groups.decision.length) {
    console.log("  Decisions");
    for (const x of groups.decision) console.log("    " + x.ref + " — " + x.msg);
  }
  return 0;
}
module.exports = { loadTics, loadSignalEvents, ticsLog, ticsInbox, ticsConductor, ticsClaims, ticsSections, ticsCycle, ticsGate, claimCheck, claimCheckCli, claimOwner, claimOwnerCli, claimSession, claimSessionCli, sectionStatus, sectionStatusCli, livenessTier, fleetModel, ticsBoard, ticsRoster, ticsReview, ticsAnswer, fanOut, greenAttestation, attestationTally, isHookSignedRed, cfgStr, evidenceFor, openNeeds, main, toolTally, ticsLandmarks, landmarkMap, ticsWhere, ticsHow };
