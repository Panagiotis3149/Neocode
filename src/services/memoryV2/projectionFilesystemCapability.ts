export type ProjectionLeaseFence = {
  readonly path: string
  readonly owner: string
  readonly token: string
  readonly generation: number
  readonly expiresAt: number
}

export type ProjectionFilesystemMutation =
  | { status: 'created' }
  | { status: 'updated' }
  | { status: 'deleted' }
  | { status: 'conflict'; currentText?: string }
  | { status: 'fenced' }

export type ProjectionFilesystemAdapter = {
  readText(path: string): string | null
  createIfAbsent(path: string, text: string, fence: ProjectionLeaseFence): ProjectionFilesystemMutation
  replaceIfUnchanged(path: string, expectedBytes: string, expectedHash: string, fence: ProjectionLeaseFence, replacement: string): ProjectionFilesystemMutation
  deleteIfUnchanged(path: string, expectedBytes: string, expectedHash: string, fence: ProjectionLeaseFence): ProjectionFilesystemMutation
}

const projectionFilesystemBrand = Symbol('projectionFilesystemBrand')
export const projectionFilesystemOption = Symbol('projectionFilesystemOption')

export type ProjectionFilesystem = ProjectionFilesystemAdapter & { readonly [projectionFilesystemBrand]: true }

export function createVerifiedProjectionFilesystem(adapter: ProjectionFilesystemAdapter): ProjectionFilesystem {
  if (
    !adapter ||
    typeof adapter.readText !== 'function' ||
    typeof adapter.createIfAbsent !== 'function' ||
    typeof adapter.replaceIfUnchanged !== 'function' ||
    typeof adapter.deleteIfUnchanged !== 'function'
  ) throw new TypeError('A complete projection filesystem adapter is required')
  return Object.freeze({ ...adapter, [projectionFilesystemBrand]: true }) as ProjectionFilesystem
}

export function isVerifiedProjectionFilesystem(value: unknown): value is ProjectionFilesystem {
  return Boolean(value && typeof value === 'object' && (value as Record<PropertyKey, unknown>)[projectionFilesystemBrand] === true)
}
