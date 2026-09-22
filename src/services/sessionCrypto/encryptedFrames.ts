import { createCipheriv, createDecipheriv } from 'node:crypto'

import { canonicalizeBytes } from '../memoryV2/canonical.js'

export const AES_256_GCM = 'aes-256-gcm' as const
export const GCM_NONCE_BYTES = 12
export const GCM_TAG_BYTES = 16
export const DEFAULT_MAX_PLAINTEXT_BYTES = 4 * 1024 * 1024
export const DEFAULT_MAX_ENVELOPE_BYTES = 8 * 1024 * 1024

const MAX_UINT64 = 0xffffffffffffffffn

export type EncryptedFrameMetadataInput = {
  formatVersion: 'session-frame-v1'
  sessionId: string
  projectScopeId: string
  keyEpoch: string
  keyId: string
  artifactKind: string
  artifactId: string
  contentEncoding: 'binary' | 'utf8'
  timestamp: string
}

export type EncryptedFrameMetadata = EncryptedFrameMetadataInput & {
  byteLength: string
  nonceCounter: string
}

export type EncryptedFrame = {
  formatVersion: 'encrypted-session-frame-v1'
  algorithm: typeof AES_256_GCM
  metadata: EncryptedFrameMetadata
  nonce: Uint8Array
  ciphertext: Uint8Array
  tag: Uint8Array
}

function assertKey(key: Uint8Array): void {
  if (key.byteLength !== 32) throw new TypeError('AES-256 key must be 32 bytes')
}

function assertCanonicalDecimal(value: string, field: string): void {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError(`frame metadata ${field} must be a canonical decimal`)
}

function assertMetadata(metadata: EncryptedFrameMetadataInput | EncryptedFrameMetadata): void {
  for (const [field, value] of Object.entries(metadata)) {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`frame metadata ${field} must be nonempty`)
  }
  if (metadata.formatVersion !== 'session-frame-v1') throw new TypeError('unsupported frame metadata version')
  if (metadata.contentEncoding !== 'binary' && metadata.contentEncoding !== 'utf8') throw new TypeError('unsupported frame content encoding')
  assertCanonicalDecimal(metadata.keyEpoch, 'keyEpoch')
  assertCanonicalDecimal(metadata.timestamp, 'timestamp')
  if ('byteLength' in metadata) assertCanonicalDecimal(metadata.byteLength, 'byteLength')
  if ('nonceCounter' in metadata) assertCanonicalDecimal(metadata.nonceCounter, 'nonceCounter')
}

function assertCounter(counter: bigint): void {
  if (counter < 0n || counter > MAX_UINT64) throw new RangeError('nonce counter must fit uint64')
}

function bytesToBase64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

function base64ToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'))
}

function envelopeByteLength(frame: EncryptedFrame): number {
  return new TextEncoder().encode(
    JSON.stringify({
      formatVersion: frame.formatVersion,
      algorithm: frame.algorithm,
      metadata: frame.metadata,
      nonce: bytesToBase64(frame.nonce),
      ciphertext: bytesToBase64(frame.ciphertext),
      tag: bytesToBase64(frame.tag),
    }),
  ).byteLength
}

export function makeNonce(noncePrefix32: Uint8Array, nonceCounter: bigint): Uint8Array {
  if (noncePrefix32.byteLength !== 4) throw new TypeError('nonce prefix must be 4 bytes')
  assertCounter(nonceCounter)
  const nonce = new Uint8Array(GCM_NONCE_BYTES)
  nonce.set(noncePrefix32)
  new DataView(nonce.buffer).setBigUint64(4, nonceCounter, false)
  return nonce
}

