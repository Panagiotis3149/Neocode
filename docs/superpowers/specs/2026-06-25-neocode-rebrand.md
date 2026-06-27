# Neocode Rebrand — Full Product Rename

**Date:** 2026-06-25
**Status:** Approved

## Goal

Rename every reference to the product formerly known as "OpenClaude" (and its case variants) and "Claude Code" to "Neocode" across the entire project — except API/external identifiers that cannot change.

## What we preserve (no changes)

- Anthropic API identifiers: `claude-opus-4-6`, `claude-sonnet-4-20250514`, model IDs, `api.anthropic.com`
- External URLs: `claude.ai`, `claude.com/claude-code` (product pages on Anthropic's site)
- Git history / commit messages
- `node_modules/` and `dist/` (rebuild artifacts)

## Replacement rules

| Original | Replacement |
|----------|-------------|
| `OpenClaude` | `Neocode` |
| `openclaude` | `neocode` |
| `OPENCLAUDE` | `NEOCODE` |
| `openClaude` | `neoCode` |
| `Claude Code` | `Neocode` |
| `claude-code` (in file/dir names) | `neocode` |
| `claude_code` | `neocode` |

## Settings backward-compatibility

When loading any persisted settings file:

1. Accept both key formats on read — `openclaude` and `neocode` keys load interchangeably.
2. On write/save, always use `neocode` keys. Strip the old `openclaude` keys from saved output.
3. Files stored at `.openclaude/` are transparently migrated: read from old path, re-save at `.neocode/`.

## Out of scope (not renamed)

- Anthropic model IDs, API endpoints
- `claude.ai`, `anthropic.com` URLs
- Git commit history
- Third-party dependency names inside `node_modules`

## Implementation parts (one subagent each)

1. **Root config & dotfiles** — `package.json`, `Dockerfile`, `.env.example`, `tsconfig*.json`, `.coderabbit.yaml`, `release-please-config.json`, `.release-please-manifest.json`, `bun.lock` (package name); rename `.openclaude/` → `.neocode/`; rename `bin/openclaude` → `bin/neocode`
2. **Source code bulk rename** — all `src/` files: `product.ts`, `prompts.ts`, `systemPromptSections.ts`, `config.ts`, components, bridge, cli, commands, services, utils, tests
3. **Scripts & Python** — `scripts/*.ts`, `python/*.py`
4. **Docs & root markdown** — `README.md`, `CONTRIBUTING.md`, `LICENSE`, `PLAYBOOK.md`, `SECURITY.md`, `CHANGELOG.md`, `ANDROID_INSTALL.md`, `docs/**`
5. **Settings shim & verification** — implement read-both/write-new settings loader, migrate `.openclaude/settings.local.json` → `.neocode/settings.local.json`; final grep for residual hits
