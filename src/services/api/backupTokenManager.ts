import type { APIError } from '@anthropic-ai/sdk'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logEvent as logEventOriginal } from '../analytics/index.js'

const logEvent = (eventName: string, metadata?: Record<string, unknown>): void => {
  logEventOriginal(eventName, metadata as any)
}

export type RateLimitCategory = 'key' | 'model' | 'unknown'

type TimeZoneSpec =
| { kind: 'local'; label: string }
| { kind: 'utc'; label: string }
| { kind: 'offset'; label: string; offsetMinutes: number }
| { kind: 'iana'; label: string; timeZone: string }

type ParsedResetSpec =
| { kind: 'duration'; label: string; ms: number }
| { kind: 'daily'; label: string; hour: number; minute: number; timeZone: TimeZoneSpec }
| { kind: 'weekly'; label: string; dayOfWeek: number; hour: number; minute: number; timeZone: TimeZoneSpec }
| { kind: 'monthly'; label: string; dayOfMonth: number; hour: number; minute: number; timeZone: TimeZoneSpec }

const managerRegistry = new Map<string, BackupTokenManager>()
let resolutionProviderId: (() => string | null) | null = null
let pendingRotation = false

function formatDurationLabel(ms: number): string {
const parts: string[] = []
const units: Array<[number, string]> = [
[365 * 24 * 60 * 60 * 1000, 'yr'],
[30 * 24 * 60 * 60 * 1000, 'mo'],
[7 * 24 * 60 * 60 * 1000, 'w'],
[24 * 60 * 60 * 1000, 'd'],
[60 * 60 * 1000, 'h'],
[60 * 1000, 'm'],
[1000, 's'],
]
let remaining = Math.max(0, Math.floor(ms))
for (const [size, label] of units) {
if (remaining < size) continue
const value = Math.floor(remaining / size)
remaining -= value * size
parts.push(`${value}${label}`)
}
return parts.length ? parts.join(' ') : '0s'
}

function pad2(n: number) {
return String(n).padStart(2, '0')
}

function formatMeridiemTime(hour: number, minute: number, meridiem: string) {
return `${hour}:${pad2(minute)} ${meridiem.toUpperCase()}`
}

function formatTimeZoneSpec(tz: TimeZoneSpec) {
return tz.label
}

function parseTimeZoneSpec(input: string | undefined): TimeZoneSpec | null {
const raw = (input ?? '').trim()
if (!raw) return { kind: 'local', label: 'local time' }

const lowered = raw.toLowerCase()
if (lowered === 'local' || lowered === 'system') return { kind: 'local', label: 'local time' }
if (lowered === 'utc' || lowered === 'z' || lowered === 'gmt') return { kind: 'utc', label: 'UTC' }

const utcOffset = raw.match(/^(?:utc|gmt)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i)
if (utcOffset) {
const sign = utcOffset[1] === '-' ? -1 : 1
const hours = parseInt(utcOffset[2], 10)
const minutes = utcOffset[3] ? parseInt(utcOffset[3], 10) : 0
if (hours <= 23 && minutes <= 59) {
const total = sign * (hours * 60 + minutes)
const abs = Math.abs(total)
const hh = pad2(Math.floor(abs / 60))
const mm = pad2(abs % 60)
return {
kind: 'offset',
offsetMinutes: total,
label: `UTC${total >= 0 ? '+' : '-'}${hh}:${mm}`,
}
}
}

const compactOffset = raw.match(/^([+-])(\d{2}):?(\d{2})$/)
if (compactOffset) {
const sign = compactOffset[1] === '-' ? -1 : 1
const hours = parseInt(compactOffset[2], 10)
const minutes = parseInt(compactOffset[3], 10)
if (hours <= 23 && minutes <= 59) {
const total = sign * (hours * 60 + minutes)
const abs = Math.abs(total)
const hh = pad2(Math.floor(abs / 60))
const mm = pad2(abs % 60)
return {
kind: 'offset',
offsetMinutes: total,
label: `UTC${total >= 0 ? '+' : '-'}${hh}:${mm}`,
}
}
}

try {
new Intl.DateTimeFormat('en-US', { timeZone: raw })
return { kind: 'iana', timeZone: raw, label: raw }
} catch {
return null
}
}

