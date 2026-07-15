---
name: verify-change
description: Verify an implementation with focused checks, tests, and observable evidence.
version: 1.0.0
---

# Verify a change

Confirm the requested behavior through the narrowest reliable checks first, then broaden coverage in proportion to risk.

- Inspect the changed code path and its callers.
- Run focused tests, type checks, and build checks that cover the change.
- Report exact failures and distinguish pre-existing failures from regressions.
- Do not claim completion without observable evidence.
