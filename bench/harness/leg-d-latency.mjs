#!/usr/bin/env node
// Leg D: latency distribution — N runs per shape, p50/p95/p99.
// Shapes probed via direct LM Studio (bypass MCP bridge, measure raw model latency).
// Shapes:
//   short_classify  — 1 classification, max_tokens=64
//   short_audit     — ~50-LOC file audit via inline content, max_tokens=512
//   mid_summarize   — ~200-LOC file summarize, max_tokens=256
//   long_analysis   — free-form 800-token reasoning on a bug hunt prompt

import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = process.env.LM_STUDIO_URL || "http://subashs-macbook-pro.local:1234/v1/chat/completions";
const MODEL = process.env.MODEL || "qwen2.5-coder-7b-instruct";
const N = Number(process.env.N || 20);

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = resolve(HERE, "..", "results", "leg-d-latency.csv");

const SHAPES = {
  short_classify: {
    max_tokens: 64,
    temperature: 0.0,
    messages: [
      { role: "system", content: "Label the commit message with exactly one of: feat, fix, refactor, docs, test, chore. Output only the label." },
      { role: "user", content: "fix(native): iPad camera preview black on QrScanScreen" },
    ],
  },
  short_audit: {
    max_tokens: 512,
    temperature: 0.2,
    messages: [
      { role: "system", content: "You are a code auditor. List bugs with file:line. Output ONLY findings." },
      { role: "user", content: `Audit this file for security bugs.\n\nexport function hashPassword(p: string) {\n  return require('crypto').createHash('md5').update(p).digest('hex');\n}\nexport function login(db: any, email: string) {\n  return db.query("SELECT * FROM u WHERE email='" + email + "'");\n}` },
    ],
  },
  mid_summarize: {
    max_tokens: 256,
    temperature: 0.2,
    messages: [
      { role: "user", content: "Summarize what this module does in 3 bullets:\n\n" +
        "import React from 'react';\nimport { useState, useEffect } from 'react';\n".repeat(10) +
        "export function useCounter(initial: number) {\n  const [n, setN] = useState(initial);\n  const inc = () => setN(n+1);\n  const dec = () => setN(n-1);\n  return { n, inc, dec };\n}\n".repeat(8) },
    ],
  },
  long_analysis: {
    max_tokens: 800,
    temperature: 0.2,
    messages: [
      { role: "user", content: "Design a retry-with-exponential-backoff helper in TypeScript. Cover: jitter strategy, max attempts, AbortSignal, timeout per attempt, error classification (retryable vs terminal). Provide a complete implementation with JSDoc." },
    ],
  },
};

function ensureHeader() {
  if (!existsSync(RESULTS)) {
    writeFileSync(RESULTS, "model,shape,run_idx,wall_ms,prompt_tokens,completion_tokens,tok_per_sec,http_status\n");
  }
}

function appendRow(r) {
  appendFileSync(RESULTS, `${r.model},${r.shape},${r.run_idx},${r.wall_ms},${r.prompt_tokens},${r.completion_tokens},${r.tok_per_sec},${r.http_status}\n`);
}

async function runOne(shape) {
  const body = { model: MODEL, ...SHAPES[shape] };
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch(SERVER, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const elapsed = Date.now() - start;
    const json = await res.json().catch(() => null);
    const pt = json?.usage?.prompt_tokens ?? -1;
    const ct = json?.usage?.completion_tokens ?? -1;
    const tps = ct > 0 && elapsed > 0 ? (ct / (elapsed / 1000)).toFixed(2) : "0";
    return { wall_ms: elapsed, prompt_tokens: pt, completion_tokens: ct, tok_per_sec: tps, http_status: res.status };
  } catch (e) {
    return { wall_ms: Date.now() - start, prompt_tokens: -1, completion_tokens: -1, tok_per_sec: 0, http_status: -1 };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  ensureHeader();
  const only = process.env.SHAPES?.split(",");
  const shapes = only?.length ? only : Object.keys(SHAPES);
  for (const shape of shapes) {
    if (!SHAPES[shape]) continue;
    console.error(`[latency] shape=${shape} model=${MODEL} runs=${N}`);
    await runOne(shape); // warm-up
    for (let i = 0; i < N; i++) {
      const r = await runOne(shape);
      appendRow({ model: MODEL, shape, run_idx: i, ...r });
      process.stderr.write(r.http_status === 200 ? "." : "x");
    }
    process.stderr.write("\n");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
