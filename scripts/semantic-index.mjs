#!/usr/bin/env node
// semantic-index.mjs — embed a repo's files with the local nomic-embed model
// and write a JSONL index that local_semantic_search can query. No cloud,
// no API key, no 7B calls.
//
// Usage:
//   node scripts/semantic-index.mjs <repo-root>
//   node scripts/semantic-index.mjs <repo-root> --rebuild
//   node scripts/semantic-index.mjs <repo-root> --install-hook
//   node scripts/semantic-index.mjs <repo-root> --rebuild --quiet   (for git hooks)
//
// Env:
//   LOCAL_LLM_BASE  — preferred; e.g. http://your-mac.local:1234
//   HOME_LLM_URL    — fallback; same shell var the `claude-local` alias uses
//   (default if neither set: http://127.0.0.1:1234)
//   EMBED_MODEL     — default text-embedding-nomic-embed-text-v1.5
//   INDEX_DIR       — default ~/.claude/semantic-index
//
// Output:
//   <INDEX_DIR>/<sha1(absRoot)>.jsonl    — one chunk per line
//   <INDEX_DIR>/<sha1(absRoot)>.meta.json
//
// Walk strategy: `git ls-files` if the root is a repo, else a filtered walk.
// Chunking: 40-line windows with 10-line overlap, per file.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execSync } from 'node:child_process';

const LOCAL_BASE = (process.env.LOCAL_LLM_BASE || process.env.HOME_LLM_URL || 'http://127.0.0.1:1234').replace(/\/+$/, '');
const EMBED_URL  = `${LOCAL_BASE}/v1/embeddings`;
const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-nomic-embed-text-v1.5';
const INDEX_DIR  = process.env.INDEX_DIR || path.join(os.homedir(), '.claude', 'semantic-index');

const CHUNK_LINES   = 40;
const CHUNK_OVERLAP = 10;
const MAX_FILE_BYTES = 500_000;
const BATCH_SIZE = 16;

const CODE_EXT = new Set([
  '.js','.mjs','.cjs','.ts','.tsx','.jsx','.go','.py','.rb','.rs','.java','.kt',
  '.swift','.m','.c','.cc','.cpp','.h','.hpp','.cs','.php','.scala','.sh','.bash',
  '.zsh','.fish','.lua','.pl','.r','.dart','.vue','.svelte','.astro',
  '.sql','.proto','.thrift','.graphql',
  '.md','.mdx','.rst','.txt',
  '.json','.yaml','.yml','.toml','.ini','.env.example',
  '.html','.css','.scss','.sass','.less',
  '.dockerfile','.mk','.cmake',
]);
const SKIP_DIR = new Set([
  'node_modules','.git','dist','build','.next','.expo','.nuxt','coverage',
  '.turbo','.cache','.venv','venv','__pycache__','.pytest_cache','target',
  'vendor','.idea','.vscode','.DS_Store','.parcel-cache','.svelte-kit',
]);

let QUIET = false;
function log(...a) { if (!QUIET) console.error('[index]', ...a); }

// Git post-commit hook: rebuilds the index in the background after every commit.
// Idempotent. Refuses to overwrite a user-authored hook — prints the line to add.
async function installHook(absRoot) {
  const gitDir = path.join(absRoot, '.git');
  const st = await fs.stat(gitDir).catch(() => null);
  if (!st?.isDirectory()) {
    console.error(`${absRoot} is not a git repo (no .git directory).`);
    process.exit(2);
  }
  const hookPath = path.join(gitDir, 'hooks', 'post-commit');
  const scriptPath = path.resolve(process.argv[1]);
  const marker = '# claude-local-llm-setup: semantic-index auto-rebuild';
  const hookLine =
    `(node ${JSON.stringify(scriptPath)} ${JSON.stringify(absRoot)} --rebuild --quiet >/dev/null 2>&1 &)`;
  const existing = await fs.readFile(hookPath, 'utf8').catch(() => null);

  if (existing?.includes(marker)) {
    console.error(`hook already installed at ${hookPath}`);
    return;
  }
  if (existing) {
    console.error(`${hookPath} already exists. Append these two lines manually:`);
    console.error(`  ${marker}`);
    console.error(`  ${hookLine}`);
    process.exit(1);
  }

  const body = `#!/bin/sh\n${marker}\n${hookLine}\n`;
  await fs.mkdir(path.dirname(hookPath), { recursive: true });
  await fs.writeFile(hookPath, body, { mode: 0o755 });
  console.error(`installed post-commit hook: ${hookPath}`);
  console.error('the index now rebuilds in the background after every commit.');
  console.error('(uncommitted working-tree edits are still stale until a rebuild.)');
}

function wantFile(p) {
  const base = path.basename(p);
  if (base.startsWith('.') && !['.env.example','.eslintrc','.prettierrc'].includes(base)) return false;
  const ext = path.extname(p).toLowerCase();
  if (!ext) return ['Dockerfile','Makefile','CMakeLists.txt'].includes(base);
  return CODE_EXT.has(ext);
}

