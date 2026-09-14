#!/usr/bin/env node
// Collects per-task token usage and timing from Claude Code transcripts.
//
// One row per *task segment*:
//   - subagent runs: the initial prompt, and every later coordinator message
//     (`origin.kind === "coordinator"`) starts a new segment of the same agent;
//   - the coordinator (main session): every genuine user prompt starts a segment.
//
// Usage is read from assistant entries' `message.usage`, de-duplicated by
// `requestId` (one API request can span several transcript entries that all
// repeat the same usage; the entry with the highest output_tokens wins).
//
//   node .brain/usage/collect-task-usage.mjs \
//     --session-dir <~/.claude/projects/<project>/<sessionId>> \
//     --main <~/.claude/projects/<project>/<sessionId>.jsonl> \
//     --labels .brain/usage/task-labels.json \
//     --out .brain/usage
//
// Writes <out>/task-usage.jsonl (machine) and <out>/TASK-USAGE.md (human).
// Node built-ins only. Reads transcripts; never writes them.
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const sessionDir = arg("session-dir");
const mainFile = arg("main");
const labelsFile = arg("labels");
const outDir = arg("out", ".brain/usage");
const tz = arg("tz", "+07:00");
if (!sessionDir || !mainFile) {
  console.error("required: --session-dir <dir> --main <file.jsonl>");
  process.exit(2);
}

const labels = labelsFile && existsSync(labelsFile) ? JSON.parse(readFileSync(labelsFile, "utf8")) : { agents: {}, coordinator: {} };

function readJsonl(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function textOf(entry) {
  const c = entry.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b) => b.type === "text").map((b) => b.text).join(" ");
  return "";
}

function hasToolResult(entry) {
  const c = entry.message?.content;
  return Array.isArray(c) && c.some((b) => b.type === "tool_result");
}

// Shift an ISO UTC timestamp into a fixed offset like +07:00, keeping ISO form.
function toOffset(iso, offset) {
  if (!iso) return null;
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  const sign = m[1] === "-" ? -1 : 1;
  const mins = sign * (Number(m[2]) * 60 + Number(m[3]));
  const d = new Date(Date.parse(iso) + mins * 60000);
  return d.toISOString().replace("Z", offset).replace(/\.\d{3}/, "");
}

function summarise(entries, startIdx, endIdx) {
  const byRequest = new Map();
  let start = null;
  let end = null;
  for (let i = startIdx; i < endIdx; i++) {
    const e = entries[i];
    if (e.timestamp) {
      if (!start) start = e.timestamp;
      end = e.timestamp;
    }
    if (e.type !== "assistant" || !e.message?.usage) continue;
    const key = e.requestId || e.uuid;
    const prev = byRequest.get(key);
    if (!prev || (e.message.usage.output_tokens ?? 0) >= (prev.output_tokens ?? 0)) byRequest.set(key, e.message.usage);
  }
  const sum = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
  for (const u of byRequest.values()) {
    for (const k of Object.keys(sum)) sum[k] += Number(u[k] ?? 0);
  }
  const input_total = sum.input_tokens + sum.cache_creation_input_tokens + sum.cache_read_input_tokens;
  const durationS = start && end ? Math.round((Date.parse(end) - Date.parse(start)) / 1000) : null;
  return { start, end, durationS, requests: byRequest.size, ...sum, input_total };
}

const rows = [];

// ---- subagents
const subDir = path.join(sessionDir, "subagents");
for (const name of existsSync(subDir) ? readdirSync(subDir).filter((f) => f.endsWith(".jsonl")).sort() : []) {
  const agentId = name.replace(/^agent-/, "").replace(/\.jsonl$/, "");
  const metaPath = path.join(subDir, `agent-${agentId}.meta.json`);
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};
  const entries = readJsonl(path.join(subDir, name));
  const bounds = [];
  entries.forEach((e, i) => {
    if (e.type !== "user" || e.sourceToolAssistantUUID || hasToolResult(e)) return;
    const coordinator = e.origin?.kind === "coordinator";
    if (bounds.length === 0 || coordinator) bounds.push({ index: i, prompt: textOf(e) });
  });
  bounds.forEach((b, s) => {
    const next = s + 1 < bounds.length ? bounds[s + 1].index : entries.length;
    const u = summarise(entries, b.index, next);
    const label = labels.agents?.[agentId]?.segments?.[String(s + 1)] ?? {};
    rows.push({
      kind: "subagent",
      actor: labels.agents?.[agentId]?.actor ?? meta.agentType ?? "agent",
      agent_id: agentId,
      segment: s + 1,
      task_ids: label.task_ids ?? [],
      label: label.label ?? b.prompt.replace(/^The coordinator sent a message while you were working:\s*/, "").replace(/\s+/g, " ").slice(0, 90),
      status: label.status ?? null,
      ...u,
    });
  });
}

