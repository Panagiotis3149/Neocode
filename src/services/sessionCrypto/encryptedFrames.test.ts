import { describe, expect, test } from 'bun:test'

import {
  AES_256_GCM,
  decryptEncryptedFrame,
  encryptEncryptedFrame,
  makeNonce,
  type EncryptedFrameMetadataInput,
} from './encryptedFrames.js'

const key = new Uint8Array(32).fill(7)
const noncePrefix32 = new Uint8Array([1, 2, 3, 4])

function metadata(overrides: Partial<EncryptedFrameMetadataInput> = {}): EncryptedFrameMetadataInput {
  return {
    formatVersion: 'session-frame-v1',
    sessionId: 'session-1',
    projectScopeId: 'project-1',
    keyEpoch: '3',
    keyId: 'key-3',
    artifactKind: 'raw-transcript',
    artifactId: 'artifact-1',
    contentEncoding: 'utf8',
    timestamp: '1700000000000',
    ...overrides,
  }
}

describe('encrypted session frames', () => {
  test('constructs a 96-bit nonce from a 32-bit prefix and 64-bit counter', () => {
    expect([...makeNonce(noncePrefix32, 9n)]).toEqual([1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 9])
  })

  test('encrypts and decrypts with a full 128-bit GCM tag', () => {
    const frame = encryptEncryptedFrame({
      key,
      noncePrefix32,
      nonceCounter: 9n,
      metadata: metadata(),
      plaintext: new TextEncoder().encode('hello'),
    })

    expect(frame.algorithm).toBe(AES_256_GCM)
    expect(frame.tag.length).toBe(16)
    expect(decryptEncryptedFrame({ key, frame })).toEqual(new TextEncoder().encode('hello'))
  })

  test('rejects altered authenticated metadata', () => {
    const frame = encryptEncryptedFrame({
      key,
      noncePrefix32,
      nonceCounter: 9n,
      metadata: metadata(),
      plaintext: new Uint8Array([1, 2, 3]),
    })

    expect(() => decryptEncryptedFrame({ key, frame: { ...frame, metadata: { ...frame.metadata, projectScopeId: 'other' } } })).toThrow(
      'authentication failed',
    )
  })

  test('rejects frames beyond the configured plaintext limit', () => {
    expect(() =>
      encryptEncryptedFrame({
        key,
        noncePrefix32,
        nonceCounter: 0n,
        metadata: metadata(),
        plaintext: new Uint8Array(5),
        maxPlaintextBytes: 4,
      }),
    ).toThrow('frame plaintext exceeds limit')
  })

  test('rejects malformed key, nonce, and tag sizes', () => {
    expect(() => encryptEncryptedFrame({ key: new Uint8Array(31), noncePrefix32, nonceCounter: 0n, metadata: metadata(), plaintext: new Uint8Array() })).toThrow(
      'AES-256 key must be 32 bytes',
    )
    expect(() => makeNonce(new Uint8Array(3), 0n)).toThrow('nonce prefix must be 4 bytes')
    const frame = encryptEncryptedFrame({ key, noncePrefix32, nonceCounter: 0n, metadata: metadata(), plaintext: new Uint8Array() })
    expect(() => decryptEncryptedFrame({ key, frame: { ...frame, tag: frame.tag.subarray(0, 15) } })).toThrow('128-bit GCM tag')
  })

  test('requires canonical decimal strings for integer-bound metadata', () => {
    expect(() => encryptEncryptedFrame({ key, noncePrefix32, nonceCounter: 0n, metadata: metadata({ keyEpoch: '03' }), plaintext: new Uint8Array() })).toThrow(
      'canonical decimal',
    )
    const frame = encryptEncryptedFrame({ key, noncePrefix32, nonceCounter: 0n, metadata: metadata(), plaintext: new Uint8Array() })
    expect(() => decryptEncryptedFrame({ key, frame: { ...frame, metadata: { ...frame.metadata, timestamp: '0001' } } })).toThrow('canonical decimal')
  })
})
