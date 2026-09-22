# Memory and Skill System V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Add secure, bounded, independently gated persistent memory, generated-skill, provider, reviewer, and encrypted history capabilities to NeoCode.

**Architecture:** SQLite is authoritative for structured V2 state. Managed Markdown files are conflict-aware projections. Session history and all derived retrieval artifacts are encrypted under epoch-scoped key material; active context is bounded by raw-derived capsule retrieval.

**Tech Stack:** Bun, TypeScript, bun:sqlite, Node crypto, existing credential storage, existing compaction and memory systems.

**Spec:** User-approved frozen architecture in this task transcript.

## Global Constraints

- Preserve unrelated dirty-worktree changes and do not commit, push, or reset.
- Do not add code comments.
- All new behavior is disabled unless its feature gate is effective.
- Use AES-256-GCM with 96-bit nonces and 128-bit tags for session artifacts.
- Never use a summary or capsule as input to a summarizer.
- Automated memory and skill writes reject secret-bearing content; they do not silently redact local content.
- `/forget` is memory-only; session-history deletion is separate and explicit.

---

### Task 1: V2 foundation, canonical serialization, and feature gates

**Files:**
- Create: `src/services/memoryV2/canonical.ts`
- Create: `src/services/memoryV2/featureGates.ts`
- Create: `src/services/memoryV2/canonical.test.ts`
- Create: `src/services/memoryV2/featureGates.test.ts`

**Produces:** Canonical decimal-integer serialization, exact-byte and scoped-HMAC helpers, and effective-gate dependency resolution.

- [ ] Write failing behavior tests for canonical integer conversion, LF/NFC normalization, unsupported value rejection, and blocked feature dependencies.
- [ ] Implement the minimal serialization and gate resolver.
- [ ] Run the two focused test files.

### Task 2: Transactional memory store and projection ownership

**Files:**
- Create: `src/services/memoryV2/store.ts`
- Create: `src/services/memoryV2/store.test.ts`
- Create: `src/services/memoryV2/projections.ts`
- Create: `src/services/memoryV2/projections.test.ts`

**Consumes:** Task 1 canonical hashes and gates.
**Produces:** SQLite-backed transactions, request-hash idempotency, tombstones, budgets, and external-edit-safe projections.

- [ ] Write failing tests for idempotent request reuse, altered request-ID rejection, budget rejection, tombstone suppression, and projection conflict preservation.
- [ ] Implement the minimal authoritative store and projection state machine.
- [ ] Run focused store/projection tests.

### Task 3: Session crypto epochs and encrypted history frames

**Files:**
- Create: `src/services/sessionCrypto/sessionCrypto.ts`
- Create: `src/services/sessionCrypto/sessionCrypto.test.ts`
- Create: `src/services/sessionCrypto/encryptedFrames.ts`
- Create: `src/services/sessionCrypto/encryptedFrames.test.ts`

**Consumes:** Task 1 canonical serialization.
**Produces:** Writer leases, fresh key epochs, 96-bit nonce construction, 128-bit-tag encryption, recovery states, and bounded encrypted frames.

- [ ] Write failing tests for fresh epoch on writer acquisition, rollback-safe nonce uniqueness, tag length, AAD tamper rejection, key-unavailable failure, and oversized-frame rejection.
- [ ] Implement the minimal crypto state and frame envelope.
- [ ] Run focused crypto tests.

### Task 4: Prompt fence, snapshots, and memory-only forget

**Files:**
- Create: `src/services/memoryV2/promptFence.ts`
- Create: `src/services/memoryV2/promptFence.test.ts`
- Modify: `src/memdir/memdir.ts`
- Modify: `src/commands/memory/memory.tsx`

**Consumes:** Tasks 2 and 3.
**Produces:** Snapshot/store generation separation, `SEND_COMMITTED` admission transitions, tombstone-driven snapshot revocation, and explicit forget messaging.

- [ ] Write failing state-machine tests for revoke-before-send, send commitment, stale fencing tokens, and poisoned-fence recovery.
- [ ] Implement the fence and wire memory snapshots behind a gate.
- [ ] Run focused fence tests and existing memory command tests.

### Task 5: Sanitized reviewer, generated skills, and provider contract

**Files:**
- Create: `src/services/memoryV2/reviewer.ts`
- Create: `src/services/memoryV2/reviewer.test.ts`
- Create: `src/services/memoryV2/provider.ts`
- Create: `src/services/memoryV2/provider.test.ts`
- Create: `src/services/generatedSkills/store.ts`
- Create: `src/services/generatedSkills/store.test.ts`
- Modify: `src/services/extractMemories/extractMemories.ts`
- Modify: `src/utils/hooks/skillImprovement.ts`

**Consumes:** Tasks 1-4.
**Produces:** Sanitized remote-review envelopes, bounded cursor semantics, generated-only skill attestation, and scoped provider/outbox validation.

- [ ] Write failing tests for secret-free reviewer input, evidence validation, stale provider epoch rejection, stable provider identity requirements, and promotion invalidation on mutation.
- [ ] Implement the minimal gated integrations.
- [ ] Run focused reviewer/provider/generated-skill tests.

### Task 6: Raw-only capsule retrieval and compaction integration

**Files:**
- Create: `src/services/compact/rawCapsules.ts`
- Create: `src/services/compact/rawCapsules.test.ts`
- Modify: `src/services/compact/compact.ts`
- Modify: `src/services/compact/sessionMemoryCompact.ts`

**Consumes:** Task 3 encrypted frames and Task 5 reviewer policy.
**Produces:** Encrypted raw-only capsules, bounded retrieval, retention pins, and fail-closed missing-raw handling.

- [ ] Write failing tests proving summaries/capsules cannot be compaction input, unresolved capsules respect budget, raw-source loss prevents summarization, and retention pins expire by session deadline.
- [ ] Implement raw-only capsule selection and gated integration.
- [ ] Run focused capsule and existing compaction tests.

### Task 7: Integration verification

**Files:**
- Modify: focused tests from Tasks 1-6 only as necessary for integration coverage.

- [ ] Run all V2 focused suites serially.
- [ ] Run typecheck, build, smoke, and privacy verification.
- [ ] Report static/build evidence separately from runtime, cross-process, and provider evidence.
