// RETIRED 12 Sep 2026. The Tranquility Base panel mirrors pages and turns to
// the hub itself now (tranquility-base HubMirror, #364); the three hook entries
// that ran this script are gone from ~/.claude/settings.json and hq-hook.sh is
// deleted. This file stays as the written spec of the routes and shapes, and as
// a hand tool (`node scripts/upload.mjs --all`) for a one-off backfill from a
// machine that has Node. Nothing runs it on its own.
#!/usr/bin/env node
// The mirror: push what the laptop has that the app does not.
//
// One path, run repeatedly. There is no separate backfill: `--all` is this
// same walk with the local memory of what was sent thrown away, and the
// server is idempotent on content hash (documents) and source key (turns),
// so resending is always safe and never duplicates.
//
// Triggered by a hook (a document was written, a turn ended, a prompt was
// sent) rather than by a timer, because a launchd job cannot read
// ~/Documents on this machine -- TCC refuses it -- and a hook runs inside
// the session that has that access. The hook only spawns this and exits;
// this does the work, holds a lock so two hooks cannot drain at once, and
// reports on itself with a heartbeat so a failure is never a quiet stop.
//
//   HQ_URL      where to post               (default http://127.0.0.1:3111)
//   HQ_TOKEN    the device token, else read from ~/Library/Application Support/hq/token
//   HQ_ROOT     the archive                  (default ~/Documents/agents)
//   HQ_DEVICE   this machine's name          (default the hostname)
//   --all       forget what was sent and offer everything again
//   --docs / --turns   only one half
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync,
         mkdirSync, rmSync, appendFileSync } from "fs";
import { createHash } from "crypto";
import { join, basename } from "path";
import { hostname } from "os";
import { spawnSync } from "child_process";

