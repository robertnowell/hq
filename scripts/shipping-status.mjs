#!/usr/bin/env node
// Read-only Mac observer. Uploads private observations through its existing
// paired-device credential; it never updates a branch or installs an app.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, readFile, readdir, stat, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const exec = promisify(execFile);
const HOME_DIR = homedir();
const support = join(HOME_DIR, "Library/Application Support/VoiceDispatch");
const cacheDir = join(HOME_DIR, "Library/Application Support/hq/shipping");
async function command(file, args) {
  return (await exec(file, args, { timeout: 25_000, maxBuffer: 4_000_000,
    env: { ...process.env, LC_ALL: "C", GH_PROMPT_DISABLED: "1" } })).stdout.trim();
}
async function jsonFile(path) { return JSON.parse(await readFile(path, "utf8")); }
const shaOK = s => typeof s === "string" && /^[a-f0-9]{40}$/.test(s);

export function receiptMap(files, repo) {
  const map = new Map();
  for (const [session, contents] of files) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(session)) continue;
    for (const line of contents.split("\n")) {
      const parts = line.split("\t");
      if (!/^\d+$/.test(parts[0] ?? "")) continue;
      const m = parts[1]?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
      if (!m || m[1] !== repo) continue;
      const n = Number(m[2]);
      if (!map.has(n)) map.set(n, new Set());
      map.get(n).add(session);
    }
  }
  return map;
}

export function checkContexts(nodes) {
  return nodes.map(c => c.name ? { name: c.name, status: c.status, conclusion: c.conclusion ?? "" } : {
    name: c.context, status: ["PENDING", "EXPECTED"].includes(c.state) ? "IN_PROGRESS" : "COMPLETED",
    conclusion: c.state === "SUCCESS" ? "SUCCESS" : c.state === "ERROR" ? "FAILURE" : c.state,
  });
}

export function mergeQueue(p, request, now = Date.now()) {
  const labels = new Set((p.labels?.nodes ?? []).map(l => l.name));
  const admitted = labels.has("merge-queue"), native = !!p.autoMergeRequest;
  const mode = p.labels == null || p.labels.pageInfo?.hasNextPage ? "unknown" : admitted && native ? "competing" : admitted ? "kodiak" : native ? "github_auto_merge" : "none";
  const observed = Number(request?.queue_observed_at) * 1000;
  const fresh = request?.head_sha === p.headRefOid && request?.merge_mode === mode &&
    Number.isFinite(observed) && observed <= now + 5000 && now - observed <= 180_000 && !request?.queue_observation_error;
  let state = mode === "unknown" ? "unknown" : labels.has("queue-hold") ? "held" : p.mergeStateStatus === "DIRTY" ? "conflict" :
    p.mergeStateStatus === "UNKNOWN" ? "unknown" : mode === "competing" ? "competing" : admitted ? "queued" :
    native ? "native_auto_merge" : "not_admitted";
  if (fresh && !["held", "conflict", "unknown", "competing"].includes(state) &&
      ["handoff_blocked", "awaiting_readmission", "admission_removed"].includes(request.queue_state)) state = request.queue_state;
  const checks = p.commits?.nodes.at(-1)?.commit.statusCheckRollup?.contexts.nodes ?? [];
  const audit = checks.filter(c => c.name === "Source audit");
  let readySince = null;
  if (state === "native_auto_merge" && !p.isDraft && p.mergeStateStatus === "BEHIND" && audit.length &&
      audit.every(c => c.status === "COMPLETED" && c.conclusion === "SUCCESS")) {
    const times = [Date.parse(p.autoMergeRequest.enabledAt), ...audit.map(c => Date.parse(c.completedAt))];
    if (times.every(t => Number.isFinite(t) && t <= now)) readySince = new Date(Math.max(...times)).toISOString();
    else if (fresh && Number.isFinite(request.queue_ready_since)) readySince = new Date(request.queue_ready_since * 1000).toISOString();
  }
  return { mode, state, owner: request?.queue_owner ?? request?.request_owner ?? null,
    observedAt: new Date(now).toISOString(), readySince,
    attention: ["competing", "handoff_blocked", "awaiting_readmission", "admission_removed"].includes(state) ||
      (readySince !== null && now - Date.parse(readySince) >= 300_000) };
}