function getTimeZoneOffsetMinutes(utcMs: number, timeZone: TimeZoneSpec): number {
if (timeZone.kind === 'local') return -new Date(utcMs).getTimezoneOffset()
if (timeZone.kind === 'utc') return 0
if (timeZone.kind === 'offset') return timeZone.offsetMinutes

const date = new Date(utcMs)
const formatter = new Intl.DateTimeFormat('en-US', {
timeZone: timeZone.timeZone,
calendar: 'gregory',
numberingSystem: 'latn',
hour12: false,
year: 'numeric',
month: '2-digit',
day: '2-digit',
hour: '2-digit',
minute: '2-digit',
second: '2-digit',
})
const parts = formatter.formatToParts(date)
const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0'
const year = parseInt(get('year'), 10)
const month = parseInt(get('month'), 10)
const day = parseInt(get('day'), 10)
const hour = parseInt(get('hour'), 10)
const minute = parseInt(get('minute'), 10)
const second = parseInt(get('second'), 10)
const interpreted = Date.UTC(year, month - 1, day, hour, minute, second)
return Math.round((interpreted - utcMs) / 60000)
}

function getZonedParts(utcMs: number, timeZone: TimeZoneSpec) {
if (timeZone.kind === 'local') {
const d = new Date(utcMs)
return {
year: d.getFullYear(),
month: d.getMonth() + 1,
day: d.getDate(),
weekday: d.getDay(),
}
}

if (timeZone.kind === 'utc') {
const d = new Date(utcMs)
return {
year: d.getUTCFullYear(),
month: d.getUTCMonth() + 1,
day: d.getUTCDate(),
weekday: d.getUTCDay(),
}
}

if (timeZone.kind === 'offset') {
const localMs = utcMs + timeZone.offsetMinutes * 60000
const d = new Date(localMs)
return {
year: d.getUTCFullYear(),
month: d.getUTCMonth() + 1,
day: d.getUTCDate(),
weekday: d.getUTCDay(),
}
}

const formatter = new Intl.DateTimeFormat('en-US', {
timeZone: timeZone.timeZone,
calendar: 'gregory',
numberingSystem: 'latn',
weekday: 'short',
year: 'numeric',
month: '2-digit',
day: '2-digit',
})
const date = new Date(utcMs)
const parts = formatter.formatToParts(date)
const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0'
const weekdayStr = get('weekday').toLowerCase()
const weekdays: Record<string, number> = {
sun: 0,
mon: 1,
tue: 2,
wed: 3,
thu: 4,
fri: 5,
sat: 6,
}
return {
year: parseInt(get('year'), 10),
month: parseInt(get('month'), 10),
day: parseInt(get('day'), 10),
weekday: weekdays[weekdayStr] ?? 0,
}
}

function addCalendarDays(parts: { year: number; month: number; day: number }, delta: number) {
const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + delta))
return {
year: d.getUTCFullYear(),
month: d.getUTCMonth() + 1,
day: d.getUTCDate(),
}
}

function addCalendarMonths(parts: { year: number; month: number }, delta: number) {
const d = new Date(Date.UTC(parts.year, parts.month - 1 + delta, 1))
return {
year: d.getUTCFullYear(),
month: d.getUTCMonth() + 1,
}
}

