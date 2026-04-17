#!/usr/bin/env node
// Leg C: adversarial inputs via direct LM Studio
// Probe each shape for output pathology on hostile input.
// Shapes: empty, binary, huge, repetition-bait.

import { readFileSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = process.env.LM_STUDIO_URL || "http://subashs-macbook-pro.local:1234/v1/chat/completions";
const MODEL = process.env.MODEL || "qwen2.5-coder-7b-instruct";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "..", "fixtures");
const RESULTS = resolve(HERE, "..", "results", "leg-c-adversarial.csv");

const CASES = [
  {
    name: "empty",
    file: resolve(FIXTURES, "empty.ts"),
    expect: "acknowledge empty file, no findings",
  },
  {
    name: "repetition-bait",
    file: resolve(FIXTURES, "repetition-bait.ts"),
    expect: "0 bugs (30 trivial near-identical functions)",
  },
  {
    name: "binary",
    binary: true,
    expect: "refuse/acknowledge non-text",
  },
  {
    name: "huge",
    generate: () => "export function foo() { return 1; }\n".repeat(200),
    expect: "audit without looping or truncating mid-finding",
  },
];

function loadCase(c) {
  if (c.file) return readFileSync(c.file, "utf8");
  if (c.generate) return c.generate();
  if (c.binary) return Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd, 0x7f, 0x80, 0x81, 0x00, 0x01, 0x02]).toString("latin1") + "\x00\x01\x02";
  return "";
}

async function callLmStudio(userPrompt, maxTokens = 1024) {
  const start = Date.now();
  try {
    const res = await fetch(SERVER, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: "You are a code auditor. List bugs with file:line. If the input is empty or not source code, respond 'no findings'. Do NOT invent findings." },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: maxTokens,
      }),
    });
    const json = await res.json().catch(() => null);
    return {
      elapsed: Date.now() - start,
      status: res.status,
      text: json?.choices?.[0]?.message?.content ?? "",
      prompt_tokens: json?.usage?.prompt_tokens ?? -1,
      completion_tokens: json?.usage?.completion_tokens ?? -1,
    };
  } catch (e) {
    return { elapsed: Date.now() - start, status: 0, text: "", error: String(e.message || e) };
  }
}

function analyze(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const counts = new Map();
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
  const maxRepeat = Math.max(0, ...counts.values());
  const findingCount = lines.filter((l) => /\b(line|BUG|BLOCKER|MAJOR|MINOR|NIT|ISSUE)\b/i.test(l)).length;
  const noFindings = /no findings|empty|not applicable|no issues/i.test(text);
  const truncated = text.length > 0 && !/[.!?\n)\]}]$/.test(text.trim());
  return { finding_count: findingCount, max_line_repeat: maxRepeat, claims_no_findings: noFindings, maybe_truncated: truncated, response_len: text.length };
}

function ensureHeader() {
  if (!existsSync(RESULTS)) {
    writeFileSync(RESULTS, "model,case,wall_ms,http_status,prompt_tokens,completion_tokens,finding_count,max_line_repeat,claims_no_findings,maybe_truncated,response_len\n");
  }
}

async function main() {
  ensureHeader();
  for (const c of CASES) {
    const content = loadCase(c);
    const prompt = `Audit the following file for bugs.\n\n\`\`\`\n${content}\n\`\`\`\n\nList findings as one per line. Expected: ${c.expect}.`;
    const r = await callLmStudio(prompt);
    const a = analyze(r.text);
    console.error(`[leg-c] ${c.name}: status=${r.status} wall=${r.elapsed}ms findings=${a.finding_count} max_repeat=${a.max_line_repeat}`);
    appendFileSync(RESULTS,
      `${MODEL},${c.name},${r.elapsed},${r.status},${r.prompt_tokens},${r.completion_tokens},${a.finding_count},${a.max_line_repeat},${a.claims_no_findings},${a.maybe_truncated},${a.response_len}\n`
    );
    // Also dump response body for inspection
    writeFileSync(resolve(HERE, "..", "results", `leg-c-${c.name}-${MODEL.replace(/\./g, "_")}.txt`), r.text);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
