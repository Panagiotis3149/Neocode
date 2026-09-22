# Mobile Remote Access — Idea Document

**Date:** 2026-08-08  
**Status:** Idea (pre-spec) — for future spec + implementation plan generation  
**Target:** Android-only PoC, Kotlin + Jetpack Compose

---

## Core Concept

A lightweight Android app that pairs once with a Neocode instance (via bridge relay) and provides:
- **Session management**: List, start, view running sessions
- **File explorer**: Read-only browse to pick working directory for new sessions
- **Messaging**: Send messages to active session, view output
- **Voice input**: Local Whisper.cpp → raw text → Neocode cleanup via provider → edited in input box → user sends

---

## Architecture Decisions (Locked for Spec)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Platform** | Android only (Kotlin + Jetpack Compose) | Best Whisper.cpp NDK/JNI integration; user is JetBrains user |
| **Network** | Bridge relay (reuse existing `/v1/environments/bridge`, WebSocket) | Works from anywhere, reuses auth/session infra |
| **Pairing** | Persistent device token + QR/short code; regenerate/delete/freeze options | SSH-key-like UX, one-time setup |
| **Whisper** | `whisper.cpp` via JNI; all models/quantizations (tiny→large, INT8/INT4/FP16) with recommended defaults | Local-first, no cloud API keys needed |
| **Voice cleanup** | Neocode side: receives raw text → calls selected provider/model (configurable) → returns cleaned text to mobile input box (not auto-send) | Reuses provider system; user reviews before send |
| **File explorer** | Read-only tree view; tap directory → "Start session here" | Scope-limited for PoC |

---

## Data Flow (Voice)

```
[Android] Record audio → whisper.cpp (local) → raw text
      ↓ HTTPS/WS (bridge)
[Neocode] Receive raw text → POST /cleanup (provider/model from settings) → cleaned text
      ↓ WS
[Android] Insert cleaned text into Compose TextField → user edits → Enter → send to session
```

---

## PoC Scope (What to Build)

1. **Neocode side** (`/mobile pair` command):
   - Generate pairing code + QR
   - Register bridge environment (elevated tier)
   - Store device token (persistent, with regenerate/delete/freeze)
   - Expose `/v1/mobile/cleanup` endpoint: `{ rawText, provider?, model? } → { cleanedText }`

2. **Android app**:
   - Pairing screen: code input + QR scanner
   - Main: Session list (running + history), File explorer (read-only), Active session view
   - Voice: Hold-to-talk → whisper.cpp → send raw → show cleaned in input → edit → send
   - Settings: Whisper model/quantization picker, cleanup provider/model picker

3. **Bridge extensions**:
   - Mobile device registration/auth (distinct from CLI bridge workers)
   - Session list + create session in arbitrary cwd
   - Message send/receive via existing WebSocket

---

## Non-Goals (PoC)

- iOS support
- Full file edit (read-only explorer only)
- Offline queue/sync
- Multiple paired devices (single device for PoC)
- Voice activity detection (simple hold-to-talk)

---

## Rough Effort Estimate

| Phase | Tasks | Est. |
|-------|-------|------|
| **1. Neocode pairing + cleanup endpoint** | `/mobile pair`, token storage, bridge device auth, `/cleanup` route | ~1 week |
| **2. Android scaffold + pairing** | Compose app, QR scan, token storage, bridge WebSocket connect | ~1 week |
| **3. Session UI + file explorer** | Session list, cwd picker, session view, message send/receive | ~1 week |
| **4. Whisper.cpp integration** | NDK build, JNI wrapper, model download/management, quantization picker | ~1-2 weeks |
| **5. Voice flow + cleanup** | Hold-to-talk, raw→Neocode→cleaned→input box, provider/model picker | ~1 week |
| **6. Polish + testing** | Edge cases, reconnection, model download UI, settings persistence | ~1 week |
| **Total** | | **~6-7 weeks** |

> **Note:** Whisper.cpp NDK/JNI is the biggest unknown — could be 1 week or 3 depending on model loading performance and JNI stability.

---

## Next Steps (Future Session)

1. **Write full spec** from this idea: detailed APIs, data models, UI flows, error handling, security model, test plan
2. **Write implementation plan** from spec: task breakdown, code snippets, Kotlin/Compose patterns, JNI bridge structure, Gradle config, bridge API contracts
3. **Implement** in isolated worktree