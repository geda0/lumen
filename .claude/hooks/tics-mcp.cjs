/* eslint-disable -- generated kit (CommonJS Node) */
"use strict";

// tics MCP server (ADR 0014) — hand-rolled, zero-dependency stdio JSON-RPC 2.0.
// Built incrementally through the red→green gate (E13).

const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const TV = require(path.join(__dirname, "tics-view.cjs"));

function runReader(fn, args) {
  const oLog = console.log, oErr = console.error, oOut = process.stdout.write, oErrW = process.stderr.write;
  let text = "", err = "";
  console.log = function() { text += Array.prototype.slice.call(arguments).join(" ") + "\n"; };
  console.error = function() { err += Array.prototype.slice.call(arguments).join(" ") + "\n"; };
  process.stdout.write = function(s) { text += String(s); return true; };
  process.stderr.write = function(s) { err += String(s); return true; };
  let code = 0;
  try { code = fn.apply(null, args || []); } finally {
    console.log = oLog; console.error = oErr; process.stdout.write = oOut; process.stderr.write = oErrW;
  }
  return { text: text, err: err, code: code };
}

const SERVER_NAME = "tics";
const LATEST_PROTOCOL = "2025-11-25";
const SUPPORTED_PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

function resolveVersion() {
  const candidates = [
    path.join(__dirname, "..", "..", "package.json"),
    path.join(__dirname, "..", "package.json"),
    path.join(__dirname, "package.json"),
  ];
  let firstVersion;
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
      if (pkg.name === "@ttics/tics") return pkg.version;
      if (!firstVersion && pkg.version) firstVersion = pkg.version;
    } catch (_) { /* ignore */ }
  }
  return firstVersion || "0.0.0";
}

function resolveTargetDir(env) {
  return path.resolve((env || process.env).TICS_TARGET || process.cwd());
}

function makeCtx(overrides) {
  const defaults = {
    target: (overrides && overrides.target) || resolveTargetDir(),
    version: resolveVersion(),
    serverName: SERVER_NAME,
    latestProtocol: LATEST_PROTOCOL,
    supportedProtocols: SUPPORTED_PROTOCOLS,
    log: function() { process.stderr.write(Array.prototype.slice.call(arguments).join(" ") + "\n"); },
    emit: emit,
    runReader: runReader,
  };
  return Object.assign({}, defaults, overrides);
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id: id, result: result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: (id === undefined ? null : id), error: { code: code, message: message } };
}

const EMITTABLE_KINDS = ["delegate","handoff","stuck","verdict","msg","note","claim","release","contract","need","section","landmark"];

// Hook-only `from` identities: emitted by the run-suite/SubagentStop/guard/witness hooks (via emit_tic in
// tics-lib.sh), NEVER by an agent. Reserving them keeps GT-1's from=subagent delegation signal unforgeable.
const RESERVED_FROM = ["subagent", "run-suite", "guard", "witness"];

const TOOL_DESCRIPTORS = [
  {
    name: "tics_inbox",
    description: "Show pending tics addressed to a role.",
    inputSchema: {
      type: "object",
      properties: {
        role:  { type: "string" },
        scope: { type: "string" },
      },
      required: ["role"],
    },
  },
  {
    name: "tics_board",
    description: "Show the shared tics board (open needs, contracts, claims).",
    inputSchema: {
      type: "object",
      properties: {
        all: { type: "boolean" },
      },
      required: [],
    },
  },
  {
    name: "tics_review",
    description: "Show tics flagged for review (verdicts, blocks, signals).",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        all:   { type: "boolean" },
      },
      required: [],
    },
  },
  {
    name: "tics_log",
    description: "Show the full tics activity log.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        all:   { type: "boolean" },
      },
      required: [],
    },
  },
  {
    name: "tics_map",
    description: "Read the learned context map (landmark/route/caveat crumbs + ADR decisions). Optional: path -> crumbs for that path; task -> route recipes matching the task.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        task: { type: "string" },
        all:  { type: "boolean" },
      },
      required: [],
    },
  },
  {
    name: "tic_emit",
    description: "Emit a tic from one agent to another.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        from:    { type: "string" },
        to:      { type: "string" },
        kind:    { type: "string", enum: EMITTABLE_KINDS },
        msg:     { type: "string" },
        ref:     { type: "string" },
        result:  { type: "string" },
        session: { type: "string" },
      },
      required: ["from","to","kind","msg"],
    },
  },
  {
    name: "tics_answer",
    description: "Answer an open ask/need tic by handle.",
    inputSchema: {
      type: "object",
      properties: {
        handle: { type: "string" },
        text:   { type: "string" },
        from:   { type: "string" },
        all:    { type: "boolean" },
      },
      required: ["handle","text"],
    },
  },
];

