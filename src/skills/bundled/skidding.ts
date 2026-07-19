import { registerBundledSkill } from '../bundledSkills.js'

const SKID_PROMPT = `# Skidding: Find an Existing Implementation and Adapt It

Obtain a working implementation of what the user is asking for from an external
source, adapt it to THIS project, paste it in, and verify it works. The user's
request is taken from the surrounding conversation context — you do not need an
explicit argument.

## Phase 1: Understand the Ask

Read the current conversation to determine what feature, module, or utility the
user wants. Identify the target language, framework, and where in this repo it
should live.

## Phase 2: Locate an Existing Implementation

Search for an existing implementation, preferring sources in this order:

1. **User-provided source (best)** — a local path, repo URL, or pasted code the
   user gave in the request. Use it directly.
2. **WebFetch of a known reference URL** (preferred over WebSearch). Fetch the
   raw file or documentation page and read it.
   - Recall \`wonderland.ac\` as a good archive for Minecraft-modding
     implementations.
3. **WebSearch** — only when no direct URL is known. Follow the best result with
   WebFetch to get the actual code.
4. **GitHub via the \`gh\` CLI** — \`gh search code\` / \`gh api\` when \`gh\` is
   available and authorized.

Do NOT invent code. If you cannot find a real implementation after trying all
tiers, stop and tell the user what you tried; ask them for a URL or path.

## Phase 3: Adapt-then-Paste

Convert the found code to this project's conventions — module style, import
paths, types/interfaces, naming, and error handling. Write it into the
appropriate files. Do not drop in raw foreign code that does not typecheck
against this repo.

## Phase 4: Dependency / Utility Check

Scan this repo for similarly-named utilities. If a found utility differs from an
existing one, paste the found version too — but ONLY if it makes sense in
context (avoid needless duplication). Explain when you choose to reuse the
existing version instead.

## Phase 5: Verify (In-Depth)

1. **Build + typecheck:** run this project's build/typecheck (e.g. \`bun run
   build\`, \`npm run typecheck\`). Match the repo's toolchain — do not assume.
   Iterate until it compiles.
2. **Read the pasted code back** and confirm functional equivalence with the
   source: it must produce the same output/behavior, and the logic must be done
   *the same way* (equivalent algorithm, control flow, and edge-case handling) —
   not merely something that compiles.
3. **Exercise observable output:** where the source had visible results (return
   values, side effects, rendered output), reason through or run that path in
   this project to confirm the pasted version matches. Flag any divergence and
   reconcile it; never leave a silent behavioral difference.

When done, summarize what you found, where you pasted it, and confirm it builds
and is behaviorally equivalent.
`

export function registerSkidSkill(): void {
  registerBundledSkill({
    name: 'skid',
    aliases: ['skidding'],
    description:
      'Find an existing implementation from an external source, adapt it to this project, paste it in, and verify it builds and is behaviorally equivalent.',
    userInvocable: true,
    async getPromptForCommand() {
      return [{ type: 'text', text: SKID_PROMPT }]
    },
  })
}
