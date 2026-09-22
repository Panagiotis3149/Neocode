import { createHash, createHmac } from 'node:crypto'

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue }

function normalizeString(value: string): string {
  return value.replace(/\r\n?/g, '\n').normalize('NFC')
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function serializeValue(value: unknown): string {
  if (value === null) return 'null'

  if (typeof value === 'string') return JSON.stringify(normalizeString(value))
  if (typeof value === 'boolean') return value ? 'true' : 'false'

  if (typeof value === 'bigint') {
    return JSON.stringify(value.toString(10))
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Unsupported canonical value: non-finite number')
    }
    if (Number.isInteger(value)) {
      if (!Number.isSafeInteger(value)) {
        throw new TypeError('Unsupported canonical value: unsafe integer')
      }
      return JSON.stringify(value.toString(10))
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError('Sparse canonical array')
      }
    }
    return `[${value.map(item => serializeValue(item)).join(',')}]`
  }

  if (typeof value === 'object') {
    if (!isPlainObject(value)) {
      throw new TypeError('Unsupported canonical value: non-plain object')
    }

    const entries = new Map<string, string>()
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new TypeError('Unsupported canonical value: symbol key')
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) {
        throw new TypeError('Unsupported canonical value: accessor property')
      }
      const normalizedKey = normalizeString(key)
      if (entries.has(normalizedKey)) {
        throw new TypeError('Unsupported canonical value: duplicate normalized key')
      }
      entries.set(normalizedKey, serializeValue(descriptor.value))
    }

    return `{${[...entries.keys()]
      .sort()
      .map(key => `${JSON.stringify(key)}:${entries.get(key)}`)
      .join(',')}}`
  }

  throw new TypeError(`Unsupported canonical value: ${typeof value}`)
}

export function canonicalize(value: unknown): string {
  return serializeValue(value)
}

export function canonicalizeBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value))
}

function asBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value
}

export function sha256ExactBytes(value: string | Uint8Array): string {
  return createHash('sha256').update(asBytes(value)).digest('hex')
}

export function sha256Canonical(value: unknown): string {
  return sha256ExactBytes(canonicalizeBytes(value))
}

export function scopedHmacSha256(
  scope: string,
  key: string | Uint8Array,
  value: unknown,
): string {
  const normalizedScope = normalizeString(scope)
  if (normalizedScope.length === 0) {
    throw new TypeError('HMAC scope must be nonempty')
  }
  const scopeBytes = new TextEncoder().encode(normalizedScope)
  const scopeLength = new Uint8Array(4)
  new DataView(scopeLength.buffer).setUint32(0, scopeBytes.length)

  return createHmac('sha256', asBytes(key))
    .update(new TextEncoder().encode('neocode-memory-v2-scoped-hmac-v1'))
    .update(scopeLength)
    .update(scopeBytes)
    .update(canonicalizeBytes(value))
    .digest('hex')
}

export const sha256NfcLfJcs = sha256Canonical
export const hmacScoped = scopedHmacSha256
export const hmacSha256Scoped = scopedHmacSha256
