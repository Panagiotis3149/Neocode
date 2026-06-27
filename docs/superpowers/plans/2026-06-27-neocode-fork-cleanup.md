# Neocode Fork Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip gitlawb/OpenClaude branding from the Neocode repo's cosmetic/nav surfaces and point the one canonical live URL at `https://github.com/Panagiotis3149/neocode`. Don't touch functional API identifiers, source code, or `dist/` build artifacts.

**Architecture:** Straightforward find/replace over a known file list (markdown, yml, json, html, Dockerfile, vs-ext JS). No new code, no new tests, no codebase changes. Step order moves from highest-visibility user-facing files (README, PLAYBOOK) → metadata (LICENSE, package.json) → CI/templates → docs → sub-extensions → web → CLAUDE.md rename. Verification grep runs at the end to confirm no leakage.

**Tech Stack:** `Edit` (exact string edits with sufficient context), `Read` (pre-read every target file before editing), `Bash` for final grep verification.

**Spec:** `docs/superpowers/specs/2026-06-27-neocode-fork-cleanup.md`

---

### Task 1: Clean README.md

**Files:**
- Modify: `README.md`

Steps:

- [ ] **Step 1: Read README.md fully**

Use `Read` with `file_path: C:\Users\liosi\Documents\NeoclientRelated\NeoCode\README.md`.

- [ ] **Step 2: Replace the "Neocode originated from OpenClaude …" paragraph**

Replace:
```
This repository is a fork of [gitlawb/openclaude](https://github.com/gitlawb/openclaude), itself a fork of Anthropic's Claude Code.
```

With:
```
Neocode is an open-source coding-agent CLI derived from [OpenClaude](https://github.com/gitlawb/openclaude), derived from Anthropic's Claude Code.
```

(NOTE: `gitlawb/openclaude` is a real upstream pointer — this is an attribution, not cosmetic branding. Keep the link to github.com/gitlawb/openclaude but drop the "This repository is a fork of" framing that positions the Neocode repo as a downstream project.)

- [ ] **Step 3: Replace cosmetic gitlawb GitHub URLs in the README**

Search-and-Replace (Edit, `replace_all: false`) each cosmetic instance of `github.com/gitlawb/openclaude` → `github.com/Panagiotis3149/neocode`. Likely hits: the README header line, the intro section, any badges, the documentation/contributing links.

Do NOT rewrite `opengateway.gitlawb.com` URLs — those are functional base URLs.

- [ ] **Step 4: Strip marketing navigation sections**

Delete the following (likely at the bottom of README):
- "Blog" link/section
- "Case Studies" link/section
- "Enterprise" link/section
- Any "Join the OpenClaude Discord" or "openclaude.dev" lines

Replace `https://openclaude.dev` or similar upstream domain lines with a single line: `Website: https://github.com/Panagiotis3149/neocode`.

- [ ] **Step 5: Drop the forking guide**

The README contains a Forking Claude Code: a pain guide section. The entire section is from upstream and not relevant. Delete it.

- [ ] **Step 6: Replace the Discord link**

Replace:
```
https://discord.gg/claudecode
```

With the fork's actual Discord, **or** remove the line if no fork Discord exists.

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs: clean README.md of gitlawb/openclaude upstream branding"
```

---

### Task 2: Clean PLAYBOOK.md

**Files:**
- Modify: `PLAYBOOK.md`

Steps:

- [ ] **Step 1: Read PLAYBOOK.md fully**

- [ ] **Step 2: Strip non-operational sections**

Delete the bloated "About", "FAQ", "Community/social", "Comparison table", "Brand Assets", "Testimonials", "500-line README-style disclaimer sections" that sit in the middle of PLAYBOOK.md. The file is supposed to be a quick-reference operator guide, not a marketing deck.

- [ ] **Step 3: Replace gitlawb GitHub URLs**

Same as README: replace cosmetic `github.com/gitlawb/openclaude` URLs with `github.com/Panagiotis3149/neocode`. Preserve upstream attribution if it appears as "derived from" line.

- [ ] **Step 4: Commit**

```bash
git add PLAYBOOK.md
git commit -m "docs: strip marketing sections from PLAYBOOK.md, replace upstream URLs"
```

---

### Task 3: Rewrite LICENSE + rename CLAUDE.md → NEOCODE.md

**Files:**
- Modify: `LICENSE`
- Modify: `CLAUDE.md` (rename in place to `NEOCODE.md` after editing)

Steps:

- [ ] **Step 1: Read LICENSE fully**

- [ ] **Step 2: Replace LICENSE content**

Replace the existing custom MIT+NOTICE license body with a clean MIT license. Required content:

```
MIT License

