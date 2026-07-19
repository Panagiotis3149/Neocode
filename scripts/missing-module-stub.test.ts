import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { expect, test } from 'bun:test'
import { collectBundleStubs } from './stubMarkerGuard.js'

const REPO_ROOT = join(import.meta.dir, '..')
const DIST = join(REPO_ROOT, 'dist/cli.mjs')


test('/dream command is present in the CLI bundle', () => {
  if (!existsSync(DIST)) {
    throw new Error(
      'dist/cli.mjs not found — run `bun run build` before this test',
    )
  }

  const bundle = readFileSync(DIST, 'utf-8')

  expect(bundle).toContain('consolidating memories')
  expect(bundle).not.toMatch(
    /missing-module-stub:.*commands\/dream\/dream\.js/,
  )
})

// Regression for the WebFetch SSRF guard. WebFetchTool passes the real
// ssrfGuardedLookup (src/utils/hooks/ssrfGuard.ts) as its DNS `lookup`. A
// string-literal import of that module inside
// src/__tests__/security-hardening.test.ts previously registered the specifier
// as missing, and the specifier-keyed resolver then replaced WebFetch's real
// import with a noop in dist/cli.mjs — silently disabling SSRF protection. The
// source-level test only reads src/tools/WebFetchTool/utils.ts, so it cannot
// catch a bundle-only regression; assert against the shipped bundle instead.
test('WebFetch binds the real ssrfGuardedLookup in the CLI bundle', () => {
  if (!existsSync(DIST)) {
    throw new Error(
      'dist/cli.mjs not found — run `bun run build` before this test',
    )
  }

  const bundle = readFileSync(DIST, 'utf-8')

  // The real guard's distinctive blocked-address error must be bundled...
  expect(bundle).toContain('private/link-local address')
  // ...and ssrfGuard must not have been replaced by a missing-module stub.
  expect(bundle).not.toMatch(/missing-module-stub:.*ssrfGuard/)
})

// Exercises the shared collectBundleStubs() helper against the real, minified
// CLI bundle. The string-literal marker form survives minification, so every
// deliberately-stubbed module should surface in the canonical src-relative map.
test('collectBundleStubs surfaces the deliberately stubbed modules', () => {
  if (!existsSync(DIST)) {
    throw new Error(
      'dist/cli.mjs not found — run `bun run build` before this test',
    )
  }

  const bundle = readFileSync(DIST, 'utf-8')
  const stubs = collectBundleStubs(bundle)

  // The two known missing-module stubs in this build (do not exist on disk):
  // VerifyPlanExecutionTool/constants.ts and MonitorMcpDetailDialog.ts.
  // Markers are captured by raw text, so assert on count + that neither is the
  // ssrfGuard module (regression guard). Host path separators differ per OS,
  // so we match by distinctive basename substring rather than exact key.
  expect(stubs.size).toBeGreaterThanOrEqual(2)
  const markers = [...stubs.values()].join('\n')
  expect(markers).toMatch(/VerifyPlanExecutionTool[\\/]?constants/)
  expect(markers).toMatch(/MonitorMcpDetailDialog/)

  // ssrfGuard must NOT be flagged as a stub (regression guard).
  expect(markers).not.toMatch(/ssrfGuard/)
})