function buildZonedUtc(
year: number,
month: number,
day: number,
hour: number,
minute: number,
timeZone: TimeZoneSpec
): number {
let utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
for (let i = 0; i < 4; i++) {
const offsetMinutes = getTimeZoneOffsetMinutes(utcMs, timeZone)
const next = Date.UTC(year, month - 1, day, hour, minute, 0, 0) - offsetMinutes * 60000
if (Math.abs(next - utcMs) < 1000) return next
utcMs = next
}
return utcMs
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

const normalized = input.trim().replace(/\s+/g, ' ')
if (!normalized) return null
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

function parseWeekday(input: string): number | null {
const dayNames: Record<string, number> = {
sunday: 0,
sun: 0,
monday: 1,
mon: 1,
tuesday: 2,
tue: 2,
tues: 2,
wednesday: 3,
wed: 3,
thursday: 4,
thu: 4,
thurs: 4,
friday: 5,
fri: 5,
saturday: 6,
sat: 6,
}
const lower = input.toLowerCase().trim()
return dayNames[lower] ?? null
}

export function parseBackupTokenResetSpec(input: string): ParsedResetSpec | null {
const raw = input.trim()
if (!raw) return null

const duration = parseDuration(raw)
if (duration !== null) {
return {
kind: 'duration',
ms: duration,
label: formatDurationLabel(duration),
}
}

const monthly = raw.match(/^(\d{1,2})(st|nd|rd|th)\s+next\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s+(.+))?$/i)
if (monthly) {
const dayOfMonth = parseInt(monthly[1], 10)
const hour12 = parseInt(monthly[3], 10)
const minute = monthly[4] ? parseInt(monthly[4], 10) : 0
const meridiem = monthly[5].toLowerCase()
const timeZone = parseTimeZoneSpec(monthly[6]) ?? null
if (dayOfMonth >= 1 && dayOfMonth <= 31 && hour12 >= 1 && hour12 <= 12 && minute >= 0 && minute <= 59 && timeZone) {
const hour = meridiem === 'pm' ? (hour12 % 12) + 12 : hour12 % 12
return {
kind: 'monthly',
dayOfMonth,
hour,
minute,
timeZone,
label: `${dayOfMonth}${monthly[2]} next ${formatMeridiemTime(hour12, minute, meridiem)} ${formatTimeZoneSpec(timeZone)}`.trim(),
}
}
}

const weekly = raw.match(/^(?:every\s+)?(sunday|sun|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thurs|friday|fri|saturday|sat)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s+(.+))?$/i)
if (weekly) {
const dayOfWeek = parseWeekday(weekly[1])
const hour12 = parseInt(weekly[2], 10)
const minute = weekly[3] ? parseInt(weekly[3], 10) : 0
const meridiem = weekly[4].toLowerCase()
const timeZone = parseTimeZoneSpec(weekly[5]) ?? null
if (dayOfWeek !== null && hour12 >= 1 && hour12 <= 12 && minute >= 0 && minute <= 59 && timeZone) {
const hour = meridiem === 'pm' ? (hour12 % 12) + 12 : hour12 % 12
return {
kind: 'weekly',
dayOfWeek,
hour,
minute,
timeZone,
label: `${weekly[1]} ${formatMeridiemTime(hour12, minute, meridiem)} ${formatTimeZoneSpec(timeZone)}`.trim(),
}
}
}

const daily = raw.match(/^next\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s+(.+))?$/i)
if (daily) {
const hour12 = parseInt(daily[1], 10)
const minute = daily[2] ? parseInt(daily[2], 10) : 0
const meridiem = daily[3].toLowerCase()
const timeZone = parseTimeZoneSpec(daily[4]) ?? null
if (hour12 >= 1 && hour12 <= 12 && minute >= 0 && minute <= 59 && timeZone) {
const hour = meridiem === 'pm' ? (hour12 % 12) + 12 : hour12 % 12
return {
kind: 'daily',
hour,
minute,
timeZone,
label: `next ${formatMeridiemTime(hour12, minute, meridiem)} ${formatTimeZoneSpec(timeZone)}`.trim(),
}
}
}

return null
}

export function isValidBackupTokenResetSpec(input: string): boolean {
return parseBackupTokenResetSpec(input) !== null
}

function computeNextFromDaily(spec: Extract<ParsedResetSpec, { kind: 'daily' }>, now: number): number {
const parts = getZonedParts(now, spec.timeZone)
let candidate = buildZonedUtc(parts.year, parts.month, parts.day, spec.hour, spec.minute, spec.timeZone)
if (candidate <= now) {
const nextDay = addCalendarDays({ year: parts.year, month: parts.month, day: parts.day }, 1)
candidate = buildZonedUtc(nextDay.year, nextDay.month, nextDay.day, spec.hour, spec.minute, spec.timeZone)
}
return candidate
}