function toolText(id, text) {
  return rpcResult(id, { content: [{ type: "text", text: String(text) }] });
}

function toolError(id, text) {
  return rpcResult(id, { content: [{ type: "text", text: String(text) }], isError: true });
}

function emit(targetDir, argv, env) {
  try {
    const out = cp.execFileSync(path.join(targetDir, ".claude", "hooks", "tic.sh"), argv, {
      cwd: targetDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: (env || process.env),
    });
    return { ok: true, stdout: out, stderr: "", status: 0 };
  } catch (e) {
    return { ok: false, status: (e && e.status), stderr: String((e && e.stderr) || (e && e.message) || "") };
  }
}

function callEmit(id, args, ctx) {
  // 1. Validate non-empty strings
  if (!args.from || typeof args.from !== "string" ||
      !args.to   || typeof args.to   !== "string" ||
      !args.kind || typeof args.kind !== "string" ||
      !args.msg  || typeof args.msg  !== "string") {
    return toolError(id, "tic_emit requires from,to,kind,msg");
  }
  // 2. Reject leading "-"
  if (args.from[0] === "-" || args.to[0] === "-") {
    return toolError(id, "from/to must not start with '-'");
  }
  // 2b. Hook-only identities can't be self-asserted by an agent (GT-1 provenance).
  if (RESERVED_FROM.indexOf(args.from) !== -1) {
    return toolError(id, "from '" + args.from + "' is a hook-only identity — agents cannot self-assert it (reserved for the run-suite/subagent/guard/witness hooks). Emit under your role name.");
  }
  // 3. Honesty check BEFORE any emit
  if (EMITTABLE_KINDS.indexOf(args.kind) === -1) {
    return toolError(id, "kind '" + args.kind + "' is not agent-emittable — signal/block/commit/session are hook-only and excluded (ADR 0014 §3)");
  }
  // 4. Build argv positionally
  const argv = [args.from, args.to, args.kind, args.msg];
  const ref = args.ref || "";
  const result = args.result || "";
  if (result !== "") {
    argv.push(ref);
    argv.push(result);
  } else if (ref !== "") {
    argv.push(ref);
  }
  // 5. Shell tic.sh
  var env = process.env;
  if (typeof args.session === "string" && args.session) {
    env = Object.assign({}, process.env, { TICS_SESSION: args.session });
  }
  const r = ctx.emit(ctx.target, argv, env);
  if (!r.ok) return toolError(id, "tic.sh failed: " + (r.stderr || r.status));
  return toolText(id, r.stdout || ("emitted " + args.kind));
}

function callInbox(id, args, ctx) {
  const role = args && args.role;
  if (typeof role !== "string" || !role) return toolError(id, "tics_inbox requires a string 'role'");
  try {
    const r = ctx.runReader(TV.ticsInbox, [ctx.target, role, (args.scope || null)]);
    return toolText(id, r.text);
  } catch (e) {
    ctx.log("tics_inbox failed:", String(e));
    return toolError(id, "tics_inbox failed: " + String((e && e.message) || e));
  }
}

function callBoard(id, args, ctx) {
  var all = (args.all === undefined) ? true : !!args.all;
  try {
    var r = ctx.runReader(TV.ticsBoard, [ctx.target, all]);
    return toolText(id, r.text);
  } catch(e) {
    ctx.log("tics_board failed:", String(e));
    return toolError(id, "tics_board failed: " + String(e && e.message || e));
  }
}

function callMap(id, args, ctx) {
  try {
    var all = args.all !== false;
    var r;
    if (args.path) r = ctx.runReader(TV.ticsWhere, [ctx.target, String(args.path), all]);
    else if (args.task) r = ctx.runReader(TV.ticsHow, [ctx.target, String(args.task), all]);
    else r = ctx.runReader(TV.ticsLandmarks, [ctx.target, all]);
    return toolText(id, r.text);
  } catch (e) {
    ctx.log("tics_map failed:", String(e));
    return toolError(id, "tics_map failed: " + String(e && e.message || e));
  }
}

function callReview(id, args, ctx) {
  var scope = args.scope || null;
  var all = (args.all === undefined) ? true : !!args.all;
  try {
    var r = ctx.runReader(TV.ticsReview, [ctx.target, scope, all]);
    return toolText(id, r.text);
  } catch(e) {
    ctx.log("tics_review failed:", String(e));
    return toolError(id, "tics_review failed: " + String(e && e.message || e));
  }
}

function callLog(id, args, ctx) {
  var scope = args.scope || null;
  var all = (args.all === undefined) ? true : !!args.all;
  try {
    var r = ctx.runReader(TV.ticsLog, [ctx.target, scope, all, false]);
    return toolText(id, r.text);
  } catch(e) {
    ctx.log("tics_log failed:", String(e));
    return toolError(id, "tics_log failed: " + String(e && e.message || e));
  }
}

