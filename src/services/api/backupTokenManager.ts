import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js';
import type { APIError } from '@anthropic-ai/sdk'
import { logEvent } from '../analytics/index.js'

/**
 * Classifies a 429 rate-limit error into one of three categories:
 *
 * - 'key'       → per-API-key limit (tokens / requests / concurrent). Rotating
 *                  to another key will help. These are identified by the
 *                  `anthropic-ratelimit-type` header being `tokens`, `requests`,
 *                  or `concurrent`.
 * - 'model'     → model-level upstream limit. The model instance is overloaded
 *                  or temporarily unavailable. Rotating keys will NOT help.
 *                  Identified by the `anthropic-ratelimit-type` header being
 *                  `model` or `overloaded', or by message-string heuristics
 *                  ("temporarily limited", "model is temporarily", etc.).
 * - 'unknown'   → could not be determined. Treat conservatively as 'key' so
 *                  rotation still fires (existing behavior).
 */
export type RateLimitCategory = 'key' | 'model' | 'unknown'

export function classifyRateLimit(error: APIError | { headers?: Headers | null; message?: string }): RateLimitCategory {
  const headers = (error as APIError)?.headers ?? null
  const message = (error as { message?: string })?.message ?? ''

  const limitType = headers?.get('anthropic-ratelimit-type')
  if (limitType) {
    const t = limitType.toLowerCase()
    if (t === 'tokens' || t === 'requests' || t === 'concurrent') return 'key'
    if (t === 'model' || t === 'overloaded') return 'model'
  }

  const msg = message.toLowerCase()
  if (
    msg.includes('temporarily limited') ||
    msg.includes('model is temporarily') ||
    msg.includes('model temporarily') ||
    msg.includes('upstream') ||
    msg.includes('overloaded') ||
    msg.includes('capacity')
  ) {
    return 'model'
  }

  if (
    msg.includes('daily') ||
    msg.includes('monthly') ||
    msg.includes('weekly') ||
    msg.includes('yearly') ||
    msg.includes('token limit') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('quota')
  ) {
    return 'key'
  }

  return 'unknown'
};

// Provider ID → manager instance. Populated on first use.
const managerRegistry = new Map<string, BackupTokenManager>()
let resolutionProviderId: (() => string | null) | null = null

/**
 * Supply a resolver that returns the active provider ID for the current
 * request context. Typically wired to `getActiveProviderProfile().id`.
 */
export function setProviderIdResolver(fn: () => string | null) {
  resolutionProviderId = fn
}

/**
 * Returns the backup manager for the given provider, creating one on
 * first access. Returns null when backup token rotation is not enabled.
 */
function getManager(providerId: string): BackupTokenManager | null {
  let m = managerRegistry.get(providerId)
  if (!m) {
    const config = getGlobalConfig()
    if (!config.backupTokenConfig) return null

    // Check backupTokenProviders first (new path)
    const backupKeys = config.backupTokenProviders?.[providerId]
    if (backupKeys && backupKeys.length > 1) {
      m = new BackupTokenManager(providerId)
      managerRegistry.set(providerId, m)
      return m
    }

    // Legacy path: check provider profiles
    const profile = config.providerProfiles?.find((p) => p.id === providerId)
    if (!profile) return null
    const hasMultipleKeys =
      (profile.apiKey && profile.apiKeys && profile.apiKeys.length > 0) ||
      (profile.apiKeys && profile.apiKeys.length > 1)
    if (!hasMultipleKeys) return null
    m = new BackupTokenManager(providerId)
    managerRegistry.set(providerId, m)
  }
  return m
}

// Pop on next read after a rotation happened. Lets withRetry force a fresh
// client even when the catch-branch didn't see the rotation itself.
let pendingRotation = false

export function consumePendingRotation(): boolean {
  const v = pendingRotation
  pendingRotation = false
  return v
}