function computeNextFromWeekly(spec: Extract<ParsedResetSpec, { kind: 'weekly' }>, now: number): number {
const parts = getZonedParts(now, spec.timeZone)
const delta = (spec.dayOfWeek - parts.weekday + 7) % 7
let candidateDay = addCalendarDays({ year: parts.year, month: parts.month, day: parts.day }, delta)
let candidate = buildZonedUtc(candidateDay.year, candidateDay.month, candidateDay.day, spec.hour, spec.minute, spec.timeZone)
if (candidate <= now) {
candidateDay = addCalendarDays(candidateDay, 7)
candidate = buildZonedUtc(candidateDay.year, candidateDay.month, candidateDay.day, spec.hour, spec.minute, spec.timeZone)
}
return candidate
}

function computeNextFromMonthly(spec: Extract<ParsedResetSpec, { kind: 'monthly' }>, now: number): number {
const parts = getZonedParts(now, spec.timeZone)
for (let monthOffset = 0; monthOffset < 24; monthOffset++) {
const monthParts = addCalendarMonths({ year: parts.year, month: parts.month }, monthOffset)
const candidateDate = new Date(Date.UTC(monthParts.year, monthParts.month - 1, spec.dayOfMonth))
if (candidateDate.getUTCMonth() !== monthParts.month - 1) continue
const candidate = buildZonedUtc(monthParts.year, monthParts.month, spec.dayOfMonth, spec.hour, spec.minute, spec.timeZone)
if (candidate > now) return candidate
}
return now + 3600_000
}

export function getNextResetAt(spec: string, now: number = Date.now()): number {
const trimmed = spec.trim()
if (!trimmed) return now + 3600_000

const parsed = parseBackupTokenResetSpec(trimmed)
if (parsed) {
if (parsed.kind === 'duration') return now + parsed.ms
if (parsed.kind === 'daily') return computeNextFromDaily(parsed, now)
if (parsed.kind === 'weekly') return computeNextFromWeekly(parsed, now)
if (parsed.kind === 'monthly') return computeNextFromMonthly(parsed, now)
}

return now + 3600_000
}

export function scheduleNextResetAt(providerName: string, spec: string): void {
const next = getNextResetAt(spec)
saveGlobalConfig((c) => ({
...c,
backupTokenResetSchedule: {
...c.backupTokenResetSchedule,
[providerName]: next,
},
}))
}

function getHeaders(error?: APIError | { headers?: Headers | null } | null): Headers | null {
const headers = (error as APIError | undefined)?.headers ?? (error as { headers?: Headers | null } | undefined)?.headers ?? null
return headers ?? null
}

function getMessage(error?: APIError | { message?: string } | null): string {
return ((error as { message?: string } | undefined)?.message ?? '').toString()
}

function parseRetryAfterMs(error?: APIError | { headers?: Headers | null; message?: string } | null): number | null {
if (!error) return null
const headers = getHeaders(error)
const message = getMessage(error).toLowerCase()

const retryAfter = headers?.get('retry-after')?.trim()
if (retryAfter) {
const seconds = Number(retryAfter)
if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
const httpDate = Date.parse(retryAfter)
if (Number.isFinite(httpDate)) return Math.max(0, httpDate - Date.now())
}

const resetHeaders = [
'x-ratelimit-reset',
'x-ratelimit-reset-tokens',
'x-ratelimit-reset-requests',
'x-ratelimit-reset-concurrent',
'ratelimit-reset',
'anthropic-ratelimit-reset',
]
for (const name of resetHeaders) {
const raw = headers?.get(name)?.trim()
if (!raw) continue
const seconds = Number(raw)
if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
const ts = Date.parse(raw)
if (Number.isFinite(ts)) return Math.max(0, ts - Date.now())
}

const minuteHour = message.match(/(?:retry|try again|wait|limit|available)\s+(?:in\s+)?(\d{1,3})\s*(ms|milliseconds?|seconds?|minutes?|hours?|days?)/i)
if (minuteHour) {
const value = parseInt(minuteHour[1], 10)
const unit = minuteHour[2].toLowerCase()
if (unit.startsWith('ms')) return value
if (unit.startsWith('second')) return value * 1000
if (unit.startsWith('minute')) return value * 60_000
if (unit.startsWith('hour')) return value * 3_600_000
if (unit.startsWith('day')) return value * 86_400_000
}

const compact = message.match(/(\d+)\s*(m|minute|minutes|h|hour|hours)\b/i)
if (compact) {
const value = parseInt(compact[1], 10)
const unit = compact[2].toLowerCase()
if (unit === 'm' || unit.startsWith('minute')) return value * 60_000
if (unit === 'h' || unit.startsWith('hour')) return value * 3_600_000
}

return null
}