function callAnswer(id, args, ctx) {
  var handle = args && args.handle;
  var text = args && args.text;
  if (typeof handle !== "string" || !handle) return toolError(id, "tics_answer requires a string 'handle'");
  if (typeof text !== "string" || !text) return toolError(id, "tics_answer requires a string 'text'");
  var from = (typeof args.from === "string" && args.from) ? args.from : null;
  var all = (args.all === undefined) ? true : !!args.all;
  try {
    var r = ctx.runReader(TV.ticsAnswer, [ctx.target, handle, text, from, all]);
    if (r.code !== 0) return toolError(id, r.err || r.text || ("tics_answer failed for handle '" + handle + "'"));
    return toolText(id, r.text);
  } catch(e) {
    ctx.log("tics_answer failed:", String(e));
    return toolError(id, "tics_answer failed: " + String(e && e.message || e));
  }
}

function handleToolsCall(id, params, ctx) {
  const name = params && params.name;
  if (typeof name !== "string" || !name) return rpcError(id, -32602, "tools/call requires a string 'name'");
  switch (name) {
    case "tics_inbox": return callInbox(id, params.arguments || {}, ctx);
    case "tics_board": return callBoard(id, params.arguments || {}, ctx);
    case "tics_map": return callMap(id, params.arguments || {}, ctx);
    case "tics_review": return callReview(id, params.arguments || {}, ctx);
    case "tics_log": return callLog(id, params.arguments || {}, ctx);
    case "tic_emit": return callEmit(id, params.arguments || {}, ctx);
    case "tics_answer": return callAnswer(id, params.arguments || {}, ctx);
    default: return rpcError(id, -32601, "Unknown tool: " + name);
  }
}

function handleToolsList(id, params, ctx) {
  return rpcResult(id, { tools: TOOL_DESCRIPTORS });
}

function handleInitialize(id, params, ctx) {
  const req = params && params.protocolVersion;
  const proto = ctx.supportedProtocols.indexOf(req) !== -1 ? req : ctx.latestProtocol;
  return rpcResult(id, {
    protocolVersion: proto,
    serverInfo: { name: ctx.serverName, version: ctx.version },
    capabilities: { tools: {} },
  });
}

function handleLine(line, ctx) {
  ctx = makeCtx(ctx);
  var req;
  try { req = JSON.parse(String(line).trim()); } catch(e) { return rpcError(null, -32700, "Parse error"); }
  return dispatch(req, ctx);
}

function dispatch(request, ctx) {
  ctx = makeCtx(ctx);
  if (request === null || typeof request !== "object" || request.jsonrpc !== "2.0") {
    return rpcError(request && request.id, -32600, "Invalid Request: jsonrpc must be '2.0'");
  }
  if (request.id === undefined) { ctx.log("notification:", request.method); return null; }
  const id = request && request.id;
  const method = request && request.method;
  switch (method) {
    case "initialize":
      return handleInitialize(id, request.params || {}, ctx);
    case "tools/list":
      return handleToolsList(id, request.params || {}, ctx);
    case "tools/call":
      return handleToolsCall(id, request.params || {}, ctx);
    default:
      return rpcError(id, -32601, "Method not found: " + method);
  }
}