Copyright (c) 2026 Panagiotis3149

This software is derived from [OpenClaude](https://github.com/gitlawb/openclaude),
which is derived from [Anthropic's Claude Code](https://github.com/anthropics/claude-code).
The original works are copyright their respective authors and released under their
original licenses.

Permission is hereby granted, free of charge, to any person obtaining a copy
[... standard MIT grant ...]

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND [...]
```

(AGENT: if the existing LICENSE file is short/clean MIT already, just update the copyright line and add the single "derived from OpenClaude / Claude Code" ONE-LINE attribution. Don't over-write a short license with a 200-line one. Check first.)

- [ ] **Step 3: Read CLAUDE.md fully**

- [ ] **Step 4: Replace gitlawb references in CLAUDE.md**

Replace any standalone `gitlawb` references (e.g., "fork of gitlawb/openclaude") with `Panagiotis3149/neocode`.

- [ ] **Step 5: Rename CLAUDE.md → NEOCODE.md**

After editing, use `git mv CLAUDE.md NEOCODE.md`. (Note: CLAUDE.md contains "a Forking Claude Code: a pain guide" section. Keep the practical "how to sync upstream, build" content — that's operational — but drop lines like "This repo = fork of gitlawb/openclaude, indirect fork of Anthropic's Claude Code." If CLAUDE.md was originally the fork guide, keep the guide; just clean the branding.)

- [ ] **Step 6: Commit**

```bash
git mv CLAUDE.md NEOCODE.md
git commit -m "docs: clean CLAUDE.md references, rename to NEOCODE.md; rewrite LICENSE copyright"
```

---

### Task 4: Clean Dockerfile

**Files:**
- Modify: `Dockerfile`

Steps:

- [ ] **Step 1: Read Dockerfile fully**

- [ ] **Step 2: Strip gitlawb branding**

- Replace `LABEL maintainer=` if it had a gitlawb placeholder with `Panagiotis3149`.
- Replace any `ENV GITHUB_REPO=https://github.com/gitlawb/openclaude` with `ENV GITHUB_REPO=https://github.com/Panagiotis3149/neocode`.
- Remove any comment lines referencing the upstream branding (e.g., `# Based on gitlawb/openclaude`).

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "docs: clean Dockerfile branding, point GITHUB_REPO to Panagiotis3149/neocode"
```

---

### Task 5: Clean .github/ (workflows, issue templates, PR template)

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `.github/ISSUE_TEMPLATE/bug_report.md`
- Modify: `.github/ISSUE_TEMPLATE/feature_request.md`
- Modify: `pull_request_template.md` (if exists)
- Modify: `.github/ISSUE_TEMPLATE/config.yml`

Steps:

- [ ] **Step 1: Read all listed files**

- [ ] **Step 2: Verify release.yml**

`release.yml` should already reference `Panagiotis3149/neocode` (per earlier grep). Confirm and do nothing if so.

- [ ] **Step 3: Replace gitlawb URLs in templates**

Replace `github.com/gitlawb/openclaude` → `github.com/Panagiotis3149/neocode` in each template file.

Delete any line like "File issues upstream at gitlawb/openclaude" if present.

- [ ] **Step 4: Drop Neocode Discord/Slack link inheritance**

Templates may include a contact link inherited from upstream. If a fork-specific community URL exists, replace it; otherwise remove the line.

- [ ] **Step 5: Commit**

```bash
git add .github/
git commit -m "ci: replace gitlawb links with Panagiotis3149/neocode in GitHub templates"
```

---

### Task 6: Clean vscode-extension/

**Files:**
- Modify: `vscode-extension/neocode-vscode/README.md`
- Modify: `vscode-extension/neocode-vscode/src/extension.js`

Steps:

- [ ] **Step 1: Read both files**

Look for physical URLs: `github.com/Gitlawb/neocode` and `https://github.com/Gitlawb/neocode`.

In `extension.js`, the values are set as constants at lines 19-20:

```js
const NEOCODE_REPO_URL = 'https://github.com/Gitlawb/neocode';
const NEOCODE_SETUP_URL = 'https://github.com/Gitlawb/neocode/blob/main/README.md#quick-start';
```

Replace both with:

```js
const NEOCODE_REPO_URL = 'https://github.com/Panagiotis3149/neocode';
const NEOCODE_SETUP_URL = 'https://github.com/Panagiotis3149/neocode/blob/main/README.md#quick-start';
```

(Items: agent: confirm casing of Gitlawb vs gitlawb — from earlier grep, it's `Gitlawb` in extension.js (capital G, capital B). Use the actual casing.)

- [ ] **Step 2: Replace URLs and npm package refs in README**

Replace `npm install -g @gitlawb/neocode@latest` → `npm install -g @Panagiotis3149/neocode@latest`.
Replace `https://github.com/gitlawb/openclaude` or `https://github.com/Gitlawb/neocode` → `https://github.com/Panagiotis3149/neocode`.
Discord link: replace or remove.

- [ ] **Step 3: Commit**

```bash
git add vscode-extension/neocode-vscode/README.md vscode-extension/neocode-vscode/src/extension.js
git commit -m "docs: clean vscode-extension branding, use Panagiotis3149 canonical URL"
```

---

### Task 7: Clean docs/

**Files:**
- Modify: `docs/advanced-setup.md`
- Modify: `docs/quick-start-windows.md`
- Modify: `docs/quick-start-mac-linux.md`
- Modify: `docs/integrations/overview.md` (if it exists)
- Modify: `docs/non-technical-setup.md` (if it exists)
- Skipped: `docs/superpowers/specs/2026-06-25-neocode-rebrand.md` (historical)

Steps:

- [ ] **Step 1: Read each doc file**

- [ ] **Step 2: Replace npm package name**

Edit with `replace_all: true` per file:
`@gitlawb/neocode` → `@Panagiotis3149/neocode` in each of the four doc files.

Expecting hits: lines 10, 21, 33, 49, 69, 73, 137, 143, 149, 155 in win/mac/linux guides; line 10 in advanced.

- [ ] **Step 3: Replace cosmetic GitHub URLs**

Replace `github.com/gitlawb/openclaude` → `github.com/Panagiotis3149/neocode` in each doc file.

- [ ] **Step 4: PRESERVE OpenGateway URLs in advanced-setup.md**

Per spec, leave lines 219 and 225 alone (`opengateway.gitlawb.com` is a functional base URL, not cosmetic branding).

- [ ] **Step 5: Commit**

```bash
git add docs/
git commit -m "docs: strip gitlawb/upstream branding from docs, use @Panagiotis3149 package name"
```

---

### Task 8: Clean web/

**Files:**
- Modify: `web/index.html`
- Modify: `web/src/App.tsx`
- Modify: `web/src/content.ts`
- Modify: `web/README.md` (if exists)

Steps:

- [ ] **Step 1: Read each file**

- [ ] **Step 2: Replace GitHub URLs**

Replace `https://github.com/gitlawb/openclaude`, `gitlawb/openclaude`, `openclaude.dev`, and any other upstream branding reference with `https://github.com/Panagiotis3149/neocode`.

- [ ] **Step 3: Drop Discord/social links**

Replace the community links footer with fork-original links, or remove it.

- [ ] **Step 4: Commit**

```bash
git add web/
git commit -m "docs: strip upstream branding from web/, use Panagiotis3149 canonical URL"
```

---

### Task 9: Verification

**Files:** none (read-only grep)

Steps:

- [ ] **Step 1: Run verification grep**

```bash
cd "C:\Users\liosi\Documents\NeoclientRelated\NeoCode"
grep -r -l "gitlawb" --include="*.md" --include="*.yml" --include="*.yaml" --include="*.json" --include="*.ts" --include="*.js" --include="*.tsx" --include="*.html" --include="*.py" -l . \
  | grep -v node_modules \
  | grep -v "^./dist/" \
  | grep -v "opengateway\.gitlawb\.com" \
  | grep -v "gitlawb-opengateway\.ts"
```

Expected: empty output. If anything shows up, investigate whether it's `docs/superpowers/specs/2026-06-25-neocode-rebrand.md` (acceptable historical artifact) or a missed file (fix it).

- [ ] **Step 2: Run OpenClaude cosmetic grep**

```bash
grep -r -l "openClaude\|OpenClaude" --include="*.md" --include="*.yml" --include="*.yaml" --include="*.json" --include="*.html" . \
  | grep -v node_modules | grep -v "^./dist/"
```

Expected: empty output. If hits remain, inspect — this catches cosmetic branding that slipped through.

- [ ] **Step 3: Final report**

Report file-by-file counts of replacements and any residual hits (with rationale) to the user.

---

## Notes for agent

- When doing find/replace for URLs, prefer `replace_all: true` over iterating — but ONLY when the substitution is uniform. For README where casing/context may differ, edit with larger surrounding context to disambiguate.
- Do NOT open / edit / delete `/dist/cli.mjs`, `/dist/sdk.mjs`, sourcemaps. They're compiled output; re-running the bundler is a separate step out of scope.
- If a target file does not exist (e.g. `docs/integrations/overview.md` was just a guess), skip and move on.
- After each Edit, re-read the surrounding 10 lines to verify it landed correctly before moving on. Don't commit until the edit is confirmed.
