/**
 * Decide whether a streaming-text delta should be published to React state.
 *
 * The streaming assistant text arrives from the API as a continuous
 * whitespace-bearing delta (it is NOT pre-split on newlines — the SDK emits a
 * single delta for a multi-line assistant message). Each delta used to be
 * passed straight to setState, which on very fast stream (e.g. 200ms to paint
 * three lines) over-rendered per character. We instead keep the full text in a
 * ref (so callers like the Esc handler can still read the complete partial
 * text) and only publish up to the last completed newline to React, so Ink
 * repaints line-by-line rather than character-by-character.
 *
 * @param fullText             The complete accumulated streaming text (ref value).
 * @param prevPublishedText    What we last pushed to React state (or null).
 * @returns The text to set in React state, or null to publish nothing (no-op).
 */
export function decideStreamingTextUpdate(
  fullText: string | null,
  prevPublishedText: string | null,
): string | null {
  if (fullText == null) return null
  if (fullText === '') return prevPublishedText !== '' ? '' : null

  const lastNewline = fullText.lastIndexOf('\n')
  if (lastNewline === -1) {
    // No complete line yet — publish nothing so we don't repaint per char.
    return null
  }

  const published = fullText.substring(0, lastNewline + 1)
  // Re-publish only when the published line range actually changed.
  if (published === prevPublishedText) return null
  return published
}