function writeMcpServerEntry(file, target) {
  var json = { mcpServers: {} };
  if (fs.existsSync(file)) {
    try {
      json = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      // Never silently clobber a foreign/malformed file — back it up, then start clean.
      fs.copyFileSync(file, file + ".bak");
      json = { mcpServers: {} };
    }
  }
  if (!json.mcpServers || typeof json.mcpServers !== "object") json.mcpServers = {};
  json.mcpServers.tics = {
    type: "stdio",
    command: process.execPath,
    args: [ path.join(target, ".claude", "hooks", "tics-mcp.cjs"), target ]
  };
  var dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  return file;
}
function writeCursorMcp(target) {
  var dir = path.join(target, ".cursor");
  var file = path.join(dir, "mcp.json");
  return writeMcpServerEntry(file, target);
}
function writeProjectMcp(target) {
  var file = path.join(target, ".mcp.json");
  return writeMcpServerEntry(file, target);
}
function writeCursorRule(target) {
  var dir = path.join(target, ".cursor", "rules");
  var file = path.join(dir, "tics.mdc");
  var body =
    "---\n" +
    "alwaysApply: true\n" +
    "---\n" +
    "<!-- team-tactics: managed rule — refreshed by `ttics update`. Edit the method in AGENTS.md, not here. -->\n" +
    "\n" +
    "# tics — coordinate on the shared bus (Cursor)\n" +
    "\n" +
    "**The method lives in `AGENTS.md`** (then `docs/tdd/tdd-workflow.md` + `docs/tdd/tool-support.md`) — that is the canonical TDD\n" +
    "protocol (red->green->refactor, phase x layer scope, the roles). Read it. This rule only covers the bus and what\n" +
    "enforcement you do and do not get in Cursor.\n" +
    "\n" +
    "Each turn, coordinate on the shared tics bus via the MCP tools:\n" +
    "- Call `tics_inbox` (your role) and `tics_board` for what is addressed to you + fleet state; check `tics_review` and settle one open need with `tics_answer`.\n" +
    "- Contribute honestly with `tic_emit` (handoff/need/verdict/note/claim). You cannot emit signal/block/commit (hook-only kinds), and your contributions are classified **unrefereed** (self-reported), never hook-signed.\n" +
    "- Spawning sub-actors? Give EACH a distinct `session` and pass it on every `tic_emit` — otherwise they merge into one indistinguishable actor (`session=\"\"`). A self-set `session` is provenance, not authentication, just like `from`.\n" +
    "- **Context map (learned crumbs):** before exploring an area, call `tics_map` (optional `path` -> crumbs for that file, or `task` -> route recipes) for what earlier agents learned. Leave one when you learn something durable: `tic_emit` kind=`landmark`, ref=`<path or area>`, result=`landmark|route|caveat`, msg=`<what you learned>`. When you change a thing you have a crumb about, emit a FRESH crumb — newest-per-ref wins. Self-reported; trust accordingly. See `docs/tics/context-map.md`.\n" +
    "\n" +
    "**Enforcement is host-dependent — assume you are refereed.** The kit's `.claude/settings.json` hooks (the phase x layer\n" +
    "edit gate, the security-surface guard for auth/secret/CORS edits, green-bar signing, no-finish-on-red) fire only if your\n" +
    "host runs them on its edit/stop events. Whether Cursor does is **host-dependent**: one Cursor configuration was observed\n" +
    "running them (2026-07-07), but that is a single observation, not a guarantee for your version — so **assume refereed and\n" +
    "self-enforce** per the checklist in `docs/tdd/tool-support.md`. Probe it mechanically: after an edit, read the bus\n" +
    "(`.claude/hooks/tics log`); a **hook-signed** tic from `run-suite` (`signal`) or `guard` (`block`) naming your file proves\n" +
    "the hooks fired for your tool (those `from` identities are unforgeable). No such tic means **self-reported** only, which\n" +
    "proves nothing either way (the hooks are silent when they allow) — so self-enforce regardless. If a hook blocks you,\n" +
    "comply; never flip `.claude/state/phase` merely to unblock an edit — it declares what you are doing, not a permission slip.\n" +
    "The one gate you can guarantee under any tool: run **`npx tics install-hooks`** once — git hooks (pre-commit green-bar +\n" +
    "pre-push release gate) that fire regardless of host.\n";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

function mcpInstall(target) {
  target = path.resolve(target || process.cwd());
  writeCursorMcp(target);
  writeProjectMcp(target);
  writeCursorRule(target);
  console.log("tics MCP installed: .cursor/mcp.json (server entry) + .cursor/rules/tics.mdc (always-apply nudge) + .mcp.json (Claude Code project entry).");
  console.log("NOTE: the server is INERT until you enable it and approve its tools in Cursor Settings -> Tools & MCP.");
  console.log("NOTE: the tics server in .mcp.json must also be approved in Claude Code on next launch before it becomes active.");
  return 0;
}

function serve(ctx) {
  ctx = makeCtx(ctx);
  return new Promise(function (resolve) {
    var buf = "";
    function flushLine(line) {
      if (line.trim() === "") return;
      var resp = handleLine(line, ctx);
      if (resp !== null && resp !== undefined) process.stdout.write(JSON.stringify(resp) + "\n");
    }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", function (chunk) {
      buf += chunk;
      var idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        var line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        flushLine(line);
      }
    });
    process.stdin.on("end", function () { flushLine(buf); buf = ""; resolve(); });
  });
}
function start() { return serve(makeCtx()); }

module.exports = { dispatch, handleLine, makeCtx, resolveVersion, resolveTargetDir, TOOL_DESCRIPTORS, EMITTABLE_KINDS, handleToolsCall, callEmit, callInbox, callBoard, callMap, callReview, callLog, callAnswer, emit, runReader, toolText, toolError, serve, start, writeMcpServerEntry, writeCursorMcp, writeProjectMcp, writeCursorRule, mcpInstall };

if (require.main === module) { serve(makeCtx({ target: process.argv[2] ? path.resolve(process.argv[2]) : undefined })); }
