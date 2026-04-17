#!/usr/bin/env node
// Compute p50/p95/p99 from leg-d-latency.csv per {model, shape}.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSV = resolve(HERE, "..", "results", "leg-d-latency.csv");
const OUT = resolve(HERE, "..", "results", "leg-d-percentiles.csv");

const rows = readFileSync(CSV, "utf8").trim().split("\n");
const header = rows.shift().split(",");
const idx = Object.fromEntries(header.map((h, i) => [h, i]));

const groups = new Map();
for (const line of rows) {
  const r = line.split(",");
  const key = `${r[idx.model]}::${r[idx.shape]}`;
  if (!groups.has(key)) groups.set(key, { walls: [], tps: [] });
  groups.get(key).walls.push(Number(r[idx.wall_ms]));
  groups.get(key).tps.push(Number(r[idx.tok_per_sec]));
}

function pct(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[i];
}

const out = ["model,shape,n,p50_ms,p95_ms,p99_ms,p50_tps"];
for (const [key, { walls, tps }] of groups) {
  const [model, shape] = key.split("::");
  const ws = walls.slice().sort((a, b) => a - b);
  const ts = tps.slice().sort((a, b) => a - b);
  out.push(`${model},${shape},${walls.length},${pct(ws, 0.5)},${pct(ws, 0.95)},${pct(ws, 0.99)},${pct(ts, 0.5).toFixed(2)}`);
}
const body = out.join("\n") + "\n";
writeFileSync(OUT, body);
console.log(body);
