import { describe, expect, test } from 'bun:test'

import {
  createAssistantMessage,
  createUserMessage,
  normalizeMessages,
  normalizeMessagesCached,
  type Message,
} from './messages.js'

let uuidCounter = 0
function withUuid<T extends Message>(message: T): T {
  uuidCounter += 1
  const hex = uuidCounter.toString(16).padStart(12, '0')
  return { ...message, uuid: `a1b2c3d4-0000-0000-0000-${hex}` as Message['uuid'] }
}

function assistant(...texts: string[]): Message {
  if (texts.length === 1) {
    return withUuid(createAssistantMessage({ content: texts[0] }))
  }
  return withUuid(
    createAssistantMessage({
      content: texts.map(text => ({ type: 'text' as const, text }) as never),
    }),
  )
}

function user(text: string): Message {
  return withUuid(createUserMessage({ content: text }) as Message)
}

// normalizeMessagesCached must be observably identical to normalizeMessages
// for every mutation pattern the REPL produces, while additionally preserving
// object identity for unchanged messages so downstream memo/WeakMap caches
// survive.
function expectEquivalent(messages: Message[]): void {
  expect(normalizeMessagesCached(messages)).toEqual(normalizeMessages(messages))
}

describe('normalizeMessagesCached', () => {
  test('matches normalizeMessages for single-block messages', () => {
    expectEquivalent([user('hi'), assistant('hello'), user('bye')])
  })

  test('matches across an isNewChain transition (multi-block message)', () => {
    expectEquivalent([
      user('q'),
      assistant('part one', 'part two'),
      user('follow up'),
      assistant('answer'),
    ])
  })

  test('matches when the chain flag is already set before a later message', () => {
    expectEquivalent([
      assistant('a', 'b', 'c'),
      user('next'),
      assistant('single'),
    ])
  })

  test('preserves object identity for unchanged messages on pure append', () => {
    // Reuse the SAME message object instances across calls so the WeakMap
    // cache can hit; new instances would be (correctly) re-normalized.
    const m1 = user('1')
    const m2 = assistant('two')
    const m3 = user('3')
    const first = normalizeMessagesCached([m1, m2])
    const second = normalizeMessagesCached([m1, m2, m3])
    // Shared prefix keeps the same object identities across calls.
    expect(second.slice(0, first.length)).toEqual(first)
    for (let i = 0; i < first.length; i++) {
      expect(second[i]).toBe(first[i])
    }
  })

  test('reuses the cached block when the entry flag is the same', () => {
    const t = assistant('two')
    const solo = normalizeMessagesCached([t]) // t seen with entryFlag=false
    const again = normalizeMessagesCached([t]) // same entryFlag=false -> cache hit
    expect(again[0]).toBe(solo[0])
  })

  test('re-normalizes when the same message is later seen with a different entry flag', () => {
    const a = assistant('p1', 'p2') // multi-block: sets isNewChain for what follows
    const t = assistant('two')
    // First pass: t comes after a multi-block message, so it is normalized
    // with entryFlag=true and cached under that key.
    const afterChain = normalizeMessagesCached([a, t])
    // Then the same t appears at the top (entryFlag=false). The cached block
    // was keyed under entryFlag=true, so it must be recomputed rather than
    // wrongly reused.
    const solo = normalizeMessagesCached([t])
    expect(solo[0]).not.toBe(afterChain[1])
    // And it must still equal a fresh normalize of the same message.
    expect(solo).toEqual(normalizeMessages([t]))
  })

  test('every block carries the chain-aware UUID that normalizeMessages produces', () => {
    const messages = [assistant('a', 'b'), user('c'), assistant('d')]
    const cached = normalizeMessagesCached(messages)
    const reference = normalizeMessages(messages)
    expect(cached.map(m => m.uuid)).toEqual(reference.map(m => m.uuid))
  })
})
