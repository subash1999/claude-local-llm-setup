#!/usr/bin/env node
// Leg E: accuracy vs ground truth — planted-bugs fixture.
// Run audit prompt at each model, score recall/precision against GROUND-TRUTH.md.

import { readFileSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = process.env.LM_STUDIO_URL || "http://subashs-macbook-pro.local:1234/v1/chat/completions";
const MODEL = process.env.MODEL || "qwen2.5-coder-7b-instruct";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "..", "fixtures", "planted-bugs.ts");
const RESULTS = resolve(HERE, "..", "results", "leg-e-accuracy.csv");

// Ground truth: 6 bugs at known lines.
const BUGS = [
  { id: "BUG-1", line: 9,  keywords: ["sql", "injection", "concat", "findUserByEmail"] },
  { id: "BUG-2", line: 14, keywords: ["md5", "weak hash", "hashPassword"] },
  { id: "BUG-3", line: 20, keywords: ["off-by-one", "<=", "limitItems"] },
  { id: "BUG-4", line: 28, keywords: ["null", "undefined", "optional chain", "getUserName", "toUpperCase"] },
  { id: "BUG-5", line: 37, keywords: ["empty catch", "swallow", "fetchData", "silently"] },
  { id: "BUG-6", line: 41, keywords: ["hardcoded", "api", "key", "secret", "API_KEY"] },
];
const FILE_EOF = 54;

function matchBug(finding) {
  const low = finding.toLowerCase();
  for (const b of BUGS) {
    const hits = b.keywords.filter((k) => low.includes(k.toLowerCase())).length;
    // Require at least 1 keyword OR exact line match in text
    const lineMatch = new RegExp(`\\b${b.line}\\b`).test(finding);
    if (hits >= 1 || lineMatch) return b.id;
  }
  return null;
}

async function runAudit() {
  const content = readFileSync(FIXTURE, "utf8");
  const prompt = `Audit this TypeScript file for bugs (security, logic errors, error handling, null safety). List findings one per line in the form: LINE N: <symbol> — <problem>.\n\n\`\`\`typescript\n${content}\n\`\`\``;
  const start = Date.now();
  const res = await fetch(SERVER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: "You are a code auditor. Be thorough but avoid duplicates. Output only findings." },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 1024,
    }),
  });
  const elapsed = Date.now() - start;
  const json = await res.json().catch(() => null);
  const text = json?.choices?.[0]?.message?.content ?? "";
  return { elapsed, status: res.status, text, prompt_tokens: json?.usage?.prompt_tokens ?? -1, completion_tokens: json?.usage?.completion_tokens ?? -1 };
}

function score(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => /\bLINE\b|\bline\b|\bbug\b|\bissue\b/i.test(l) || /^\*|^-\s/.test(l));
  const findings = lines.filter((l) => l.length > 10);
  const foundBugs = new Set();
  let truePositive = 0;
  let hallucinatedLine = 0;
  for (const f of findings) {
    // Extract line number if present
    const m = f.match(/\bline\s*:?\s*(\d+)/i) ?? f.match(/:(\d+)\b/);
    const lineNum = m ? Number(m[1]) : null;
    if (lineNum !== null && lineNum > FILE_EOF) hallucinatedLine++;
    const hit = matchBug(f);
    if (hit) { foundBugs.add(hit); truePositive++; }
  }
  return {
    total_findings: findings.length,
    unique_bugs_found: foundBugs.size,
    true_positive: truePositive,
    false_positive: findings.length - truePositive,
    hallucinated_line: hallucinatedLine,
    recall: (foundBugs.size / BUGS.length).toFixed(3),
    precision: findings.length ? (truePositive / findings.length).toFixed(3) : "0.000",
  };
}

function ensureHeader() {
  if (!existsSync(RESULTS)) {
    writeFileSync(RESULTS, "model,wall_ms,prompt_tokens,completion_tokens,total_findings,unique_bugs_found,true_positive,false_positive,hallucinated_line,recall,precision\n");
  }
}

async function main() {
  ensureHeader();
  const r = await runAudit();
  const s = score(r.text);
  console.error(`[leg-e] ${MODEL}: bugs=${s.unique_bugs_found}/${BUGS.length} fp=${s.false_positive} hallucinated_line=${s.hallucinated_line} p=${s.precision} r=${s.recall}`);
  appendFileSync(RESULTS, `${MODEL},${r.elapsed},${r.prompt_tokens},${r.completion_tokens},${s.total_findings},${s.unique_bugs_found},${s.true_positive},${s.false_positive},${s.hallucinated_line},${s.recall},${s.precision}\n`);
  writeFileSync(resolve(HERE, "..", "results", `leg-e-${MODEL.replace(/\./g, "_")}.txt`), r.text);
}

main().catch((e) => { console.error(e); process.exit(1); });