function isPlanLimitError(error?: APIError | { headers?: Headers | null; message?: string } | null): boolean {
if (!error) return false
const headers = getHeaders(error)
const message = getMessage(error).toLowerCase()

const headerHints = [
headers?.get('anthropic-ratelimit-type'),
headers?.get('x-ratelimit-scope'),
headers?.get('x-ratelimit-remaining'),
]
.filter(Boolean)
.join(' ')
.toLowerCase()

if (headerHints.includes('quota') || headerHints.includes('plan')) return true

return (
message.includes('plan limit') ||
message.includes('quota exceeded') ||
message.includes('subscription') ||
message.includes('billing') ||
message.includes('usage limit') ||
message.includes('monthly limit') ||
message.includes('daily limit') ||
message.includes('account limit') ||
message.includes('credit balance') ||
message.includes('hard limit')
)
}

function classifyRateLimitWithDetail(error?: APIError | { headers?: Headers | null; message?: string }): {
category: RateLimitCategory
retryAfterMs: number | null
planLimit: boolean
temporaryWindow: 'minute' | 'hour' | 'day' | 'long' | 'unknown'
} {
const headers = getHeaders(error)
const message = getMessage(error).toLowerCase()
const retryAfterMs = parseRetryAfterMs(error ?? null)
const planLimit = isPlanLimitError(error ?? null)

const limitType = headers?.get('anthropic-ratelimit-type')?.toLowerCase()
if (limitType === 'model' || limitType === 'overloaded') {
return { category: 'model', retryAfterMs, planLimit, temporaryWindow: retryAfterMs !== null && retryAfterMs <= 86_400_000 ? (retryAfterMs <= 3_600_000 ? 'hour' : 'day') : 'unknown' }
}

if (planLimit) {
return { category: 'key', retryAfterMs, planLimit, temporaryWindow: retryAfterMs !== null ? (retryAfterMs <= 60_000 ? 'minute' : retryAfterMs <= 3_600_000 ? 'hour' : retryAfterMs <= 18_000_000 ? 'day' : 'long') : 'unknown' }
}

if (
limitType === 'tokens' ||
limitType === 'requests' ||
limitType === 'concurrent' ||
headers?.get('retry-after') ||
headers?.get('x-ratelimit-reset') ||
headers?.get('x-ratelimit-reset-tokens') ||
headers?.get('x-ratelimit-reset-requests') ||
message.includes('rate limit') ||
message.includes('too many requests') ||
message.includes('temporarily limited') ||
message.includes('please retry') ||
message.includes('retry after') ||
message.includes('try again in')
) {
const window =
retryAfterMs !== null
? retryAfterMs <= 60_000
? 'minute'
: retryAfterMs <= 3_600_000
? 'hour'
: retryAfterMs <= 18_000_000
? 'day'
: 'long'
: 'unknown'
return { category: 'key', retryAfterMs, planLimit, temporaryWindow: window }
}

return { category: 'unknown', retryAfterMs, planLimit, temporaryWindow: 'unknown' }
}

export function classifyRateLimit(error: APIError | { headers?: Headers | null; message?: string }): RateLimitCategory {
return classifyRateLimitWithDetail(error).category
}

export function isPlanLimitRateLimit(error?: APIError | { headers?: Headers | null; message?: string }): boolean {
return classifyRateLimitWithDetail(error).planLimit
}

export function setProviderIdResolver(fn: () => string | null) {
resolutionProviderId = fn
}

