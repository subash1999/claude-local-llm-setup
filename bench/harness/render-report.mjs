#!/usr/bin/env node
// Render bench/report/report.md from CSV leg results.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = resolve(HERE, "..", "results");
const OUT = resolve(HERE, "..", "report", "report.md");

const RUN_DATE = new Date().toISOString().slice(0, 10);

function loadCsv(name) {
  const p = resolve(RESULTS, name);
  if (!existsSync(p)) return null;
  const rows = readFileSync(p, "utf8").trim().split("\n");
  const header = rows.shift().split(",");
  return rows.map((r) => {
    const cells = r.split(",");
    return Object.fromEntries(header.map((h, i) => [h, cells[i]]));
  });
}

function table(rows, cols) {
  const head = `| ${cols.join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${cols.map((c) => r[c] ?? "").join(" | ")} |`).join("\n");
  return [head, sep, body].join("\n");
}

function section(title, content) {
  return `## ${title}\n\n${content}\n`;
}

function renderLegB() {
  const rows = loadCsv("leg-b-ctx-ceiling.csv");
  if (!rows || rows.length === 0) return section("Leg B — Context ceiling", "_no data_");
  const byModel = new Map();
  for (const r of rows) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push(r);
  }
  let out = "";
  for (const [model, rs] of byModel) {
    // Sort by target_tokens (monotonic) so reader sees the ladder cleanly
    rs.sort((a, b) => Number(a.target_tokens) - Number(b.target_tokens));
    out += `### ${model}\n\n`;
    out += table(rs, ["target_tokens", "actual_prompt_tokens", "wall_ms", "recalled", "has_repeat", "anchor_repeat", "http_status"]);
    const successes = rs.filter((r) => Number(r.http_status) === 200 && Number(r.recalled) === 3 && r.has_repeat === "false");
    const maxOk = successes.reduce((m, r) => Math.max(m, Number(r.actual_prompt_tokens)), 0);
    const firstReject = rs.filter((r) => Number(r.http_status) !== 200).sort((a, b) => Number(a.target_tokens) - Number(b.target_tokens))[0];
    const firstDegraded = rs.filter((r) => Number(r.http_status) === 200 && (Number(r.recalled) < 3 || r.has_repeat === "true"))[0];
    out += `\n\n**Summary:**\n`;
    out += `- Max accepted input (HTTP 200 + 3/3 recall, no repeat): **${maxOk} actual prompt tokens**.\n`;
    if (firstReject) out += `- First HTTP 400 at target=${firstReject.target_tokens} (server rejected: input exceeded configured context window).\n`;
    if (firstDegraded) out += `- First recall/repeat degradation at target=${firstDegraded.target_tokens} (recall=${firstDegraded.recalled}/3, repeat=${firstDegraded.has_repeat}).\n`;
    else out += `- No recall or repetition degradation observed within accepted range.\n`;
    out += `\n`;
  }
  return section("Leg B — Context ceiling (anchor retrieval)", out);
}

function renderLegC() {
  const rows = loadCsv("leg-c-adversarial.csv");
  if (!rows) return section("Leg C — Adversarial", "_no data_");
  return section("Leg C — Adversarial inputs", table(rows, ["model", "case", "wall_ms", "finding_count", "max_line_repeat", "claims_no_findings", "maybe_truncated"]));
}

function renderLegD() {
  const rows = loadCsv("leg-d-percentiles.csv");
  if (!rows) return section("Leg D — Latency", "_no data_ (run `node bench/harness/leg-d-percentiles.mjs`)");
  return section("Leg D — Latency distribution", table(rows, ["model", "shape", "n", "p50_ms", "p95_ms", "p99_ms", "p50_tps"]));
}

function renderLegE() {
  const rows = loadCsv("leg-e-accuracy.csv");
  if (!rows) return section("Leg E — Accuracy", "_no data_");
  return section("Leg E — Accuracy vs ground truth (planted-bugs.ts)",
    table(rows, ["model", "unique_bugs_found", "true_positive", "false_positive", "hallucinated_line", "recall", "precision"]));
}

function renderLegA() {
  const p = resolve(RESULTS, "leg-a-feature-audit-6files.md");
  if (!existsSync(p)) return section("Leg A — local_feature_audit @ 6 files", "_no data_");
  return `## Leg A — local_feature_audit @ 6 files\n\n${readFileSync(p, "utf8")}\n`;
}

function renderCloudVsLocal() {
  return section("Leg G — Cloud vs Local comparison",
`| Tier | Model | Cost / 1M tok (in/out) | Ctx window | Output cap | p50 latency/req | Best-fit shapes | Known failure modes |
|---|---|---|---|---|---|---|---|
| Local HEAVY | Qwen2.5-Coder-7B | $0 / $0 | 131072 (server-capped) | ~4k practical | see Leg D | audit/review/find/summarize of ≤3 files, short classify, diff review | NIT/BLOCKER section loop at ≥4 files; fabricated line-number +5 offsets |
| Local DEEP | Qwen2.5-Coder-14B | $0 / $0 | 131072 | ~2k practical | +8s JIT first call, ~2x 7B after | second-opinion audit (rule-4 ladder), single-file audit where 7B loop | must serialize (RAM cap ~15GB combined); first-call JIT cost |
| Cloud cheap | Claude Haiku 4.5 | $1 / $5 | 200k | 8k | ~2s | classify, trivial one-file read, bulk WebSearch verify | weaker on multi-file reasoning, prone to skim |
| Cloud mid | Claude Sonnet 4.6 | $3 / $15 | 1M | 8k | ~4s | multi-file explore, tool-iteration review, refactor analysis, graph walks | occasional over-confidence on unseen APIs |
| Cloud premium | Claude Opus 4.7 | $15 / $75 | 1M | 32k | ~8s | architecture, novel design, multi-step debug, prod-critical codegen | expensive; not needed for tier-2 shapes |

**Decision rule:** cheapest tier that fits. Local first when task matches the rule-2 tool table in \`claude-local-llm-setup/mcp-bridge/CLAUDE-routing-policy.md\`. Doubt ladder: local HEAVY → local DEEP → Haiku+WebSearch → Sonnet → Opus.
`);
}

function main() {
  const header = `# Local LLM capability map\n\n- **Date:** ${RUN_DATE}\n- **Host:** M3 Pro 18 GB, subashs-macbook-pro.local:1234 (LM Studio)\n- **Models:** qwen2.5-coder-7b-instruct (HEAVY), qwen2.5-coder-14b-instruct (DEEP, JIT)\n- **Framework:** bench harness at \`bench/harness/\`, results at \`bench/results/\`\n\n---\n\n`;
  const body = [
    renderLegA(),
    renderLegB(),
    renderLegC(),
    renderLegD(),
    renderLegE(),
    renderCloudVsLocal(),
  ].join("\n---\n\n");
  writeFileSync(OUT, header + body);
  console.log(`wrote ${OUT}`);
}

main();
