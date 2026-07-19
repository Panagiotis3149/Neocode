import { describe, expect, test } from 'bun:test'

import { decideStreamingTextUpdate } from './streamingTextPublish.js'

const append = (delta: string) => (current: string | null) =>
  (current ?? '') + delta

// Drive a sequence of deltas through the decision the way REPL's onStreamingText
// does: keep `ref` (full accumulated text) and `lastVisible` (last published
// preview), recording each publish.
function runDeltas(
  deltas: Array<(current: string | null) => string | null>,
  lastVisible: string | null,
) {
  let ref: string | null = null
  let lv = lastVisible
  const published: Array<string | null> = []
  for (const apply of deltas) {
    ref = apply(ref)
    const next = decideStreamingTextUpdate(ref, lv)
    if (next !== null) {
      lv = next
      published.push(next)
    }
  }
  return { ref, published }
}

describe('decideStreamingTextUpdate', () => {
  test('null full text publishes nothing', () => {
    expect(decideStreamingTextUpdate(null, 'anything')).toBeNull()
  })

  test('empty full text resets a previously-published preview', () => {
    expect(decideStreamingTextUpdate('', 'line1\n')).toBe('')
  })

  test('only newline-completing deltas publish', () => {
    const { ref, published } = runDeltas(
      [
        append('Hel'),
        append('lo'),
        append(' world\n'),
        append('next part'),
        append(' done\n'),
      ],
      null,
    )
    expect(ref).toBe('Hello world\nnext part done\n')
    expect(published).toEqual([
      'Hello world\n',
      'Hello world\nnext part done\n',
    ])
  })

  test('trailing partial line is suppressed until its newline arrives', () => {
    const { ref, published } = runDeltas(
      [append('partial line with no newline yet')],
      null,
    )
    expect(ref).toBe('partial line with no newline yet')
    // Nothing published: no complete line to show.
    expect(published).toEqual([])
  })

  test('republishing an unchanged published range is a no-op', () => {
    expect(decideStreamingTextUpdate('done\n', 'done\n')).toBeNull()
  })
})