function getManager(providerId: string): BackupTokenManager | null {
let m = managerRegistry.get(providerId)
if (!m) {
const config = getGlobalConfig()
if (!config.backupTokenConfig) return null

 
const backupKeys = config.backupTokenProviders?.[providerId]
if (backupKeys && backupKeys.length > 0) {
  m = new BackupTokenManager(providerId)
  managerRegistry.set(providerId, m)
  return m
}

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

export function resetAllKeysToDefault(providerName: string): void {
  const config = getGlobalConfig()
  const m = managerRegistry.get(providerName)
  if (m) {
    m.resetTokenUsage()
  }
  saveGlobalConfig((c) => ({
    ...c,
    backupTokenResetSchedule: {
      ...c.backupTokenResetSchedule,
      [providerName]: 0,
    },
  }))
}

export function consumePendingRotation(): boolean {
const v = pendingRotation
pendingRotation = false
return v
}

export function notifyRateLimitError(
error?: APIError | { headers?: Headers | null; message?: string },
providerName?: string | null
) {
let pid: string | null = null

if (providerName) {
pid = providerName
}

if (!pid && resolutionProviderId) {
pid = resolutionProviderId()
}

if (!pid) return

const analysis = classifyRateLimitWithDetail(error)

if (analysis.category === 'model') {
logEvent('backup_token_skipped_model_limit', {
provider: pid,
retryAfterMs: analysis.retryAfterMs ?? null,
})
console.warn(
'[BackupTokens] Model-level rate limit detected. Rotating API keys will not resolve this, so retrying on the same key.'
)
return
}

const m = getManager(pid)
if (m) {
const before = m.getActiveTokenIndex()
m.recordRateLimitError(analysis.retryAfterMs ?? undefined)
if (m.getActiveTokenIndex() !== before) {
pendingRotation = true
logEvent('backup_token_switched_due_to_rate_limit', {
provider: pid,
fromIndex: before,
toIndex: m.getActiveTokenIndex(),
retryAfterMs: analysis.retryAfterMs ?? null,
window: analysis.temporaryWindow,
})
}
}
}

export function getActiveApiKey(providerId: string): string {
const m = getManager(providerId)
if (m) {
const mKey = m.getCurrentToken()
if (mKey) return mKey
}

const config = getGlobalConfig()
const backupKeys = config.backupTokenProviders?.[providerId]
if (backupKeys && backupKeys.length > 0) return backupKeys[0]

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

export function setActiveBackupToken(providerName: string, keyOrIndex: string | number): boolean {
const m = getManager(providerName)
if (!m) return false
return m.setActiveToken(keyOrIndex)
}

export class RateLimitTracker {
private consecutiveErrors = 0
private resetTimer: ReturnType<typeof setTimeout> | null = null
private threshold: number
private resetTimingMs: number
private onThreshold: (() => void) | null = null

constructor(threshold = 3, resetTimingMs = 0, onThreshold: (() => void) | null = null) {
this.threshold = threshold
this.resetTimingMs = resetTimingMs
this.onThreshold = onThreshold
}

recordError(extraResetMs?: number) {
this.consecutiveErrors++
if (this.consecutiveErrors >= this.threshold && this.onThreshold) {
const cb = this.onThreshold
this.reset()
cb()
return
}
this.scheduleReset(extraResetMs)
}

reset() {
this.consecutiveErrors = 0
if (this.resetTimer) {
clearTimeout(this.resetTimer)
this.resetTimer = null
}
}

private scheduleReset(extraResetMs?: number) {
const nextMs = Math.max(this.resetTimingMs, extraResetMs ?? 0)
if (nextMs <= 0) return
if (this.resetTimer) clearTimeout(this.resetTimer)
this.resetTimer = setTimeout(() => this.reset(), nextMs)
}

getConsecutiveErrors() {
return this.consecutiveErrors
}
}

export class BackupTokenManager {
private activeTokenIndex = 0
private lastUsedTimestamp = 0
private rateLimitTracker: RateLimitTracker
private logging: boolean
private resetTiming: string
private customResetTime?: string

constructor(private providerId: string) {
const config = getGlobalConfig()
const btConfig = config.backupTokenConfig
if (!btConfig) {
throw new Error('backupTokenConfig not configured')
}
this.logging = btConfig.logging
this.resetTiming = btConfig.resetTiming
this.customResetTime = btConfig.customResetTime


const ms = this.getResetIntervalMs()
this.rateLimitTracker = new RateLimitTracker(
  btConfig.threshold,
  ms,
  () => this.handleThresholdReached()
)


}

private getConfig() {
return getGlobalConfig()
}

private getProfile() {
const config = this.getConfig()
const profiles = config.providerProfiles ?? []
return profiles.find((p) => p.id === this.providerId)
}

private getAllKeys(): string[] {
const profile = this.getProfile()
if (profile) {
const keys: string[] = []
if (profile.apiKey) keys.push(profile.apiKey)
if (profile.apiKeys && profile.apiKeys.length > 0) {
for (const k of profile.apiKeys) {
if (!keys.includes(k)) keys.push(k)
}
}
if (keys.length > 0) return keys
}
const config = this.getConfig()
const backupKeys = config.backupTokenProviders?.[this.providerId]
if (backupKeys && backupKeys.length > 0) return [...backupKeys]
return []
}

private keySuffix(key: string) {
return `${key.slice(0, 6)}...${key.slice(-4)}`
}

private setCurrentIndex(index: number) {
const keys = this.getAllKeys()
if (keys.length === 0) return
this.activeTokenIndex = Math.min(Math.max(0, index), keys.length - 1)
this.lastUsedTimestamp = Date.now()
}

private emitKeyChange(fromIndex: number, toIndex: number, reason: string) {
const keys = this.getAllKeys()
if (!keys.length) return
const fromKey = keys[fromIndex]
const toKey = keys[toIndex]
if (this.logging) {
logEvent('backup_token_switched', {
provider: this.providerId,
reason,
fromIndex,
toIndex,
fromKey: fromKey ? this.keySuffix(fromKey) : null,
toKey: toKey ? this.keySuffix(toKey) : null,
consecutiveErrors: this.rateLimitTracker.getConsecutiveErrors(),
})
}
console.info(
`[BackupTokens] ${this.providerId} switched from ${fromIndex} to ${toIndex}`
)
}

private handleThresholdReached() {
this.switchToNextToken('threshold')
}

private switchToNextToken(reason = 'rate_limit') {
const keys = this.getAllKeys()
if (keys.length <= 1) return
const fromIndex = this.activeTokenIndex
const nextIndex = (this.activeTokenIndex + 1) % keys.length
this.activeTokenIndex = nextIndex
this.lastUsedTimestamp = Date.now()
this.emitKeyChange(fromIndex, nextIndex, reason)
}

recordRateLimitError(extraResetMs?: number) {
this.rateLimitTracker.recordError(extraResetMs)
}

getCurrentToken(): string {
const keys = this.getAllKeys()
if (keys.length === 0) return ''
return keys[this.activeTokenIndex]
}

getAllBackupKeys(): string[] {
return this.getAllKeys()
}

getActiveTokenIndex(): number {
return this.activeTokenIndex
}

getConsecutiveErrors(): number {
return this.rateLimitTracker.getConsecutiveErrors()
}

setActiveToken(keyOrIndex: string | number): boolean {
const keys = this.getAllKeys()
if (!keys.length) return false


const nextIndex =
  typeof keyOrIndex === 'number'
    ? keyOrIndex
    : keys.findIndex((k) => k === keyOrIndex)

if (nextIndex < 0 || nextIndex >= keys.length) return false
if (nextIndex === this.activeTokenIndex) return true

const fromIndex = this.activeTokenIndex
this.activeTokenIndex = nextIndex
this.lastUsedTimestamp = Date.now()
this.rateLimitTracker.reset()
this.emitKeyChange(fromIndex, nextIndex, 'manual_select')
return true


}

resetTokenUsage() {
this.activeTokenIndex = 0
this.rateLimitTracker.reset()
this.lastUsedTimestamp = 0


if (this.logging) {
  logEvent('backup_token_reset', {
    activeIndex: this.activeTokenIndex,
    provider: this.providerId,
  })
}
console.info(`[BackupTokens] ${this.providerId} reset to primary token`)


}

shouldAutoReset(): boolean {
const config = this.getConfig()
const scheduled = config.backupTokenResetSchedule?.[this.providerId] ?? 0
if (scheduled > 0) return Date.now() >= scheduled
if (this.lastUsedTimestamp === 0) return false
const interval = this.getResetIntervalMs()
if (interval <= 0) return false
return Date.now() - this.lastUsedTimestamp >= interval
}

private getResetIntervalMs(): number {
switch (this.resetTiming) {
case '1m':
return 60_000
case '1h':
return 3_600_000
case '1d':
return 86_400_000
case 'custom':
return 0
default:
return 0
}
}
}