const HOME = process.env.HOME;
const HQ_DIR = join(HOME, "Library/Application Support/hq");
// Where the app is. One file on the laptop, so the deploy is a one-line
// change here and nothing in the hooks moves.
// The hub's address, from the one place every door and footer reads it:
// ~/.claude/hq.json app.base_url. HQ_URL in the environment still wins for a
// one-off run; the old url file is read for one more release and named in
// the log, so a machine still carrying it can lose it. (11 Sep: the file
// said the vercel.app host while everything else said the domain.)
const hqJson = (() => { try { return JSON.parse(readFileSync(join(HOME, ".claude/hq.json"), "utf8")); } catch { return {}; } })();
const configured = ((hqJson.app || {}).base_url || "").trim().replace(/\/+$/, "");
const legacyUrlFile = join(HQ_DIR, "url");
const legacyUrl = existsSync(legacyUrlFile) ? readFileSync(legacyUrlFile, "utf8").trim() : null;
const URL_ = process.env.HQ_URL
  ?? (/^https?:\/\//.test(configured) ? configured : null)
  ?? legacyUrl
  ?? "http://127.0.0.1:3111";
const URL_SOURCE = process.env.HQ_URL ? "HQ_URL" : /^https?:\/\//.test(configured) ? "hq.json app.base_url"
  : legacyUrl ? `the url file (retire it: rm "${legacyUrlFile}")` : "the default";
const ROOT = process.env.HQ_ROOT ?? join(HOME, "Documents/agents");
const DEVICE = process.env.HQ_DEVICE ?? hostname().replace(/\.local$/, "");
const STATE = join(HQ_DIR, "state.json");
const LOCK = join(HQ_DIR, "lock");
const LOG = join(HQ_DIR, "upload.log");
const RECORDS = join(HOME, "Library/Application Support/VoiceDispatch/artifacts");
const SQLITE = join(HOME, "Library/Application Support/VoiceDispatch/queue.sqlite");
const args = new Set(process.argv.slice(2));
const ALL = args.has("--all");
const DO_DOCS = !args.has("--turns"), DO_TURNS = !args.has("--docs");

mkdirSync(HQ_DIR, { recursive: true });
const log = (s) => { const line = `${new Date().toISOString()} ${s}`; console.log(line); try { appendFileSync(LOG, line + "\n"); } catch {} };

log(`app: ${URL_} (from ${URL_SOURCE})`);
const TOKEN = process.env.HQ_TOKEN
  ?? (existsSync(join(HQ_DIR, "token")) ? readFileSync(join(HQ_DIR, "token"), "utf8").trim() : null);
if (!TOKEN) { log("no device token: set HQ_TOKEN or write ~/Library/Application Support/hq/token"); process.exit(2); }

// One drainer at a time. A stale lock (its owner is gone) is taken over.
try {
  mkdirSync(LOCK);
} catch {
  try {
    const pid = Number(readFileSync(join(LOCK, "pid"), "utf8"));
    try { process.kill(pid, 0); log(`another drain is running (pid ${pid})`); process.exit(0); }
    catch { rmSync(LOCK, { recursive: true, force: true }); mkdirSync(LOCK); }
  } catch { rmSync(LOCK, { recursive: true, force: true }); mkdirSync(LOCK); }
}
writeFileSync(join(LOCK, "pid"), String(process.pid));
process.on("exit", () => { try { rmSync(LOCK, { recursive: true, force: true }); } catch {} });

const state = (() => {
  if (ALL || !existsSync(STATE)) return { files: {}, sent: [], turnCursor: 0 };
  try { return { files: {}, sent: [], turnCursor: 0, ...JSON.parse(readFileSync(STATE, "utf8")) }; }
  catch { return { files: {}, sent: [], turnCursor: 0 }; }
})();
const sent = new Set(state.sent);
const save = () => writeFileSync(STATE, JSON.stringify({ ...state, sent: [...sent] }));

const post = async (path, body) => {
  const r = await fetch(`${URL_}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  let json = null; try { json = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, json };
};

let failed = 0, sentDocs = 0, sentTurns = 0, skipped = 0, guardFailed = 0, guardRan = 0;

// ------------------------------------------------------------- documents
if (DO_DOCS) {
  // When a document was WRITTEN, from the panel's own record of first
  // writes. mtime is when it was last touched, which put 486 of 870 documents
  // under the wrong turn; birthtime is the floor when there is no record.
  const firstWrites = new Map();
  try {
    for (const f of readdirSync(RECORDS)) {
      for (const line of readFileSync(join(RECORDS, f), "utf8").split("\n")) {
        const tab = line.indexOf("\t"); if (tab < 1) continue;
        const ms = Number(line.slice(0, tab)), p = line.slice(tab + 1).trim();
        if (!Number.isFinite(ms) || ms <= 0 || !p) continue;
        const prev = firstWrites.get(p); if (prev === undefined || ms < prev) firstWrites.set(p, ms);
      }
    }
  } catch {}
  const producedAt = (full, dir, st) => {
    const short = join(ROOT, basename(dir).slice(0, 8), full.slice(dir.length + 1));
    const ms = firstWrites.get(full) ?? firstWrites.get(short);
    return new Date(ms ?? Math.min(st.birthtimeMs || Infinity, st.mtimeMs)).toISOString();
  };

  const SESSION = /^[0-9a-f]{8}(-[0-9a-f-]+)?$/i;
  const walk = (dir, depth, out) => {
    if (depth > 2) return out;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p, depth + 1, out);
      else if (e.name.endsWith(".html")) out.push(p);
    }
    return out;
  };
  const metaOf = (h, name) => {
    const head = h.slice(0, 16384);
    const m = head.match(new RegExp(`<meta\\s+name="intranet:${name}"\\s+content="([^"]*)"`, "i"))
           || head.match(new RegExp(`<meta\\s+content="([^"]*)"\\s+name="intranet:${name}"`, "i"));
    const v = m ? m[1].trim() : "";
    return v && /^https?:\/\//.test(v) ? v : null;
  };
  const titleOf = (h, f) => {
    const m = h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const s = m && m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    return s && s.length > 2 && s.length < 200 ? s : f;
  };

  // The guard on the write path. A page carrying inline base64 images is
  // rewritten BEFORE it leaves the laptop: the images go to the media bucket
  // and the page keeps URLs, using the same tool and the same bucket the
  // 7 Sep migration used. The corpus was cleaned that day and the tap left
  // open; this closes it where a page is written into the app, once per
  // agent directory per run, and says so if it could not.
  const INLINE = /data:image\/(png|jpe?g|gif|webp);base64,/i;
  // A file beside the page is as invisible to the app as a data: URI is
  // heavy for the archive: the mirror ships only the html. The same guard
  // moves it to the media bucket and points the page at it (11 Sep).
  const RELATIVE = /<(?:img|source|video)\b[^>]*?\s(?:src|poster)="(?!https?:|data:|\/|#)[^"?#]+?\.(?:png|jpe?g|gif|webp|avif)"/i;
  const EXTRACT = join(HOME, ".claude/skills/research-hq/scripts/extract-media.py");
  const guarded = new Set();
  guardFailed = 0; guardRan = 0;
  const guard = (dir) => {
    if (guarded.has(dir) || !existsSync(EXTRACT)) return;
    guarded.add(dir);
    // Three steps, the same three the 7 Sep migration ran by hand: stage the
    // images out of the pages, copy them to the bucket, then rewrite the
    // pages -- and the rewrite verifies every object at the origin first, so
    // a page is never left pointing at bytes that are not there.
    const staging = join(HQ_DIR, "media-staging");
    const env = { ...process.env, PATH: `${HOME}/google-cloud-sdk/bin:${process.env.PATH ?? ""}` };
    const step = (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 240000, env });
      return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
    };
    let cfg = {};
    try { cfg = JSON.parse(readFileSync(join(HOME, ".claude/hq.json"), "utf8")).assets ?? {}; } catch {}
    if (!cfg.bucket) { guardFailed++; log("guard: hq.json has no assets.bucket"); return; }
    const s1 = step("python3", [EXTRACT, "--root", dir, "--staging", staging, "--stage"]);
    if (!s1.ok) { guardFailed++; log(`guard: stage failed for ${basename(dir)}: ${s1.out.split("\n").pop()}`); return; }
    let objects = [];
    try { objects = readdirSync(staging).filter((f) => f !== "manifest.json").map((f) => join(staging, f)); } catch {}
    if (!objects.length) { guarded.delete(dir); return; }   // nothing inline after all
    const account = cfg.account ? ["--account", cfg.account] : [];
    const s2 = step("gcloud", ["storage", "cp", "-n", ...account, ...objects, `gs://${cfg.bucket}/${cfg.prefix ?? "media"}/`]);
    if (!s2.ok) { guardFailed++; log(`guard: upload failed for ${basename(dir)}: ${s2.out.split("\n").pop()}`); return; }
    const s3 = step("python3", [EXTRACT, "--root", dir, "--staging", staging, "--rewrite"]);
    if (!s3.ok) { guardFailed++; log(`guard: rewrite failed for ${basename(dir)}: ${s3.out.split("\n").pop()}`); return; }
    guardRan++;
    log(`guard: ${basename(dir)}: ${s3.out.split("\n").find((l) => l.startsWith("rewrote")) ?? "rewrote"}`);
    try { rmSync(staging, { recursive: true, force: true }); } catch {}
  };

  // Pass 1: what is on disk, hashed only when size or mtime moved.
  const candidates = [];
  const files = {};
  for (const d of readdirSync(ROOT, { withFileTypes: true })) {
    if (d.isSymbolicLink() || !d.isDirectory() || !SESSION.test(d.name) || d.name.length < 36) continue;
    const base = join(ROOT, d.name);
    let list; try { list = walk(base, 0, []).filter((f) => f !== join(base, "index.html")); } catch { continue; }
    for (const f of list) {
      let st; try { st = statSync(f); } catch { continue; }
      // Peek before trusting the cache: a page that gained an inline image
      // has a new size and mtime, so the cache misses and we look. A page
      // with images BESIDE it is small, so the size gate applies only to
      // the inline case; the cache miss is the gate for both.
      const cached = state.files[f] && state.files[f].size === st.size && state.files[f].mtimeMs === st.mtimeMs;
      if (!cached) {
        let peek = ""; try { peek = readFileSync(f, "utf8"); } catch {}
        if ((st.size > 65536 && INLINE.test(peek)) || RELATIVE.test(peek)) { guard(base); try { st = statSync(f); } catch { continue; } }
      }
      const prev = state.files[f];
      let hash = prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs ? prev.hash : null;
      let html = null;
      if (!hash) {
        try { html = readFileSync(f, "utf8"); } catch { continue; }
        if (html.includes("research-hq-generated: index")) continue;
        hash = createHash("sha256").update(html).digest("hex");
      }
      files[f] = { size: st.size, mtimeMs: st.mtimeMs, hash };
      if (sent.has(hash)) { skipped++; continue; }
      candidates.push({ f, base, session: d.name, hash, html, st });
    }
  }
  state.files = files;

  // Pass 2: ask once which of these the app already holds, so a first run
  // does not re-upload the archive to discover it is already there.
  for (let i = 0; i < candidates.length; i += 2000) {
    const chunk = candidates.slice(i, i + 2000);
    const r = await post("/api/ingest/known", { hashes: chunk.map((c) => c.hash) });
    if (!r.ok) { log(`known: HTTP ${r.status}`); failed++; break; }
    for (const h of r.json?.known ?? []) sent.add(h);
  }

  // Pass 3: send what is left, oldest first so arrival order is honest.
  const todo = candidates.filter((c) => !sent.has(c.hash))
    .sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);
  for (const c of todo) {
    const html = c.html ?? readFileSync(c.f, "utf8");
    const slug = c.f.slice(c.base.length + 1).replace(/\.html$/, "").replace(/\//g, "-");
    try {
      const r = await post("/api/ingest", {
        session_id: c.session, slug, title: titleOf(html, slug), html,
        produced_at: producedAt(c.f, c.base, c.st), device: DEVICE,
        // A page that was also published carries its live address in the
        // archive's own tag (intranet:url, what the catalog and the local hub
        // read), so the app can say "published" beside it too.
        published_url: metaOf(html, "url"),
      });
      if (!r.ok) { failed++; log(`  ${r.status} ${slug} ${JSON.stringify(r.json ?? "").slice(0, 120)}`); continue; }
      sent.add(c.hash); sentDocs++;
    } catch (e) { failed++; log(`  ${e.message} ${slug}`); }
  }
  save();
  log(`documents: sent ${sentDocs}, already known ${skipped + (candidates.length - todo.length)}, failed ${failed}` +
      (guardRan || guardFailed ? `; image guard ran ${guardRan}, failed ${guardFailed}` : ""));
}

