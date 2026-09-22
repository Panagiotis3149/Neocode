import { describe, expect, test } from 'bun:test'

import {
  canonicalize,
  hmacScoped,
  scopedHmacSha256,
  sha256ExactBytes,
  sha256Canonical,
} from './canonical.js'

describe('memory V2 canonical values', () => {
  test('normalizes NFC and line endings and serializes integers as decimal strings', () => {
    const value = canonicalize({
      text: 'e\u0301\r\nnext\rline',
      count: 12,
      epoch: 13n,
    })

    expect(value).toBe('{"count":"12","epoch":"13","text":"é\\nnext\\nline"}')
  })

  test('canonical object key order is stable regardless of insertion order', () => {
    expect(canonicalize({ z: 'last', a: 'first' })).toBe(
      canonicalize({ a: 'first', z: 'last' }),
    )
  })

  test('rejects unsupported and unsafe values', () => {
    expect(() => canonicalize({ value: undefined })).toThrow('Unsupported canonical value')
    expect(() => canonicalize({ value: Number.NaN })).toThrow('Unsupported canonical value')
    expect(() => canonicalize(new Date())).toThrow('Unsupported canonical value')
  })

  test('rejects sparse arrays instead of silently changing their meaning', () => {
    const sparse = [] as string[]
    sparse.length = 1

    expect(() => canonicalize(sparse)).toThrow('Sparse canonical array')
  })

  test('provides exact-byte SHA-256 and scoped HMAC helpers', () => {
    const bytes = new TextEncoder().encode('payload')
    expect(sha256ExactBytes(bytes)).toBe(
      '239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5',
    )
    expect(sha256Canonical({ value: 1 })).toBe(sha256Canonical({ value: 1n }))
    expect(hmacScoped('project-a', 'scope-key', { value: 'payload' })).toMatch(/^[0-9a-f]{64}$/)
  })

  test('binds scoped HMACs to a required nonempty domain', () => {
    const first = scopedHmacSha256('project-a', 'scope-key', { value: 'payload' })
    const second = scopedHmacSha256('project-b', 'scope-key', { value: 'payload' })

    expect(first).not.toBe(second)
    expect(() => scopedHmacSha256('', 'scope-key', { value: 'payload' })).toThrow(
      'HMAC scope must be nonempty',
    )
  })
})
