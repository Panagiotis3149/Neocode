# /skid — "Skidding" Skill Design

**Date:** 2026-07-19
**Status:** Approved (design)

## Goal

Add a `/skid` command to Neocode that injects a skill ("skidding") instructing the
model to find an existing implementation from an external source, adapt it to this
project's conventions, paste it in, and verify it builds. The command takes no
arguments — the "what to skid" comes from the surrounding conversation context
(the user's latest request). It must also be available as `/skidding`.

## Source-gathering preference

When locating an implementation, the model prefers sources in this order:

1. **User-provided source** (best) — a local path, repo URL, or pasted code in the
   request. Use directly.
2. **WebFetch** of a known reference URL (preferred over WebSearch).
   - Recall `wonderland.ac` as a good archive for Minecraft-modding implementations.
3. **WebSearch** — only if no direct URL is known.
4. **`gh` CLI** (`gh search code`, `gh api`) — for GitHub when available and
   authorized.

## Workflow (the injected prompt)

The bundled-skill prompt instructs the model to:

1. **Understand the ask** from surrounding context — what feature or utility to
   obtain. `/skid` takes no args; the request is inferred from the current
   conversation.
2. **Locate an existing implementation** using the source-preference order above.
3. **Adapt-then-paste:** convert the found code to this project's conventions
   (imports, types, module style), then write it into the appropriate files. Do not
   drop in raw foreign code.
4. **Dependency / util check:** scan for similarly-named utilities already in the
   repo. If a found util differs from an existing one, paste the found version too —
   *but only if it makes sense* in context (avoid needless duplication).
5. **Verify:** run the project's build + typecheck (and tests if present). Iterate
   until it compiles. Match the repo's toolchain (e.g. `bun run build`,
   `npm run typecheck`) rather than assuming one.

## Error handling

- No source found after exhausting all tiers → report what was tried and ask the
  user for a URL or path.
- Found code cannot be adapted (incompatible language/runtime) → say so and stop;
  do not paste unusable code.
- Build fails after adaptation → fix compile/type errors; loop a bounded number of
  times before reporting remaining issues.

## Architecture & wiring

- New file `src/skills/bundled/skidding.ts`.
- Register via `registerBundledSkill({ name: 'skid', aliases: ['skidding'],
  description, getPromptForCommand })`. This mirrors `simplify` / `loop` / `debug`.
- `getPromptForCommand(): Promise<ContentBlockParam[]>` returns the workflow as text
  content blocks. It takes no `args` (zero-arg command).
- Register the import + call in `src/skills/bundled/index.ts`.
- Auto-surfaces as `/skid` and `/skidding`. The model may also self-invoke it as a
  skill.
- No new `src/commands/` directory is needed (bundled skills auto-register as slash
  commands via `aliases`).

## Testing

- A unit test (mirroring `simplify`/`loop` tests) that imports the skill, asserts:
  - `name === 'skid'`
  - `aliases` includes `'skidding'`
  - `description` is present and non-empty
  - `getPromptForCommand()` resolves to a non-empty `ContentBlockParam[]` containing
    the key workflow terms: `WebFetch`, `adapt`, `build`, `wonderland.ac`.

## Out of scope (YAGNI)

- Argument parsing / structured input (explicitly declined — no args).
- Interactive prompt mode (explicitly declined).
- Running the full test suite as a hard gate (build + typecheck only, per decision).
