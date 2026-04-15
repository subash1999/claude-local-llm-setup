---
name: local-audit
description: Run a free security/bug/style audit on a file using the home-Mac local model. Use this WHENEVER the user asks to audit, review for issues, check for vulnerabilities, or scan a file — BEFORE using native Claude reasoning. Saves subscription quota.
---

Use the `local_audit` MCP tool (from local-llm-bridge server) with:
- `file_path`: absolute path of the file to audit
- `checklist`: what the user wants audited. If they didn't specify, default to "security vulnerabilities, logic bugs, error handling, style issues"

Return the audit report verbatim. If the user wants deeper analysis after, THEN escalate to your own reasoning — but start local.