export async function runningApp() {
  // Bind the source stamp to a currently live installed process. Disk contents
  // alone are insufficient when another session replaces the bundle in place.
  const paths = ["/Applications/Tranquility Base Dev.app", "/Applications/Tranquility Base.app"];
  const lines = (await command("/bin/ps", ["-axo", "pid=,comm="])).split("\n");
  const matches = lines.flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    return m && paths.some(p => m[2] === `${p}/Contents/MacOS/TranquilityApp`) ? [m] : [];
  });
  if (matches.length !== 1) return null;
  const [, pid, executable] = matches[0];
  const bundle = executable.slice(0, -"/Contents/MacOS/TranquilityApp".length);
  const started = await command("/bin/ps", ["-p", pid, "-o", "lstart="]);
  const startedAt = Date.parse(started);
  const plist = `${bundle}/Contents/Info.plist`;
  const info = JSON.parse(await command("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist]));
  const files = await Promise.all([stat(executable), stat(plist)]);
  if (!Number.isFinite(startedAt) || files.some(f => f.mtimeMs > startedAt + 1000) || !shaOK(info.TBSourceCommit)) return null;
  if (await command("/bin/ps", ["-p", pid, "-o", "lstart="]) !== started) return null;
  return { sha: info.TBSourceCommit, build: String(info.CFBundleVersion), channel: info.TBAppChannel,
    relation: "unknown", behind: null };
}

/** Both installed bundles, from disk, whether or not they are running.
 *  The running process is still the only thing `runtime` binds to; this is
 *  the cheaper fact the work strip needs: which merges each channel holds. */
export async function installedApps() {
  const bundles = { dev: "/Applications/Tranquility Base Dev.app", prod: "/Applications/Tranquility Base.app" };
  const running = new Set((await command("/bin/ps", ["-axo", "comm="]).catch(() => "")).split("\n").map(l => l.trim()));
  const out = {};
  for (const [channel, bundle] of Object.entries(bundles)) {
    try {
      const info = JSON.parse(await command("/usr/bin/plutil", ["-convert", "json", "-o", "-", `${bundle}/Contents/Info.plist`]));
      if (!shaOK(info.TBSourceCommit)) continue;
      out[channel] = { sha: info.TBSourceCommit, build: String(info.CFBundleVersion), running: running.has(`${bundle}/Contents/MacOS/TranquilityApp`) };
    } catch { /* not installed */ }
  }
  return out;
}

/** The beads tracker beside the checkout, when there is one. Issues carry the
 *  pull requests they cite, which is the only join that exists today. */
/** The hands-free manager as this Mac last saw it serve a session (hf-27).
 *  Pipecat's own build id is opaque; the `ready` line the bot sends at the
 *  start of every session carries the commit deploy.sh stamped into it, so
 *  this is the build that actually answered, not the one somebody meant to
 *  deploy. Only for a checkout that holds the bot (tb-voice/server). `behind`
 *  counts commits to the bot's own directory on main that it does not have. */
export async function cloudServed(dir, run = command) {
  if (!dir) return null;
  try { await stat(join(dir, "tb-voice/server/bot.py")); } catch { return null; }
  for (const name of ["manager-events.jsonl", "manager-events.1.jsonl"]) {
    let text = "";
    try {
      const fh = await open(join(support, name), "r");
      try {
        const { size } = await fh.stat();
        const want = Math.min(size, 4 * 1024 * 1024);   // the tail: the newest ready is near the end
        const buf = Buffer.alloc(want);
        await fh.read(buf, 0, want, size - want);
        text = buf.toString("utf8");
      } finally { await fh.close(); }
    } catch { continue; }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"ready"')) continue;
      let e; try { e = JSON.parse(lines[i]); } catch { continue; }
      if (e.event !== "ready" || typeof e.build !== "string" || !/^[0-9a-f]{7,40}$/.test(e.build) || !Number.isFinite(e.t)) continue;
      let sha = null, behind = null;
      try { sha = (await run("git", ["-C", dir, "rev-parse", "--verify", `${e.build}^{commit}`])).trim(); } catch { /* not fetched here */ }
      if (sha) {
        try { behind = Number((await run("git", ["-C", dir, "rev-list", "--count", `${sha}..origin/main`, "--", "tb-voice/server"])).trim()); } catch { /* unknown */ }
      }
      return { name: "Hands-free manager", build: e.build.slice(0, 8), sha, behind: Number.isFinite(behind) ? behind : null,
               servedAt: new Date(e.t * 1000).toISOString() };
    }
  }
  return null;
}

