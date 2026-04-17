#!/usr/bin/env node
// Leg B: context ceiling binary search
// Generate prompts of target token size with 3 planted UUID anchors
// Ask model to retrieve all 3 anchors; score recall + repetition.
// Output: CSV row per run to bench/results/leg-b-ctx-ceiling.csv

import { randomUUID } from "node:crypto";
import { writeFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = process.env.LM_STUDIO_URL || "http://subashs-macbook-pro.local:1234/v1/chat/completions";
const MODEL = process.env.MODEL || "qwen2.5-coder-7b-instruct";
const TARGET_TOKENS = Number(process.argv[2] || 8000);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 600000);

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = resolve(HERE, "..", "results", "leg-b-ctx-ceiling.csv");

// Generate filler paragraph of ~100 tokens
const FILLER = `The compiler performs static analysis on the input source tree, emitting warnings for unused variables, unreachable code paths, and potentially unsafe type coercions. Subsequent passes lower the intermediate representation into platform-specific machine code through a sequence of optimization stages including constant folding, dead-code elimination, and loop invariant motion. `;

function buildPrompt(targetTokens) {
  // Char-to-token ratio ~3.8 for English code/prose on qwen tokenizer
  const targetChars = Math.floor(targetTokens * 3.8);
  const fillerLen = FILLER.length;
  const fillerCopies = Math.ceil(targetChars / fillerLen);

  // Plant 3 anchors at 10%, 50%, 90% positions
  const anchors = [
    { pos: 0.1, code: randomUUID() },
    { pos: 0.5, code: randomUUID() },
    { pos: 0.9, code: randomUUID() },
  ];

  const parts = [];
  for (let i = 0; i < fillerCopies; i++) parts.push(FILLER);
  let doc = parts.join("");
  if (doc.length > targetChars) doc = doc.slice(0, targetChars);

  // Insert anchor sentences at target positions
  for (const a of anchors) {
    const insertAt = Math.floor(doc.length * a.pos);
    const sentence = `\n\n[MAGIC-CODE-${a.code}]\n\n`;
    doc = doc.slice(0, insertAt) + sentence + doc.slice(insertAt);
  }

  return { doc, anchors };
}

function scoreResponse(responseText, anchors) {
  let recalled = 0;
  const found = [];
  for (const a of anchors) {
    if (responseText.includes(a.code)) {
      recalled++;
      found.push(a.code);
    }
  }
  // Repetition detection
  const lines = responseText.split("\n").map((l) => l.trim()).filter(Boolean);
  const lineCounts = new Map();
  for (const l of lines) lineCounts.set(l, (lineCounts.get(l) ?? 0) + 1);
  const maxRepeat = Math.max(...lineCounts.values(), 0);
  const hasRepeat = maxRepeat >= 3;
  // Anchor repeat — same UUID listed more than once
  const anchorRepeat = found.some(
    (c) => (responseText.match(new RegExp(c, "g")) ?? []).length > 1
  );
  return { recalled, hasRepeat, maxRepeat, anchorRepeat };
}

async function callLmStudio(prompt, maxTokens = 512) {
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: "You are a precise retrieval assistant. Answer only with the requested data. No preamble." },
      { role: "user", content: prompt },
    ],
    temperature: 0.0,
    max_tokens: maxTokens,
  };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(SERVER, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const elapsed = Date.now() - start;
    const status = res.status;
    let json = null;
    let text = null;
    try {
      json = await res.json();
    } catch {
      text = await res.text().catch(() => null);
    }
    return { status, elapsed, json, text };
  } catch (e) {
    return { status: 0, elapsed: Date.now() - start, error: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function runOne(targetTokens) {
  const { doc, anchors } = buildPrompt(targetTokens);
  const userPrompt =
    doc +
    "\n\n---\n\nThe document above contains exactly three tokens of the form `[MAGIC-CODE-<uuid>]`. Output ONLY the three UUIDs, one per line, no other text.";

  const r = await callLmStudio(userPrompt, 512);
  const responseText = r.json?.choices?.[0]?.message?.content ?? "";
  const promptTokens = r.json?.usage?.prompt_tokens ?? -1;
  const completionTokens = r.json?.usage?.completion_tokens ?? -1;
  const score = scoreResponse(responseText, anchors);

  return {
    model: MODEL,
    target_tokens: targetTokens,
    actual_prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    http_status: r.status,
    wall_ms: r.elapsed,
    recalled: score.recalled,
    has_repeat: score.hasRepeat,
    max_repeat: score.maxRepeat,
    anchor_repeat: score.anchorRepeat,
    error: r.error ?? null,
    response_len: responseText.length,
  };
}

function ensureHeader() {
  if (!existsSync(RESULTS)) {
    writeFileSync(
      RESULTS,
      "model,target_tokens,actual_prompt_tokens,completion_tokens,http_status,wall_ms,recalled,has_repeat,max_repeat,anchor_repeat,response_len,error\n"
    );
  }
}

function appendRow(r) {
  appendFileSync(
    RESULTS,
    `${r.model},${r.target_tokens},${r.actual_prompt_tokens},${r.completion_tokens},${r.http_status},${r.wall_ms},${r.recalled},${r.has_repeat},${r.max_repeat},${r.anchor_repeat},${r.response_len},"${(r.error ?? "").replace(/"/g, "'")}"\n`
  );
}

async function main() {
  ensureHeader();
  console.error(`[leg-b] model=${MODEL} target=${TARGET_TOKENS}`);
  const r = await runOne(TARGET_TOKENS);
  appendRow(r);
  console.log(JSON.stringify(r, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