// ---- coordinator (main session): segment on genuine user prompts
const main = readJsonl(mainFile);
const isGenuinePrompt = (e) => {
  if (e.type !== "user" || e.sourceToolAssistantUUID || e.isMeta || hasToolResult(e)) return false;
  const t = textOf(e).trim();
  if (!t) return false;
  if (t.startsWith("<task-notification>") || t.startsWith("<system-reminder>")) return false;
  if (/^\[SYSTEM NOTIFICATION/.test(t)) return false;
  return true;
};
const mainBounds = [];
main.forEach((e, i) => {
  if (isGenuinePrompt(e)) mainBounds.push({ index: i, prompt: textOf(e) });
});
mainBounds.forEach((b, s) => {
  const next = s + 1 < mainBounds.length ? mainBounds[s + 1].index : main.length;
  const u = summarise(main, b.index, next);
  const label = labels.coordinator?.[String(s + 1)] ?? {};
  rows.push({
    kind: "coordinator",
    actor: "coordinator",
    agent_id: null,
    segment: s + 1,
    task_ids: label.task_ids ?? [],
    label: label.label ?? b.prompt.replace(/\s+/g, " ").slice(0, 90),
    status: label.status ?? null,
    ...u,
  });
});

rows.sort((a, b) => Date.parse(a.start ?? 0) - Date.parse(b.start ?? 0));

mkdirSync(outDir, { recursive: true });
writeFileSync(
  path.join(outDir, "task-usage.jsonl"),
  rows.map((r) => JSON.stringify({ ...r, start_at: r.start, end_at: r.end, start: undefined, end: undefined })).join("\n") + "\n",
);

const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
const dur = (s) => (s == null ? "—" : s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`);
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|");

const totals = rows.reduce(
  (t, r) => {
    for (const k of ["input_total", "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens", "requests"]) t[k] += r[k];
    return t;
  },
  { input_total: 0, input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, requests: 0 },
);

const byTask = new Map();
for (const r of rows) {
  for (const id of r.task_ids.length ? r.task_ids : ["(unlabelled)"]) {
    const t = byTask.get(id) ?? { input_total: 0, output_tokens: 0, requests: 0, segments: 0, start: null, end: null };
    t.input_total += r.input_total;
    t.output_tokens += r.output_tokens;
    t.requests += r.requests;
    t.segments += 1;
    if (r.start && (!t.start || r.start < t.start)) t.start = r.start;
    if (r.end && (!t.end || r.end > t.end)) t.end = r.end;
    byTask.set(id, t);
  }
}

const md = [];
md.push("# Task usage ledger");
md.push("");
md.push(`Generated by \`.brain/usage/collect-task-usage.mjs\` from session transcripts. Times are ${tz}. Re-run the script to refresh; do not edit the tables by hand.`);
md.push("");
md.push("**Input** is the full prompt charged per request: `input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens`. The breakdown columns show how much was cache writes and cache reads. **Output** is `output_tokens`. Each API request is counted once (de-duplicated by `requestId`).");
md.push("");
md.push("**Start** is the timestamp of the prompt or coordinator message that opened the segment; **End** is the last recorded transcript event before the next one. **Duration** is that wall-clock span, so a coordinator segment includes time spent waiting on background agents, not only its own model calls.");
md.push("");
md.push("A segment whose status is `open` was still running when the ledger was generated, so its numbers are partial. A task that spans several segments (review rounds, revisions) is summed in the per-task table. When a segment serves several task ids, it is counted in full under each, so per-task sums can exceed the grand total.");
md.push("");
md.push("## Totals");
md.push("");
md.push("| Segments | Requests | Input (total) | input_tokens | Cache write | Cache read | Output |");
md.push("|---:|---:|---:|---:|---:|---:|---:|");
md.push(`| ${rows.length} | ${fmt(totals.requests)} | ${fmt(totals.input_total)} | ${fmt(totals.input_tokens)} | ${fmt(totals.cache_creation_input_tokens)} | ${fmt(totals.cache_read_input_tokens)} | ${fmt(totals.output_tokens)} |`);
md.push("");
md.push("## Per task id");
md.push("");
md.push("| Task id | Segments | Start | End | Requests | Input (total) | Output |");
md.push("|---|---:|---|---|---:|---:|---:|");
for (const [id, t] of [...byTask].sort((a, b) => a[0].localeCompare(b[0]))) {
  md.push(`| ${cell(id)} | ${t.segments} | ${toOffset(t.start, tz) ?? "—"} | ${toOffset(t.end, tz) ?? "—"} | ${fmt(t.requests)} | ${fmt(t.input_total)} | ${fmt(t.output_tokens)} |`);
}
md.push("");
md.push("## Per segment");
md.push("");
md.push("| # | Task ids | Actor | Segment | Label | Status | Start | End | Duration | Requests | Input (total) | input_tokens | Cache write | Cache read | Output |");
md.push("|---:|---|---|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|");
rows.forEach((r, i) => {
  md.push(
    `| ${i + 1} | ${cell(r.task_ids.join(", ") || "—")} | ${cell(r.actor)}${r.agent_id ? ` \`${r.agent_id.slice(0, 7)}\`` : ""} | ${r.segment} | ${cell(r.label)} | ${cell(r.status ?? "done")} | ${toOffset(r.start, tz) ?? "—"} | ${toOffset(r.end, tz) ?? "—"} | ${dur(r.durationS)} | ${fmt(r.requests)} | ${fmt(r.input_total)} | ${fmt(r.input_tokens)} | ${fmt(r.cache_creation_input_tokens)} | ${fmt(r.cache_read_input_tokens)} | ${fmt(r.output_tokens)} |`,
  );
});
md.push("");
writeFileSync(path.join(outDir, "TASK-USAGE.md"), md.join("\n"));
console.log(`rows ${rows.length}; input_total ${totals.input_total}; output ${totals.output_tokens}; written to ${outDir}`);