/**
 * Notify the backup system that a 429 rate-limit error occurred for the
 * current request's provider. Call this from the retry loop to trigger
 * key rotation based on consecutive-error thresholds.
 *
 * Only rotates when the error is classified as a per-key limit ('key' or
 * 'unknown'). Model-level limits ('model') are reported to the user but do
 * not consume backup-key quota — rotating won't help.
 */
export function notifyRateLimitError(error?: APIError | { headers?: Headers | null; message?: string }, providerName?: string | null) {
  let pid: string | null = null

  // Try provider name argument first if provided
  if (providerName) {
    pid = providerName
  }

  // Fall back to resolver
  if (!pid && resolutionProviderId) {
    pid = resolutionProviderId()
  }

  if (!pid) return

  const category = error ? classifyRateLimit(error) : 'unknown'

  if (category === 'model') {
    logEvent('backup_token_skipped_model_limit', {})
    console.warn(
      '[BackupTokens] Model-level rate limit detected (upstream/overloaded). ' +
      'Rotating API keys will not resolve this — retrying on the same key.',
    )
    return
  }

  const m = getManager(pid)
  if (m) {
    const before = m.getActiveTokenIndex()
    m.recordRateLimitError()
    if (m.getActiveTokenIndex() !== before) pendingRotation = true
  }
}

/**
 * Returns the active API key for the given provider, honoring backup
 * rotation.  Use as a drop-in replacement for a plain `apiKey` value when
 * constructing clients.
 */
export function getActiveApiKey(providerId: string): string {
  const m = getManager(providerId)
  if (m) {
    const mKey = m.getCurrentToken()
    if (mKey) return mKey
  }
  const config = getGlobalConfig()
  const profile = config.providerProfiles?.find((p) => p.id === providerId)
  return profile?.apiKey ?? ''
}

export function addBackupTokenProvider(providerName: string, key: string): boolean {
  const config = getGlobalConfig()
  const existing = config.backupTokenProviders?.[providerName] ?? []
  if (existing.includes(key)) return false
  saveGlobalConfig((c) => ({
    ...c,
    backupTokenProviders: {
      ...c.backupTokenProviders,
      [providerName]: [...existing, key],
    },
  }))
  return true
}

export function getProviderByApiKey(apiKey: string): string | undefined {
  const config = getGlobalConfig()
  for (const [provider, keys] of Object.entries(config.backupTokenProviders ?? {})) {
    if (keys.includes(apiKey)) return provider
  }
  return undefined
}

function parseDuration(input: string): number | null {
  const units: Record<string, number> = {
    s: 1000,
    sec: 1000,
    secs: 1000,
    second: 1000,
    seconds: 1000,
    m: 60_000,
    min: 60_000,
    mins: 60_000,
    minute: 60_000,
    minutes: 60_000,
    h: 3_600_000,
    hr: 3_600_000,
    hrs: 3_600_000,
    hour: 3_600_000,
    hours: 3_600_000,
    d: 86_400_000,
    day: 86_400_000,
    days: 86_400_000,
    w: 7 * 86_400_000,
    week: 7 * 86_400_000,
    weeks: 7 * 86_400_000,
    mo: 30 * 86_400_000,
    month: 30 * 86_400_000,
    months: 30 * 86_400_000,
    y: 365 * 86_400_000,
    yr: 365 * 86_400_000,
    yrs: 365 * 86_400_000,
    year: 365 * 86_400_000,
    years: 365 * 86_400_000,
  }
  // Normalize: strip all whitespace to spaces, trim, collapse runs
  const normalized = input.trim().replace(/\s+/g, ' ')
  if (!normalized) return null
  // Validate: entire input must be consumeable as number+unit pairs
  if (!/^(\d+\s*[a-z]+\s*)+$/i.test(normalized)) return null

  let total = 0
  const re = /(\d+)\s*([a-z]+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(normalized)) !== null) {
    const value = parseInt(m[1], 10)
    const unit = m[2].toLowerCase()
    const factor = units[unit]
    if (factor === undefined) return null
    if (value === 0) return null
    total += value * factor
  }
  return total > 0 ? total : null
}