// ----------------------------------------------------------------- names
// WHAT THE PANEL'S GRID CALLS A SESSION, by the panel's own rule and from the
// panel's own sources, so the app and the grid cannot disagree (Robert, 10 Sep:
// the grid and the app named the same session two different things).
// tranquility-base resolves every displayed name through
// GridAssembler.tabDisplayName -> SessionRow.displayName:
//   1. the harness's own name: Claude Code's tab title, which is the LAST
//      "ai-title" record in the transcript (TranscriptTitles), else Codex's
//      thread name (the panel's persisted map, codex-thread-names.json);
//   2. the callsign;
//   3. the last path component of the working directory.
// The "New agent" placeholder topic is not a name and never was.
const CODEX_NAMES = join(HOME, "Library/Application Support/VoiceDispatch/codex-thread-names.json");
const codexNames = (() => { try { return JSON.parse(readFileSync(CODEX_NAMES, "utf8")); } catch { return {}; } })();
const MARK = '"type":"ai-title"';
const lastAiTitle = (path) => {
  if (!path || !existsSync(path)) return null;
  const scan = (text) => {
    let at = text.lastIndexOf(MARK);
    while (at >= 0) {
      const from = text.lastIndexOf("\n", at) + 1, to = text.indexOf("\n", at);
      try { const t = JSON.parse(text.slice(from, to < 0 ? undefined : to)).aiTitle; if (t) return t; } catch {}
      at = text.lastIndexOf(MARK, at - 1);
    }
    return null;
  };
  try {
    const size = statSync(path).size;
    // The last title sits within the tail in practice (the panel measured 40
    // of 40 within 30 KB); the whole file only when the tail has none.
    if (size > 65536) {
      const fd = openSync(path, "r"); const buf = Buffer.alloc(65536);
      readSync(fd, buf, 0, 65536, size - 65536); closeSync(fd);
      const hit = scan(buf.toString("utf8")); if (hit) return hit;
    }
    return scan(readFileSync(path, "utf8"));
  } catch { return null; }
};
const transcriptFor = (session, cwd, known) => {
  if (known && existsSync(known)) return known;
  if (cwd) {
    const p = join(HOME, ".claude/projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${session}.jsonl`);
    if (existsSync(p)) return p;
  }
  try {
    for (const d of readdirSync(join(HOME, ".claude/projects"))) {
      const p = join(HOME, ".claude/projects", d, `${session}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch {}
  return null;
};
const gridName = ({ session, cwd, transcriptPath, callsign }) =>
  lastAiTitle(transcriptFor(session, cwd, transcriptPath))
  || codexNames[session.toLowerCase()]
  || (callsign || null)
  || (cwd ? cwd.split("/").filter(Boolean).pop() : null)
  || null;

// ----------------------------------------------------------------- turns
if (DO_TURNS) {
  let db = null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(`file:${SQLITE}?mode=ro`, { open: true });
  } catch (e) { log(`turns: no brief store readable (${e.message.split("\n")[0]})`); }
  if (db) {
    const cursor = ALL ? 0 : (state.turnCursor ?? 0);
    const rows = db.prepare(`
      select b.eventRowid, b.sessionId, b.atMs, b.topic, b.happened, b.nextStep, b.question,
             b.risk, b.headline, b.deck, b.findings, b.solution, b.rationale, b.branch,
             coalesce(c.callsign, b.callsign) as callsign,
             (select cwd from latest_per_session l where l.sessionId = b.sessionId) as cwd,
             (select transcriptPath from latest_per_session l where l.sessionId = b.sessionId) as transcriptPath
        from brief b left join session_callsign c on c.sessionId = b.sessionId
       where b.eventRowid > ? order by b.eventRowid asc`).all(cursor);
    let last = cursor;
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      const turns = chunk.map((b) => ({
        session_id: b.sessionId, source_key: `${b.sessionId}:${b.eventRowid}`,
        at: new Date(b.atMs).toISOString(), topic: b.topic ?? "",
        headline: b.headline || null, deck: b.deck || null, happened: b.happened || null,
        findings: b.findings || null, solution: b.solution || null, rationale: b.rationale || null,
        next_step: b.nextStep || null, question: b.question || null, risk: b.risk || null,
        branch: b.branch || null,
        agent_title: gridName({ session: b.sessionId, cwd: b.cwd, transcriptPath: b.transcriptPath, callsign: b.callsign }),
        cwd: b.cwd || null,
      }));
      try {
        const r = await post("/api/ingest/turns", { turns, device: DEVICE });
        if (!r.ok) { failed++; log(`turns: HTTP ${r.status} ${JSON.stringify(r.json ?? "").slice(0, 120)}`); break; }
        sentTurns += turns.length; last = chunk[chunk.length - 1].eventRowid;
        state.turnCursor = last; save();
      } catch (e) { failed++; log(`turns: ${e.message}`); break; }
    }
    log(`turns: sent ${sentTurns} (cursor ${cursor} -> ${last})`);

    // Names are derived, never stored, and they change as the transcript
    // does (Claude Code re-mints the title as the conversation moves). So
    // every run re-resolves every session the panel knows and sends the
    // ones that differ from what was sent last time.
    try {
      const known = db.prepare(`
        select l.sessionId, l.cwd, l.transcriptPath, c.callsign
          from latest_per_session l left join session_callsign c on c.sessionId = l.sessionId`).all();
      const names = state.names ?? {};
      const changed = [];
      for (const k of known) {
        const title = gridName({ session: k.sessionId, cwd: k.cwd, transcriptPath: k.transcriptPath, callsign: k.callsign });
        if (title && names[k.sessionId] !== title) changed.push({ session_id: k.sessionId, title });
      }
      let renamed = 0;
      for (let i = 0; i < changed.length; i += 200) {
        const chunk = changed.slice(i, i + 200);
        const r = await post("/api/ingest/names", { names: chunk, device: DEVICE });
        if (!r.ok) { failed++; log(`names: HTTP ${r.status} ${JSON.stringify(r.json ?? "").slice(0, 120)}`); break; }
        for (const n of chunk) names[n.session_id] = n.title;
        renamed += r.json?.renamed ?? 0;
      }
      state.names = names; save();
      log(`names: ${known.length} known, ${changed.length} changed, ${renamed} renamed in the app`);
    } catch (e) { failed++; log(`names: ${e.message}`); }
  }
}

// The dead-man's switch. Silence is what gets monitored; a failure is
// stated, not implied.
try {
  await post("/api/heartbeat", { device: DEVICE,
    note: failed ? `${failed} failed`
        : guardFailed ? `ok, but the image guard failed on ${guardFailed} director${guardFailed === 1 ? "y" : "ies"}`
        : `ok: ${sentDocs} documents, ${sentTurns} turns` });
} catch (e) { log(`heartbeat: ${e.message}`); }
process.exit(failed ? 1 : 0);
