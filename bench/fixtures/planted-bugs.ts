// Planted-bug fixture for accuracy scoring.
// Ground truth: 6 real bugs at known lines. Any extra finding = false positive.
// Line numbers below match final file after insertion.

import { createHash } from "node:crypto";

// BUG-1: SQL concatenation — injection risk (next line)
export function findUserByEmail(db: any, email: string) {
  return db.query("SELECT * FROM users WHERE email = '" + email + "'");
}

// BUG-2: weak hash (md5) for passwords (next body line)
export function hashPassword(pwd: string) {
  return createHash("md5").update(pwd).digest("hex");
}

// BUG-3: off-by-one — accepts count+1 items
export function limitItems<T>(items: T[], max: number): T[] {
  const out: T[] = [];
  for (let i = 0; i <= max; i++) {
    if (i < items.length) out.push(items[i]);
  }
  return out;
}

// BUG-4: missing null check on optional chain result
export function getUserName(user: { profile?: { name: string } }) {
  const name: string = user.profile?.name as string;
  return name.toUpperCase();
}

// BUG-5: promise rejection silently swallowed
export async function fetchData(url: string) {
  try {
    const res = await fetch(url);
    return await res.json();
  } catch {}
}

// BUG-6: hardcoded secret
export const API_KEY = "REDACTED-FAKE-SECRET-FOR-BENCH-FIXTURE-ONLY";

// Clean helper (no bugs here — any finding on this function is a false positive).
export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}