function parseWeeklyTarget(input: string): number | null {
  const dayNames: Record<string, number> = {
    sunday: 0, sun: 0,
    monday: 1, mon: 1,
    tuesday: 2, tue: 2, tues: 2,
    wednesday: 3, wed: 3,
    thursday: 4, thu: 4, thurs: 4,
    friday: 5, fri: 5,
    saturday: 6, sat: 6,
  }
  const cleaned = input.trim()
  let dayOfWeek: number | null = null
  let timePart = cleaned

  for (const [name, idx] of Object.entries(dayNames)) {
    const re = new RegExp(`^${name}\\s+`, 'i')
    if (re.test(cleaned)) {
      dayOfWeek = idx
      timePart = cleaned.replace(re, '').trim()
      break
    }
  }

  const timeMatch = timePart.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i)
  if (!timeMatch) return null
  let hours = parseInt(timeMatch[1], 10)
  const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0
  const ampm = timeMatch[3]?.toLowerCase()
  if (ampm === 'am' && hours === 12) hours = 0
  if (ampm === 'pm' && hours !== 12) hours += 12
  if (hours > 23 || minutes > 59) return null

  const now = new Date()
  const target = new Date(now)
  target.setHours(hours, minutes, 0, 0)
  if (dayOfWeek !== null) {
    const delta = (dayOfWeek - target.getDay() + 7) % 7
    target.setDate(target.getDate() + delta)
  }
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 7)
  }
  return target.getTime()
}

export function getNextResetAt(spec: string, now: number = Date.now()): number {
  const trimmed = spec.trim()
  if (!trimmed) return now + 3600_000

  const weeklyMatch = trimmed.match(/^(?:next|every)\s+(.+)$/i)
  if (weeklyMatch) {
    const target = parseWeeklyTarget(weeklyMatch[1])
    if (target !== null) return target
  }

  const ms = parseDuration(trimmed)
  if (ms !== null) return now + ms

  return now + 3600_000
}

export function scheduleNextResetAt(providerName: string, spec: string): void {
  const next = getNextResetAt(spec)
  const config = getGlobalConfig()
  saveGlobalConfig((c) => ({
    ...c,
    backupTokenResetSchedule: {
      ...c.backupTokenResetSchedule,
      [providerName]: next,
    },
  }))
}

export function resetAllKeysToDefault(providerName: string): void {
  const m = getManager(providerName)
  if (m) {
    m.resetTokenUsage()
  }
  pendingRotation = false
}

export class RateLimitTracker {
  private consecutiveErrors = 0;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;
  private threshold: number;
  private resetTimingMs: number;
  private onThreshold: (() => void) | null = null;

  constructor(threshold = 3, resetTimingMs = 0, onThreshold: (() => void) | null = null) {
    this.threshold = threshold;
    this.resetTimingMs = resetTimingMs;
    this.onThreshold = onThreshold;
  }

  recordError() {
    this.consecutiveErrors++;
    if (this.consecutiveErrors >= this.threshold && this.onThreshold) {
      const cb = this.onThreshold;
      this.reset();
      cb();
      return;
    }
    this.scheduleReset();
  }

  reset() {
    this.consecutiveErrors = 0;
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }

  private scheduleReset() {
    if (this.resetTimingMs <= 0) return;
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimer = setTimeout(() => this.reset(), this.resetTimingMs);
  }

  getConsecutiveErrors() {
    return this.consecutiveErrors;
  }
}

/**
 * Manages backup API keys for providers. Automatically cycles through
 * configured `apiKeys` on consecutive 429 errors and supports time-based
 * reset of the active key selection.
 */
export class BackupTokenManager {
  private activeTokenIndex = 0;
  private lastUsedTimestamp = 0;
  private rateLimitTracker: RateLimitTracker;
  private logging: boolean;
  private resetTiming: string;
  private customResetTime?: string;