export function encryptEncryptedFrame(input: {
  key: Uint8Array
  noncePrefix32: Uint8Array
  nonceCounter: bigint
  metadata: EncryptedFrameMetadataInput
  plaintext: Uint8Array
  maxPlaintextBytes?: number
  maxEnvelopeBytes?: number
}): EncryptedFrame {
  assertKey(input.key)
  assertMetadata(input.metadata)
  const maxPlaintextBytes = input.maxPlaintextBytes ?? DEFAULT_MAX_PLAINTEXT_BYTES
  const maxEnvelopeBytes = input.maxEnvelopeBytes ?? DEFAULT_MAX_ENVELOPE_BYTES
  if (input.plaintext.byteLength > maxPlaintextBytes) throw new RangeError('frame plaintext exceeds limit')
  const nonce = makeNonce(input.noncePrefix32, input.nonceCounter)
  const metadata: EncryptedFrameMetadata = {
    ...input.metadata,
    byteLength: input.plaintext.byteLength.toString(10),
    nonceCounter: input.nonceCounter.toString(10),
  }
  const aad = canonicalizeBytes(metadata)
  const cipher = createCipheriv(AES_256_GCM, Buffer.from(input.key), Buffer.from(nonce), { authTagLength: GCM_TAG_BYTES })
  cipher.setAAD(Buffer.from(aad), { plaintextLength: input.plaintext.byteLength })
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(input.plaintext)), cipher.final()])
  const tag = cipher.getAuthTag()
  if (tag.byteLength !== GCM_TAG_BYTES) throw new Error('unexpected GCM authentication tag length')
  const frame: EncryptedFrame = {
    formatVersion: 'encrypted-session-frame-v1',
    algorithm: AES_256_GCM,
    metadata,
    nonce,
    ciphertext: new Uint8Array(ciphertext),
    tag: new Uint8Array(tag),
  }
  if (envelopeByteLength(frame) > maxEnvelopeBytes) throw new RangeError('encrypted frame exceeds limit')
  return frame
}

export function decryptEncryptedFrame(input: { key: Uint8Array; frame: EncryptedFrame; maxPlaintextBytes?: number; maxEnvelopeBytes?: number }): Uint8Array {
  assertKey(input.key)
  const frame = input.frame
  if (frame.formatVersion !== 'encrypted-session-frame-v1') throw new TypeError('unsupported encrypted frame version')
  if (frame.algorithm !== AES_256_GCM) throw new TypeError('unsupported encrypted frame algorithm')
  assertMetadata(frame.metadata)
  if (frame.nonce.byteLength !== GCM_NONCE_BYTES) throw new TypeError('encrypted frame nonce must be 96 bits')
  if (frame.tag.byteLength !== GCM_TAG_BYTES) throw new TypeError('encrypted frame must use a 128-bit GCM tag')
  const maxEnvelopeBytes = input.maxEnvelopeBytes ?? DEFAULT_MAX_ENVELOPE_BYTES
  if (envelopeByteLength(frame) > maxEnvelopeBytes) throw new RangeError('encrypted frame exceeds limit')
  const expectedCounter = BigInt(frame.metadata.nonceCounter)
  if (expectedCounter < 0n || expectedCounter > MAX_UINT64 || expectedCounter.toString(10) !== frame.metadata.nonceCounter) {
    throw new TypeError('invalid frame nonce counter')
  }
  const expectedLength = Number(frame.metadata.byteLength)
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) throw new TypeError('invalid frame byte length')
  if (expectedLength > (input.maxPlaintextBytes ?? DEFAULT_MAX_PLAINTEXT_BYTES)) throw new RangeError('frame plaintext exceeds limit')
  const aad = canonicalizeBytes(frame.metadata)
  try {
    const decipher = createDecipheriv(AES_256_GCM, Buffer.from(input.key), Buffer.from(frame.nonce), { authTagLength: GCM_TAG_BYTES })
    decipher.setAAD(Buffer.from(aad), { plaintextLength: frame.ciphertext.byteLength })
    decipher.setAuthTag(Buffer.from(frame.tag))
    const plaintext = Buffer.concat([decipher.update(Buffer.from(frame.ciphertext)), decipher.final()])
    if (plaintext.byteLength !== expectedLength) throw new Error('frame plaintext length mismatch')
    return new Uint8Array(plaintext)
  } catch {
    throw new Error('encrypted frame authentication failed')
  }
}

export function serializeEncryptedFrame(frame: EncryptedFrame): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      formatVersion: frame.formatVersion,
      algorithm: frame.algorithm,
      metadata: frame.metadata,
      nonce: bytesToBase64(frame.nonce),
      ciphertext: bytesToBase64(frame.ciphertext),
      tag: bytesToBase64(frame.tag),
    }),
  )
}

export function deserializeEncryptedFrame(bytes: Uint8Array): EncryptedFrame {
  const value = JSON.parse(new TextDecoder().decode(bytes)) as {
    formatVersion: EncryptedFrame['formatVersion']
    algorithm: EncryptedFrame['algorithm']
    metadata: EncryptedFrameMetadata
    nonce: string
    ciphertext: string
    tag: string
  }
  return {
    formatVersion: value.formatVersion,
    algorithm: value.algorithm,
    metadata: value.metadata,
    nonce: base64ToBytes(value.nonce),
    ciphertext: base64ToBytes(value.ciphertext),
    tag: base64ToBytes(value.tag),
  }
}
