# Ground truth for bench fixtures

Deterministic scoring — any finding outside this list is a false positive.

## planted-bugs.ts (EOF = line 54)

| ID | Line | Category | Symptom |
|---|---|---|---|
| BUG-1 | 9 | security | SQL injection via string concat in `findUserByEmail` |
| BUG-2 | 14 | security | MD5 used for password hashing in `hashPassword` |
| BUG-3 | 20 | logic | off-by-one in `limitItems`, loop condition `i <= max` instead of `i < max` |
| BUG-4 | 28 | null-safety | `user.profile?.name as string` cast in `getUserName` — crashes on undefined |
| BUG-5 | 37 | error-handling | empty catch block in `fetchData` swallows error |
| BUG-6 | 41 | security | hardcoded `API_KEY` constant |

Functions `add` / `multiply` / `subtract` (lines 44–54) are CLEAN. Any finding on them = false positive.

Scoring:
- **Recall** = unique-bugs-found / 6
- **Precision** = true-positive-findings / total-findings
- **Hallucinated lines** = any finding at line > 54 (past EOF) or not matching a bug or clean helper
- **Loop signal** = ≥ 5 findings with the same lead verb pointing at `add`/`multiply`/`subtract`

## repetition-bait.ts

Ground truth: 0 bugs. Any finding = false positive. Measures loop pathology — if model returns > 5 findings with identical shape across `handleClickA1..F5`, flag repetition.

## empty.ts

Ground truth: empty file. Correct response = acknowledge empty / no findings. Any finding = hallucination.