  constructor(private providerId: string) {
    const config = getGlobalConfig();
    const btConfig = config.backupTokenConfig;
    if (!btConfig) {
      throw new Error('backupTokenConfig not configured');
    }
    this.logging = btConfig.logging;
    this.resetTiming = btConfig.resetTiming;
    this.customResetTime = btConfig.customResetTime;

    const ms = this.getResetIntervalMs();
    this.rateLimitTracker = new RateLimitTracker(
      btConfig.threshold,
      ms,
      () => this.handleThresholdReached()
    );
  }

  private getConfig() {
    return getGlobalConfig();
  }

  private getProfile() {
    const config = this.getConfig();
    const profiles = config.providerProfiles ?? [];
    return profiles.find((p) => p.id === this.providerId);
  }

  private getAllKeys(): string[] {
    const profile = this.getProfile();
    if (profile) {
      const keys: string[] = [];
      if (profile.apiKey) keys.push(profile.apiKey);
      if (profile.apiKeys && profile.apiKeys.length > 0) {
        for (const k of profile.apiKeys) {
          if (!keys.includes(k)) keys.push(k);
        }
      }
      if (keys.length > 0) return keys;
    }
    const config = this.getConfig();
    const backupKeys = config.backupTokenProviders?.[this.providerId];
    if (backupKeys && backupKeys.length > 0) return [...backupKeys];
    return [];
  }

  private setCurrentIndex(index: number) {
    const keys = this.getAllKeys();
    if (keys.length === 0) return;
    this.activeTokenIndex = Math.min(Math.max(0, index), keys.length - 1);
    this.lastUsedTimestamp = Date.now();
  }

  private handleThresholdReached() {
    this.switchToNextToken();
  }

  private switchToNextToken() {
    const keys = this.getAllKeys();
    if (keys.length <= 1) return;
    const fromIndex = this.activeTokenIndex;
    this.activeTokenIndex = (this.activeTokenIndex + 1) % keys.length;
    this.lastUsedTimestamp = Date.now();

    if (this.logging) {
      logEvent('backup_token_switched', {
        fromIndex,
        toIndex: this.activeTokenIndex,
        consecutiveErrors: this.rateLimitTracker.getConsecutiveErrors(),
      });
    }
  }

  /**
   * Record a 429 error. May trigger an automatic key switch.
   */
  recordRateLimitError() {
    this.rateLimitTracker.recordError();
  }

  /**
   * Returns the active API key to use for requests.
   * Tries the current cycle position first; falls back to the primary key.
   */
  getCurrentToken(): string {
    const keys = this.getAllKeys();
    if (keys.length === 0) return '';
    return keys[this.activeTokenIndex];
  }

  /**
   * Returns all configured keys (for UI/diagnostic display).
   */
  getAllBackupKeys(): string[] {
    return this.getAllKeys();
  }

  /**
   * Returns the index of the currently-active key.
   */
  getActiveTokenIndex(): number {
    return this.activeTokenIndex;
  }

  /**
   * Returns consecutive errors counted since last reset or switch.
   */
  getConsecutiveErrors(): number {
    return this.rateLimitTracker.getConsecutiveErrors();
  }

  /**
   * Manually reset back to the primary key and clear error counters.
   */
  resetTokenUsage() {
    this.activeTokenIndex = 0;
    this.rateLimitTracker.reset();
    this.lastUsedTimestamp = 0;

    if (this.logging) {
      logEvent('backup_token_reset', {
        activeIndex: this.activeTokenIndex,
      });
    }
  }

  /**
   * Determine whether an automatic time-based reset is due.
   */
  shouldAutoReset(): boolean {
    if (this.lastUsedTimestamp === 0) return false;
    if (this.resetTiming === 'custom' && this.customResetTime) {
      return Date.now() >= new Date(this.customResetTime).getTime();
    }
    const interval = this.getResetIntervalMs();
    if (interval <= 0) return false;
    return Date.now() - this.lastUsedTimestamp >= interval;
  }

  private getResetIntervalMs(): number {
    switch (this.resetTiming) {
      case '1m': return 60000;
      case '1h': return 3600000;
      case '1d': return 86400000;
      case 'custom': return 3600000;
      default: return 0;
    }
  }
}
