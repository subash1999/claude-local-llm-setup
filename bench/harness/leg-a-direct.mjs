#!/usr/bin/env node
// Round 2 Phase 3: direct snapshot of the filter pipeline on the Clerk
// 3-file hooks batch. Drives the real mcp-bridge/server.mjs via stdio-MCP
// with LOCAL_LLM_DEBUG_DIR set, so every filter stage writes one JSONL
// line to the debug dir. Output: the raw + filtered tool response +
// a pointer to the JSONL the bridge wrote.
//
// Clerk fixtures in bench/fixtures/clerk/ are synthetic reconstructions
// keyed to Opus-oracle line numbers (see bench/report/leg-f-opus-oracle.md).
// Exact line positions match the oracle's BLOCKER findings so Fix E's
// symbol-match-within-±3 behavior can be probed deterministically.
//
// Usage:
//   LOCAL_LLM_URL=http://localhost:1234/v1/chat/completions \
//     node bench/harness/leg-a-direct.mjs

import { Client } from '../../mcp-bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../mcp-bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BRIDGE_PATH = path.join(REPO_ROOT, 'mcp-bridge', 'server.mjs');
const CLERK_DIR = path.join(REPO_ROOT, 'bench', 'fixtures', 'clerk');
const SNAPSHOT_DIR = path.join(
  REPO_ROOT,
  'bench',
  'results',
  'round2',
  `snapshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`,
);

const FILES = [
  path.join(CLERK_DIR, 'use-email-sign-up.ts'),
  path.join(CLERK_DIR, 'use-email-sign-in.ts'),
  path.join(CLERK_DIR, 'use-google-auth.ts'),
];

const SPEC =
  'Clerk v3 Future API integration. ' +
  'Flag deprecated Clerk v2 shapes: `signUp.verifications.sendEmailCode`, ' +
  '`signUp.verifications.verifyEmailCode`, `signIn.emailCode.sendCode`, ' +
  '`signIn.emailCode.verifyCode`, and `startSSOFlow` (renamed to `startFlow`). ' +
  'Plus flag the v2 return shape `result.createdSessionId` (v3 uses ' +
  '`session.id`) and fragile error-message string matching for cancel paths.';

async function main() {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const debugDir = path.join(SNAPSHOT_DIR, 'jsonl');
  fs.mkdirSync(debugDir, { recursive: true });

  if (!process.env.LOCAL_LLM_URL) {
    console.error(
      '[leg-a-direct] LOCAL_LLM_URL not set — defaulting to http://localhost:1234/v1/chat/completions',
    );
  }

  const env = {
    ...process.env,
    LOCAL_LLM_DEBUG_DIR: debugDir,
    LOCAL_LLM_URL:
      process.env.LOCAL_LLM_URL || 'http://localhost:1234/v1/chat/completions',
  };

  const transport = new StdioClientTransport({
    command: 'node',
    args: [BRIDGE_PATH],
    env,
  });

  const client = new Client(
    { name: 'leg-a-direct-harness', version: '0.1.0' },
    { capabilities: {} },
  );

  console.error('[leg-a-direct] connecting to bridge...');
  await client.connect(transport);
  console.error(`[leg-a-direct] debug dir: ${debugDir}`);
  console.error(`[leg-a-direct] files: ${FILES.length}`);

  const t0 = Date.now();
  const result = await client.callTool({
    name: 'local_feature_audit',
    arguments: { spec: SPEC, file_paths: FILES },
  });
  const wall = Date.now() - t0;
  console.error(`[leg-a-direct] feature_audit returned in ${wall} ms`);

  const outText = result.content?.[0]?.text ?? '';
  fs.writeFileSync(path.join(SNAPSHOT_DIR, 'tool-response.txt'), outText);

  const jsonlFiles = fs
    .readdirSync(debugDir)
    .filter((f) => f.endsWith('.jsonl'));

  const manifest = {
    run_ts_iso: new Date().toISOString(),
    wall_ms: wall,
    files: FILES,
    spec: SPEC,
    jsonl_files: jsonlFiles,
    tool_response_bytes: outText.length,
  };
  fs.writeFileSync(
    path.join(SNAPSHOT_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );

  console.error(
    `[leg-a-direct] done. snapshot: ${SNAPSHOT_DIR} (${jsonlFiles.length} JSONL file(s), ` +
    `${outText.length} bytes tool response)`,
  );

  await client.close();
}

main().catch((err) => {
  console.error('[leg-a-direct] fatal:', err);
  process.exit(1);
});
