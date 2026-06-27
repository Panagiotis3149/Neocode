# Neocode Fork Cleanup — Strip gitlawb/OpenClaude Branding

Date: 2026-06-27
Status: Spec (approved)

## Goal

Clean up the forked-openclaude surface of the Neocode repo so it no longer reads like an OpenClaude/gitlawb product. Remove corporate-sounding marketing copy and dead/legacy links. Point the only live external reference at `https://github.com/Panagiotis3149/neocode`. Keep OpenGateway references in `src/integrations/gateways/gitlawb-opengateway.ts` (it's a real backend provider, not cosmetic branding) but strip the startup-default marketing push.

Constraints from user
- Scope: **cosmetic + nav only**. Don't touch functional API identifiers (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_OPENAI`, model IDs like `claude-3-5-sonnet`, file paths like `src/services/api/claude.ts`, env vars, generated `dist/` bundles).
- Don't break refactors — don't rename internal code symbols.
- Don't regenerate `dist/` (separate build step).

## Approach considered

1. **Surgical find/replace across .md/.yml/Dockerfile/package.json/vscode-ext/web** (recommended). Lowest-risk path; matches the "cosmetic + nav" scope.
2. **Re-run the OpenClaude → Neocode rebrand script** against the existing `2026-06-25-neocode-rebrand.md` spec. Rejected: that spec is *about* the rename itself, not this follow-up cleanup, and re-running it would churn files that are already correct.
3. **Nuclear rewrite of README/Dockerfile from scratch**. Rejected: higher risk of dropping useful content.

Going with #1.

## Files to edit

### `README.md`
- Strip the "fork of gitlawb/openclaude" opening line and the "Neocode originated from OpenClaude, which is derived from Anthropic's Claude Code" paragraph. Replace with a self-contained intro: "Neocode is an open-source coding-agent CLI derived from OpenClaude, derived from Anthropic's Claude Code."
- Replace `https://github.com/gitlawb/openclaude` and any related GitHub URL with `https://github.com/Panagiotis3149/neocode`.
- Replace Discord/social links that were inherited from gitlawb with the fork's own community links, or remove them if no replacement exists.
- Strip the "Blog", "Enterprise", "Case Studies", and other corporate marketing sections (PR #3 parody section).
- Update the contributor guide link to point at `Panagiotis3149/neocode/contributing`.
- Update preview/neocode.dev links to point at the fork or remove.

### `PLAYBOOK.md`
- Remove 500+ line "About" / "FAQ" / "Community / social" sections. Keep only the practical "Daily Start / Setup / Health" sections that describe the software (those copy sections are generic and useful).
- Strip any gitlawb/Discord references.

### `LICENSE`
- Rewrite to a clean MIT license. Copyright line: `Copyright (c) 2026 Panagiotis3149`.
- Keep the "derived from OpenClaude (Apache-2.0 / MIT), derived from Anthropic's Claude Code" attribution paragraph in NOTICE style.
- Drop "This repository is a fork of gitlawb/openclaude" language.

### `Dockerfile`
- Replace `LABEL maintainer=...` if it has gitlawb placeholder.
- Replace `ENV GITHUB_REPO=...` if present.
- Any `COPY README.md .` line stays, but the file it copies is the cleaned one.
- Strip any comments referencing gitlawb/openclaude upstream.

### `.github/workflows/release.yml`
- Should already be referencing `Panagiotis3149/neocode`. Verify; if not, update.
- Strip any `gitlawb/opengateway` reference that's a branding statement (not a sampling point).

### `.github/ISSUE_TEMPLATE/*.md` and `pull_request_template.md`
- Replace `gitlawb/openclaude` with `Panagiotis3149/neocode`.
- Remove "This issue is for the upstream repo / file issues at gitlawb/openclaude" text if present.

### `vscode-extension/neocode-vscode/src/extension.js`
- Replace `NEOCODE_REPO_URL` value (`https://github.com/Gitlawb/neocode`) with `https://github.com/Panagiotis3149/neocode`.
- Replace `NEOCODE_SETUP_URL` value with `https://github.com/Panagiotis3149/neocode/blob/main/README.md#quick-start`.

### `vscode-extension/neocode-vscode/README.md`
- Replace `npm install -g @gitlawb/neocode@latest` → `npm install -g @Panagiotis3149/neocode@latest`.
- Replace GitHub link `https://github.com/gitlawb/openclaude` → `https://github.com/Panagiotis3149/neocode`.
- Strip Discord links or replace with fork's channel if it exists.

### `docs/*.md` (advanced-setup, quick-start-windows, quick-start-mac-linux)
- Replace `@gitlawb/neocode` → `@Panagiotis3149/neocode` (npm package name).
- Replace `gitlawb.com/...` marketing links with `github.com/Panagiotis3149/neocode`.
- Keep `opengateway.gitlawb.com` URL in `docs/advanced-setup.md` lines 219/225 — it's a real base URL, not cosmetic.

### `docs/superpowers/specs/2026-06-25-neocode-rebrand.md`
- Leave untouched. It's the historical spec for the rebrand itself; rewriting it would rewrite history.

### `web/` (index.html, App.tsx, content.ts)
- Replace GitHub link `https://github.com/gitlawb/openclaude` → `https://github.com/Panagiotis3149/neocode`.
- Strip any "Neocode by gitlawb" / "A gitlawb project" copy.
- Update domain if claimed (e.g. `openclaude.dev` → user choice; or drop for now).

### `package.json`
- Already has `repo.url = https://github.com/Panagiotis3149/neocode.git` and name `@panagiotis3149/neocode`. Verify author/maintainer fields don't still say `gitlawb`. Clean if so.

### CLAUDE.md → NEOCODE.md
- The existing `CLAUDE.md` file (root of project) contains a long Fork-instructions file that
  originates from the upstream README's "Forking Claude Code: a pain guide" section. Rewrite it
  as `NEOCODE.md` and delete `CLAUDE.md`. Strip references to gitlawb, including the
  attribution line "This repo = fork of gitlawb/openclaude, which is itself a fork of
  Anthropic's Claude Code." Replace "Gitlawb" → "Panagiotis3149". Keep the practical forking
  guide (how to sync upstream, build, etc.) — the section is useful operational guidance.

### `src/integrations/gateways/gitlawb-opengateway.ts`
- **Leave as-is.** The user explicitly said: save mentions of gitlawb in opengateway. This is a backend integration name and the base URL `opengateway.gitlawb.com` is still the live endpoint.

### `src/`
- Per scope, **do not touch**. Generated `dist/cli.mjs`, `dist/sdk.mjs` etc. contain hundreds of strings like `OpenClaude`, `https://github.com/gitlawb/openclaude`, etc. Rebuilding is a separate step. Out of scope.

### `scripts/verify-no-phone-home.ts` and `scripts/verify-no-telemetry.ts`
- Read but don't change. These may reference upstream URLs for comparison purposes.

## Explicitly out of scope (DO NOT TOUCH)

- `src/services/api/claude.ts` and other API client code (`CLAUDE_CODE_USE_OPENAI` etc. are functional env vars).
- `src/services/api/withRetry.ts` (references Claude for API reasons).
- `dist/cli.mjs`, `dist/sdk.mjs`, sourcemaps.
- Model ID constants in source.
- Test fixtures that assert on strings produced by source code (these would break).
- `scripts/no-telemetry-plugin.ts` and similar runtime checks.

## Verification

After changes, run:

```bash
grep -r gitlawb --include="*.md" --include="*.yml" --include="*.yaml" --include="*.json" --include="*.ts" --include="*.js" --include="*.tsx" --include="*.html" --include="*.py" -l . \
  | grep -v node_modules \
  | grep -v "^./dist/" \
  | grep -v "opengateway\.gitlawb\.com" \
  | grep -v "gitlawb-opengateway\.ts"
```

Expected: empty. (Any residual hits in `docs/superpowers/specs/2026-06-25-neocode-rebrand.md` are historical and acceptable.)

```bash
grep -rcl "openClaude\|OpenClaude" --include="*.md" --include="*.yml" --include="*.yaml" --include="*.json" --include="*.html" . \
  | grep -v node_modules | grep -v "^./dist/"
```

Expected: empty after cleanup of `.md`/`.yml`/`.html`.

## Transition to implementation

Pending user approval of this spec, invoke `superpowers:writing-plans` to break this into an ordered, verifiable implementation plan.