function listRepoFiles(root) {
  try {
    const out = execSync('git ls-files --cached --others --exclude-standard', {
      cwd: root, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024,
    });
    const rels = out.split('\n').filter(Boolean).filter(wantFile);
    return rels.map(r => path.join(root, r));
  } catch {
    log('not a git repo — falling back to manual walk');
    return walk(root);
  }
}

async function walk(dir, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.env.example') continue;
    if (SKIP_DIR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile() && wantFile(p)) out.push(p);
  }
  return out;
}

function chunkFile(absPath, text) {
  const lines = text.split('\n');
  if (lines.length <= CHUNK_LINES) {
    return [{ path: absPath, start: 1, end: lines.length, text }];
  }
  const out = [];
  const step = CHUNK_LINES - CHUNK_OVERLAP;
  for (let i = 0; i < lines.length; i += step) {
    const slice = lines.slice(i, i + CHUNK_LINES);
    if (slice.length < 5) break;
    out.push({
      path: absPath,
      start: i + 1,
      end: i + slice.length,
      text: slice.join('\n'),
    });
    if (i + CHUNK_LINES >= lines.length) break;
  }
  return out;
}

async function embedBatch(inputs) {
  const r = await fetch(EMBED_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: inputs }),
  });
  if (!r.ok) throw new Error(`embed ${r.status}: ${(await r.text()).slice(0,200)}`);
  const j = await r.json();
  return j.data.map(d => d.embedding);
}

async function main() {
  const args = process.argv.slice(2);
  const root = args.find(a => !a.startsWith('--'));
  const rebuild = args.includes('--rebuild');
  const hookFlag = args.includes('--install-hook');
  QUIET = args.includes('--quiet');
  if (!root) {
    console.error('Usage: semantic-index.mjs <repo-root> [--rebuild] [--install-hook] [--quiet]');
    process.exit(2);
  }
  const absRoot = path.resolve(root);
  const stat = await fs.stat(absRoot).catch(() => null);
  if (!stat?.isDirectory()) { console.error(`Not a directory: ${absRoot}`); process.exit(2); }

  if (hookFlag) { await installHook(absRoot); return; }

  await fs.mkdir(INDEX_DIR, { recursive: true });
  const key = crypto.createHash('sha1').update(absRoot).digest('hex').slice(0, 16);
  const jsonl = path.join(INDEX_DIR, `${key}.jsonl`);
  const meta  = path.join(INDEX_DIR, `${key}.meta.json`);

  if (!rebuild) {
    const prev = await fs.readFile(meta, 'utf8').catch(() => null);
    if (prev) log(`existing index at ${jsonl} — pass --rebuild to regenerate`);
  }

  log(`root:  ${absRoot}`);
  log(`index: ${jsonl}`);
  log('scanning files…');
  const files = listRepoFiles(absRoot);
  log(`found ${files.length} files`);

  const chunks = [];
  let readErrs = 0, skipped = 0;
  for (const f of files) {
    try {
      const st = await fs.stat(f);
      if (st.size > MAX_FILE_BYTES) { skipped++; continue; }
      const text = await fs.readFile(f, 'utf8');
      if (!/\S/.test(text)) continue;
      chunks.push(...chunkFile(f, text));
    } catch {
      readErrs++;
    }
  }
  log(`chunks: ${chunks.length} (skipped ${skipped} huge, ${readErrs} read errors)`);

  if (!chunks.length) { console.error('nothing to index'); process.exit(1); }

  const handle = await fs.open(jsonl, 'w');
  const t0 = Date.now();
  let done = 0;
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const vecs = await embedBatch(batch.map(c => `${path.relative(absRoot, c.path)}:${c.start}-${c.end}\n${c.text}`));
    for (let j = 0; j < batch.length; j++) {
      const c = batch[j];
      await handle.write(JSON.stringify({
        path: path.relative(absRoot, c.path),
        start: c.start,
        end: c.end,
        text: c.text.slice(0, 400),
        e: vecs[j],
      }) + '\n');
    }
    done += batch.length;
    if (done % 160 === 0 || done === chunks.length) {
      const elapsed = (Date.now() - t0) / 1000;
      log(`${done}/${chunks.length} (${(done/elapsed).toFixed(1)} chunks/s)`);
    }
  }
  await handle.close();

  const metaJson = {
    root: absRoot,
    indexed_at: new Date().toISOString(),
    file_count: new Set(chunks.map(c => c.path)).size,
    chunk_count: chunks.length,
    embed_model: EMBED_MODEL,
    chunk_lines: CHUNK_LINES,
    chunk_overlap: CHUNK_OVERLAP,
    dim: 768,
  };
  await fs.writeFile(meta, JSON.stringify(metaJson, null, 2));
  log(`done in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  log(`meta: ${meta}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