export async function beadsIssues(dir) {
  if (!dir) return [];
  const bd = ["/usr/local/bin/bd", "/opt/homebrew/bin/bd", "bd"];
  let raw = null;
  for (const b of bd) {
    try { raw = await exec(b, ["list", "--all", "--json"], { cwd: dir, timeout: 25_000, maxBuffer: 8_000_000, env: { ...process.env, LC_ALL: "C" } }); break; }
    catch { /* next candidate */ }
  }
  if (!raw) return [];
  let rows; try { rows = JSON.parse(raw.stdout); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 300).map(i => ({
    id: String(i.id ?? ""), title: String(i.title ?? "").slice(0, 200), status: String(i.status ?? "open"),
    priority: Number.isInteger(i.priority) ? i.priority : null, type: String(i.issue_type ?? "task"),
    blocks: (Array.isArray(i.dependencies) ? i.dependencies : []).filter(d => d?.type === "blocks" && d.depends_on_id).map(d => String(d.depends_on_id)).slice(0, 10),
    // Only a close reason or a closing word ("Fixes #640") says a pull request
    // did this issue's work. A number mentioned in a description is context:
    // one issue cited a pull request as the screen it wanted copied, another
    // cited one as the ruling it superseded, and both were flagged "merged".
    prs: [...new Set([
      ...(String(i.close_reason ?? "").match(/(?:PR ?#|#)(\d{2,5})/g) ?? []),
      ...(String(i.description ?? "").match(/\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+(?:PR ?)?#(\d{2,5})/gi) ?? []),
    ].map(m => Number(m.replace(/\D/g, ""))))].slice(0, 10),
    updatedAt: i.updated_at ?? null, closedAt: i.closed_at ?? null,
  })).filter(i => i.id);
}

export const APP_REPO = "robertnowell/tranquility-base";

export async function collect(repo, run = command, beadsDir = null) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("invalid repository");
  const [owner, name] = repo.split("/");
  // Only the app's own repository has bundles on this Mac; every other
  // repository's strip stops at Merged.
  const isApp = repo === APP_REPO;
  let runtime = isApp ? await runningApp().catch(() => null) : null;
  const installed = isApp ? await installedApps().catch(() => ({})) : {};
  const fields = `number title state isDraft headRefOid headRefName mergeStateStatus updatedAt labels(first:100) { nodes { name } pageInfo { hasNextPage } } autoMergeRequest { enabledAt } mergeCommit { oid }
    commits(last:1) { nodes { commit { statusCheckRollup { contexts(first:60) { nodes {
      ... on CheckRun { name status conclusion completedAt } ... on StatusContext { context state }
    } } } } } }`;
  const query = `query($owner:String!,$name:String!,$runtime:String!,$dev:String!,$prod:String!,$rel:String!) { repository(owner:$owner,name:$name) {
    defaultBranchRef { target { oid } }
    latestRelease { tagName publishedAt tagCommit { oid } }
    pullRequests(first:60,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}) { totalCount nodes { ${fields} } }
    merged:pullRequests(first:20,states:MERGED,orderBy:{field:UPDATED_AT,direction:DESC}) { nodes { ${fields} } }
    object(expression:$runtime) { ... on Commit { history(first:100) { nodes { oid } } } }
    dev:object(expression:$dev) { ... on Commit { history(first:100) { nodes { oid } } } }
    prod:object(expression:$prod) { ... on Commit { history(first:100) { nodes { oid } } } }
    rel:object(expression:$rel) { ... on Commit { history(first:100) { nodes { oid } } } }
  } }`;
  const relTag = await run("gh", ["api", `repos/${repo}/releases/latest`, "--jq", ".tag_name"]).catch(() => "");
  const [graph, runs] = await Promise.all([
    run("gh", ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `runtime=${runtime?.sha ?? "HEAD"}`,
      "-f", `dev=${installed.dev?.sha ?? "HEAD"}`, "-f", `prod=${installed.prod?.sha ?? "HEAD"}`, "-f", `rel=${relTag || "HEAD"}`]).then(JSON.parse),
    isApp ? run("gh", ["api", `repos/${repo}/actions/workflows/release-every-merge.yml/runs?branch=main&per_page=5`]).then(JSON.parse).catch(() => ({ workflow_runs: [] })) : Promise.resolve({ workflow_runs: [] }),
  ]);
  if (graph.errors?.length || !graph.data?.repository?.defaultBranchRef) throw new Error("GitHub response incomplete");
  const g = graph.data.repository;
  const mainSha = g.defaultBranchRef.target.oid;
  if (runtime?.sha === mainSha) { runtime.relation = "current"; runtime.behind = 0; }
  else if (runtime) {
    try {
      const comparison = JSON.parse(await run("gh", ["api", `repos/${repo}/compare/${runtime.sha}...${mainSha}`]));
      runtime.relation = comparison.status === "ahead" ? "behind" : ["diverged", "behind"].includes(comparison.status) ? "preview" : "unknown";
      runtime.behind = runtime.relation === "behind" ? comparison.ahead_by : null;
    } catch { /* Explicitly unknown if the source relation cannot be checked. */ }
  }
  const receiptsDir = join(support, "pullrequests");
  const names = await readdir(receiptsDir).catch(() => []);
  const files = await Promise.all(names.map(async name => [name, await readFile(join(receiptsDir, name), "utf8").catch(() => "")]));
  const receipts = receiptMap(files, repo);
  if (runtime && isApp && (await runningApp().catch(() => null))?.sha !== runtime.sha) runtime = null;
  const ancestors = new Set(runtime ? g.object?.history?.nodes.map(n => n.oid) ?? [] : []);
  const hist = k => new Set(g[k]?.history?.nodes.map(n => n.oid) ?? []);
  const inDev = installed.dev ? hist("dev") : new Set(), inProd = installed.prod ? hist("prod") : new Set(), inRel = relTag ? hist("rel") : new Set();
  const issues = await beadsIssues(beadsDir).catch(() => []);
  // The join, Linear's rule: a pull request belongs to the issue whose id its
  // branch name or title carries, word-bounded ("hf-6-agent-loop", not
  // "hf-60"). An issue that cites a number in prose keeps that too. Seventeen
  // merged branches already carried an hf id on 28 Sep 2026 unprompted.
  const allPRs = [...g.pullRequests.nodes, ...g.merged.nodes];
  // Pull requests an issue names that fell outside the open and last-merged
  // windows: fetched by number, in one batch, so an issue whose branch merged
  // weeks ago still sits at its true stage.
  const loaded = new Set(allPRs.map(p => p.number));
  const carriesAny = (id, text) => new RegExp(`(^|[^A-Za-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`, "i").test(text);
  const wanted = new Set(issues.flatMap(i => i.prs).filter(n => !loaded.has(n)));
  if (wanted.size) {
    const nums = [...wanted].slice(0, 40);
    const q = `query($owner:String!,$name:String!) { repository(owner:$owner,name:$name) { ${nums.map(n => `pr${n}: pullRequest(number:${n}) { ${fields} }`).join("\n")} } }`;
    try {
      const extra = JSON.parse(await run("gh", ["api", "graphql", "-f", `query=${q}`, "-f", `owner=${owner}`, "-f", `name=${name}`]));
      for (const n of nums) { const p = extra.data?.repository?.[`pr${n}`]; if (p) { allPRs.push(p); loaded.add(n); } }
    } catch { /* the issue keeps its own status when the lookup fails */ }
  }
  const carries = (p, id) => new RegExp(`(^|[^A-Za-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`, "i").test(`${p.headRefName ?? ""} ${p.title ?? ""}`);
  const issuePRs = new Map(issues.map(i => [i.id, new Set(i.prs)]));
  const prIssues = new Map();
  for (const p of allPRs) for (const i of issues) if (carries(p, i.id)) { issuePRs.get(i.id).add(p.number); }
  for (const i of issues) { i.prs = [...issuePRs.get(i.id)].sort((a, b) => a - b).slice(0, 10); for (const n of i.prs) { if (!prIssues.has(n)) prIssues.set(n, []); prIssues.get(n).push(i.id); } }
  const preview = (await jsonFile(join(support, "deployment.json")).catch(() => null))?.preview;
  const worker = await jsonFile(join(support, "delivery-supervisor.json")).catch(() => null);
  const delivery = await jsonFile(join(support, "delivery.json")).catch(() => null);
  const cloud = await cloudServed(beadsDir, run).catch(() => null);
  const captureStamp = Number(await readFile(join(support, "capturing"), "utf8").catch(() => "NaN"));
  const captureAge = Date.now() / 1000 - captureStamp;
  return { repo, checkedAt: new Date().toISOString(), deviceName: "", sourceError: g.pullRequests.totalCount > 60 ? "PR list truncated" : null,
    mainSha, runtime, installed, issues, cloud, captureActive: captureStamp > 0 && captureAge >= 0 && captureAge < 20,
    release: g.latestRelease ? { tag: g.latestRelease.tagName, sha: g.latestRelease.tagCommit?.oid ?? null, publishedAt: g.latestRelease.publishedAt } : null,
    prs: allPRs.map(p => ({
      number: p.number, title: p.title, state: p.state, isDraft: p.isDraft, mergeStateStatus: p.mergeStateStatus,
      queue: mergeQueue(p, delivery?.requests?.[String(p.number)]),
      autoMerge: !!p.autoMergeRequest, sessions: [...(receipts.get(p.number) ?? [])],
      running: !!p.mergeCommit && ancestors.has(p.mergeCommit.oid),
      updatedAt: p.updatedAt ?? null, branch: p.headRefName ?? null, issues: (prIssues.get(p.number) ?? []).slice(0, 10),
      inDev: !!p.mergeCommit && inDev.has(p.mergeCommit.oid), inProd: !!p.mergeCommit && inProd.has(p.mergeCommit.oid),
      inRelease: !!p.mergeCommit && inRel.has(p.mergeCommit.oid),
      checks: checkContexts(p.commits.nodes.at(-1)?.commit.statusCheckRollup?.contexts.nodes ?? []),
    })),
    runs: runs.workflow_runs.slice(0, 5).map(r => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion ?? "", sha: r.head_sha })),
    preview: preview && Number.isFinite(preview.expires_at) ? { owner: preview.owner, expiresAt: new Date(preview.expires_at * 1000).toISOString() } : null,
    delivery: worker && Number.isFinite(worker.checked_at) ? { phase: worker.phase, checkedAt: new Date(worker.checked_at * 1000).toISOString(), targetSha: worker.target_sha ?? null, reason: worker.reason ?? null } : null,
  };
}

/** The repositories this Mac observes, each with the checkout that holds its
 *  beads tracker. `--repos=owner/name[=/path],...` overrides; `--repo=` keeps
 *  the old one-repository form. The defaults are this Mac's three trackers. */
export function repositoriesFrom(argv, home = HOME_DIR) {
  const one = argv.find(a => a.startsWith("--repo="))?.slice(7);
  const many = argv.find(a => a.startsWith("--repos="))?.slice(8);
  // Which repositories to report on: --repos=owner/name=dir,..., else
  // HQ_SHIPPING_REPOS in the same form, else the app alone.
  const fromEnv = process.env.HQ_SHIPPING_REPOS;
  const list = many ? many.split(",") : one ? [one] : fromEnv ? fromEnv.split(",") : [
    `${APP_REPO}=${join(home, "Projects/tranquility-base")}`,
  ];
  const beadsArg = argv.find(a => a.startsWith("--beads="))?.slice(8);
  return list.map(entry => {
    const [repo, dir] = entry.split("=");
    return { repo: repo.trim(), beadsDir: beadsArg ?? dir ?? join(home, "Projects", repo.split("/")[1]) };
  });
}

async function main() {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const lock = join(cacheDir, "observer.lock");
  try { await mkdir(lock); }
  catch {
    // launchd does not overlap a job; also protect manual invocations. A killed
    // observer's directory expires well beyond its bounded command budget.
    if (Date.now() - (await stat(lock)).mtimeMs < 300_000) return;
    await rm(lock, { recursive: true }); await mkdir(lock);
  }
  try {
    let failures = 0;
    for (const { repo, beadsDir: dir } of repositoriesFrom(process.argv)) {
      try {
        const beadsDir = await stat(join(dir, ".beads")).then(() => dir).catch(() => null);
        let snapshot;
        const cache = join(cacheDir, `${repo.replace("/", "--")}.json`);
        try { snapshot = await collect(repo, command, beadsDir); }
        catch {
          snapshot = await jsonFile(cache).catch(() => null);
          if (!snapshot) throw new Error("GitHub unavailable; no prior observation");
          snapshot.sourceError = "GitHub refresh failed"; // Retain the old checkedAt.
        }
        if (process.argv.includes("--print")) { console.log(JSON.stringify(snapshot, null, 2)); continue; }
        const config = await jsonFile(join(HOME_DIR, ".claude/hq.json"));
        const base = new URL(config.app.base_url);
        if (base.origin !== "https://hq.tranquilitybase.dev") throw new Error("unsupported hub origin");
        let token;
        try { token = await command("/usr/bin/security", ["find-generic-password", "-s", "voice-dispatch", "-a", "hub-token", "-w"]); }
        catch { token = (await readFile(join(HOME_DIR, "Library/Application Support/hq/token"), "utf8")).trim(); }
        if (!token?.startsWith("hq_")) throw new Error("paired hub credential unavailable");
        const response = await fetch(new URL("/api/shipping", base), { method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(snapshot) });
        if (!response.ok) throw new Error(`Hub refused observation (${response.status})`);
        await writeFile(`${cache}.tmp`, JSON.stringify(snapshot), { mode: 0o600 }); await rename(`${cache}.tmp`, cache);
        console.log(`${new Date().toISOString()} shipping status ${snapshot.sourceError ? "stale" : "updated"} for ${repo}`);
      } catch (e) {
        // One repository's failure never hides the others'; it is reported and the loop goes on.
        failures++; console.error(`${new Date().toISOString()} ${repo}: ${e.message}`);
      }
    }
    if (failures) process.exitCode = 1;
  } finally { await rm(lock, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
