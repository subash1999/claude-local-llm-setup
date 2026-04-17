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

const MODE = process.env.LEG_A_MODE || 'clerk';  // 'clerk' | 'planted-bugs'

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

const PLANTED_BUGS_FILE = path.join(REPO_ROOT, 'bench', 'fixtures', 'planted-bugs.ts');
const PLANTED_BUGS_CHECKLIST =
  'SQL injection, weak password hashing (MD5), off-by-one loop bounds, ' +
  'null-safe access (optional chaining cast to non-null), empty catch swallowing errors, ' +
  'hardcoded secret keys (Stripe/other vendors).';

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

  console.error(`[leg-a-direct] mode=${MODE} connecting to bridge...`);
  await client.connect(transport);
  console.error(`[leg-a-direct] debug dir: ${debugDir}`);

  let result;
  let callArgs;
  let toolName;
  const t0 = Date.now();
  if (MODE === 'planted-bugs' || MODE === 'planted-bugs-deep') {
    toolName = MODE === 'planted-bugs-deep' ? 'local_deep_audit' : 'local_audit';
    callArgs = { file_path: PLANTED_BUGS_FILE, checklist: PLANTED_BUGS_CHECKLIST };
    console.error(`[leg-a-direct] ${toolName} ${PLANTED_BUGS_FILE}`);
    result = await client.callTool(
      { name: toolName, arguments: callArgs },
      undefined,
      { timeout: 180000 },
    );
  } else {
    toolName = 'local_feature_audit';
    callArgs = { spec: SPEC, file_paths: FILES };
    console.error(`[leg-a-direct] local_feature_audit files=${FILES.length}`);
    result = await client.callTool(
      { name: toolName, arguments: callArgs },
      undefined,
      { timeout: 120000 },
    );
  }
  const wall = Date.now() - t0;
  console.error(`[leg-a-direct] ${toolName} returned in ${wall} ms`);

  const outText = result.content?.[0]?.text ?? '';
  fs.writeFileSync(path.join(SNAPSHOT_DIR, 'tool-response.txt'), outText);

  const jsonlFiles = fs
    .readdirSync(debugDir)
    .filter((f) => f.endsWith('.jsonl'));

  const manifest = {
    run_ts_iso: new Date().toISOString(),
    mode: MODE,
    tool: toolName,
    wall_ms: wall,
    call_args: callArgs,
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
