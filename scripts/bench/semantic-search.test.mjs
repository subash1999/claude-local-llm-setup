#!/usr/bin/env node
// semantic-search.test.mjs — regression test for local_semantic_search.
// Builds (or uses) the index over this repo and asserts that canonical queries
// return an expected path in top-K. Exits non-zero on failure.
//
// Why here and not in bench.mjs: bench.mjs scores competing LLMs on a fixed
// rubric; this tool is pure embedding retrieval — not a model comparison.
// Same spirit though: deterministic rubric, pass/fail per query.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execSync } from 'node:child_process';

const REPO = path.resolve(new URL('../../', import.meta.url).pathname);
const LOCAL = (process.env.LOCAL_LLM_BASE || 'http://127.0.0.1:1234').replace(/\/+$/, '');
const EMBED_URL = `${LOCAL}/v1/embeddings`;
const EMBED_MODEL = process.env.LOCAL_EMBED_MODEL || 'text-embedding-nomic-embed-text-v1.5';
const INDEX_DIR = process.env.SEMANTIC_INDEX_DIR || path.join(os.homedir(), '.claude', 'semantic-index');

function indexKey(absRoot) {
  return crypto.createHash('sha1').update(absRoot).digest('hex').slice(0, 16);
}

async function ensureIndex() {
  const key = indexKey(REPO);
  const jsonl = path.join(INDEX_DIR, `${key}.jsonl`);
  try { await fs.access(jsonl); return jsonl; } catch {}
  console.error('index missing — building…');
  execSync(`node ${path.join(REPO, 'scripts/semantic-index.mjs')} ${REPO}`, { stdio: 'inherit' });
  return jsonl;
}

async function loadIndex(jsonl) {
  const data = await fs.readFile(jsonl, 'utf8');
  return data.split('\n').filter(Boolean).map(l => {
    const o = JSON.parse(l);
    return { path: o.path, start: o.start, end: o.end, text: o.text, e: Float32Array.from(o.e) };
  });
}

async function embed(q) {
  const r = await fetch(EMBED_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: q }),
  });
  if (!r.ok) throw new Error(`embed ${r.status}`);
  const j = await r.json();
  return Float32Array.from(j.data[0].embedding);
}

function cosine(a, b) {
  let d=0,na=0,nb=0;
  const n = Math.min(a.length, b.length);
  for (let i=0;i<n;i++){d+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];}
  return d / (Math.sqrt(na)*Math.sqrt(nb) + 1e-9);
}

async function search(chunks, q, k=5) {
  const qv = await embed(q);
  return chunks
    .map((c, i) => ({ i, s: cosine(qv, c.e) }))
    .sort((x, y) => y.s - x.s)
    .slice(0, k)
    .map(({ i, s }) => ({ ...chunks[i], score: s }));
}

// Deterministic rubric: each query asserts the expected path appears in top_k.
// Paths are intentionally coarse (startsWith) so minor chunking changes don't break the test.
const FIXTURES = [
  { q: 'code that compresses output in caveman style',                     expect: 'mcp-bridge/server.mjs',       top_k: 3 },
  { q: 'function dupBulletCount that iterates lines and tracks seen bullets in a Map',  expect: 'scripts/bench/bench.mjs', top_k: 5 },
  { q: 'probe that finds max parallel and context for the hardware',       expect: 'scripts/find_parallel.py',    top_k: 3 },
  { q: 'claude routing policy that prefers local over cloud',              expect: 'mcp-bridge/CLAUDE-routing-policy.md', top_k: 3 },
  { q: 'nomic embedding indexer',                                          expect: 'scripts/semantic-index.mjs',  top_k: 3 },
];

const jsonl = await ensureIndex();
const chunks = await loadIndex(jsonl);
console.error(`index: ${chunks.length} chunks over ${new Set(chunks.map(c=>c.path)).size} files`);

let pass = 0, fail = 0;
for (const f of FIXTURES) {
  const hits = await search(chunks, f.q, f.top_k);
  const ok = hits.some(h => h.path === f.expect || h.path.startsWith(f.expect));
  const marker = ok ? 'PASS' : 'FAIL';
  if (ok) pass++; else fail++;
  console.log(`  [${marker}]  "${f.q}" → expected ${f.expect} in top-${f.top_k}`);
  if (!ok) {
    console.log('        actual hits:');
    hits.forEach(h => console.log(`          - [${h.score.toFixed(3)}] ${h.path}:${h.start}-${h.end}`));
  }
}

console.log(`\n${pass}/${pass+fail} passed`);
process.exit(fail ? 1 : 0);
