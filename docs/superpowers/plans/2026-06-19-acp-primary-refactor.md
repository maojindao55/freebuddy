# ACP Primary Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor FreeBuddy so ACP is the default runtime path and legacy CLI JSON support is isolated as fallback.

**Architecture:** Split the current mixed `electron/cli/runtime.ts` into a small dispatcher plus `acpRuntime`, `legacyRuntime`, and shared task/log helpers. Keep `CliStreamItem` as the renderer contract, with ACP producing semantic `items` directly and legacy continuing through stdout/stderr parsers.

**Tech Stack:** Electron main process, TypeScript, React renderer, Node built-in test runner.

---

### Task 1: Adapter Metadata and Default Members

**Files:**
- Modify: `electron/cli/adapters.ts`
- Modify: `src/config/cliAdapters.ts`
- Modify: `src/config/aiMembers.ts`
- Modify: `tests/acp.test.mjs`

- [ ] Rename protocol values from `"cli-json"` to `"legacy-cli-json"`.
- [ ] Make ACP members the only default built-in members.
- [ ] Keep legacy adapter definitions in settings metadata.
- [ ] Run `npm test`.

### Task 2: Shared Runtime Helpers

**Files:**
- Create: `electron/cli/runtimeShared.ts`
- Modify: `electron/cli/runtime.ts`

- [ ] Move shared run types and task/log helpers out of `runtime.ts`.
- [ ] Keep `cliRun()` behavior unchanged after extraction.
- [ ] Run `npm test`.

### Task 3: ACP Runtime Module

**Files:**
- Create: `electron/cli/acpRuntime.ts`
- Modify: `electron/cli/runtime.ts`

- [ ] Move ACP JSON-RPC stdio orchestration out of `runtime.ts`.
- [ ] Keep ACP session resume, replay suppression, request handling, and cancellation unchanged.
- [ ] Run `npm test`.

### Task 4: Legacy Runtime Module

**Files:**
- Create: `electron/cli/legacyRuntime.ts`
- Modify: `electron/cli/runtime.ts`
- Modify: `README.md`

- [ ] Move legacy stdout/stderr execution out of `runtime.ts`.
- [ ] Keep session-id capture and legacy parser compatibility unchanged.
- [ ] Update docs to describe ACP as primary and legacy CLI JSON as fallback.
- [ ] Run `npm test`.
- [ ] Run `npm run build`.

