/**
 * Branded type for system prompt arrays.
 *
 * This module is intentionally dependency-free so it can be imported
 * from anywhere without risking circular initialization issues.
 */

export type SystemPrompt = readonly string[] & {
  readonly __brand: 'SystemPrompt'
}

type SystemPromptMetadataResolver = (value: readonly string[]) => unknown
let systemPromptMetadataResolver: SystemPromptMetadataResolver | null = null
const systemPromptMetadata = new WeakMap<readonly string[], unknown>()

export function configureSystemPromptMetadataResolver(
  resolver: SystemPromptMetadataResolver | null,
): void {
  systemPromptMetadataResolver = resolver
}

export function getSystemPromptMetadata(value: readonly string[]): unknown {
  return systemPromptMetadata.get(value)
}

export function setSystemPromptMetadata(
  value: readonly string[],
  metadata: unknown,
): SystemPrompt {
  const result = value as SystemPrompt
  systemPromptMetadata.set(result, metadata)
  return result
}

export function inheritSystemPromptMetadata(
  value: readonly string[],
  source: readonly string[],
): SystemPrompt {
  const metadata = systemPromptMetadata.get(source)
  if (metadata !== undefined && metadata !== null) {
    systemPromptMetadata.set(value, metadata)
  }
  return value as SystemPrompt
}

export function asSystemPrompt(value: readonly string[]): SystemPrompt {
  const result = value as SystemPrompt
  const metadata = systemPromptMetadataResolver?.(value)
  if (metadata !== undefined && metadata !== null) systemPromptMetadata.set(result, metadata)
  return result
}
