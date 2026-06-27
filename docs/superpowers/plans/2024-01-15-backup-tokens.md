# Backup API Token System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a backup API token system that allows users to configure multiple API tokens per provider and automatically switches between them when rate limited.

**Architecture:** Extend existing provider configuration system to support multiple tokens per provider, add error handling for rate limits, and implement automatic token switching with manual override capabilities.

**Tech Stack:** TypeScript, React (for UI), existing Neocode CLI architecture

---

## File Structure

### New Files
- `src/services/api/backupTokenManager.ts` - Handles multiple token management and switching
- `src/utils/config/backupTokenConfig.ts` - Configuration management for backup tokens
- `src/commands/backup-token/index.ts` - CLI command for manual token control
- `src/commands/backup-token/backup-token.tsx` - CLI command implementation
- `src/utils/rateLimitTracker.ts` - Tracks rate limit errors per token

### Modified Files
- `src/utils/config.ts` - Add backup token types to profile interface
- `src/components/ProviderManager.tsx` - Add backup token input field
- `src/services/api/providerConfig.ts` - Support multiple token lookup
- `src/bridge/bridgeApi.ts` - Integrate rate limit error handling
- `src/cli/structuredIO.ts` - Add backup token command to CLI

---

### Task 1: Add Backup Token Types to Configuration

**Files:**
- Modify: `src/utils/config.ts`
- Test: `src/utils/config.test.ts`

- [ ] **Step 1: Extend ProviderProfile interface to support multiple tokens**

```typescript
// Add to src/utils/config.ts
export interface ProviderProfile {
  name: string
  baseUrl: string
  model: string
  // Change from single string to array of strings
  apiKeys: string[]
  activeApiKeyIndex: number
  // Add backup token config
  backupTokenConfig?: {
    consecutiveErrorThreshold: number
    resetAfterSuccessTiming: 'never' | '1m' | '1h' | '1d' | '1mo' | 'custom'
    customResetTime?: number
    enableLogging: boolean
  }
}
```

- [ ] **Step 2: Update loadProfileFile to handle array format**

```typescript
// In loadProfileFile function, modify the profile parsing
const profile: ProfileFile = {
  name: data.name,
  baseUrl: data.baseUrl,
  model: data.model,
  apiKeys: data.apiKeys || [data.apiKey].filter(Boolean), // Handle old single token format
  activeApiKeyIndex: 0, // Default to first token
  backupTokenConfig: data.backupTokenConfig || undefined
}
```

- [ ] **Step 3: Update buildProfileEnv to support multiple tokens**

```typescript
// Modify buildProfileEnv functions in src/services/api/providerConfig.ts
export function buildOpenAIProfileEnv(options: {
  model?: string | null
  baseUrl?: string | null
  apiKeys?: string[] | null // Change from string to string[]
  activeApiKeyIndex?: number // Add active index
  processEnv?: NodeJS.ProcessEnv
}): ProfileEnv | null {
  const processEnv = options.processEnv ?? process.env
  const keys = options.apiKeys || [processEnv.OPENAI_API_KEY].filter(Boolean)
  if (!keys.length) return null
  
  const activeKey = keys[options.activeApiKeyIndex ?? 0]
  // Use activeKey for environment variable
}
```

- [ ] **Step 4: Write tests for array token support**

```typescript
// In src/utils/config.test.ts
test('loadProfileFile handles multiple api keys', () => {
  const data = {
    name: 'Test',
    baseUrl: 'https://api.openai.com',
    model: 'gpt-4',
    apiKeys: ['sk1', 'sk2', 'sk3'],
    activeApiKeyIndex: 1,
    backupTokenConfig: {
      consecutiveErrorThreshold: 3,
      resetAfterSuccessTiming: '1h',
      enableLogging: true
    }
  }
  
  const profile = loadProfileFile(data)
  expect(profile.apiKeys).toEqual(['sk1', 'sk2', 'sk3'])
  expect(profile.activeApiKeyIndex).toBe(1)
})
```

- [ ] **Step 5: Commit changes**

```bash
git add src/utils/config.ts src/utils/config.test.ts
git commit -m "feat: add backup token support to provider configuration"
```

---

### Task 2: Create Rate Limit Tracker

**Files:**
- Create: `src/utils/rateLimitTracker.ts`
- Test: `src/utils/rateLimitTracker.test.ts`

- [ ] **Step 1: Create RateLimitTracker class**

```typescript
// src/utils/rateLimitTracker.ts
export class RateLimitTracker {
  private errorCounts: Map<string, number> = new Map()
  private lastResetTime: Map<string, number> = new Map()
  
  constructor() {}
  
  incrementError(tokenIndex: string): number {
    const current = this.errorCounts.get(tokenIndex) || 0
    const newCount = current + 1
    this.errorCounts.set(tokenIndex, newCount)
    return newCount
  }
  
  getErrorCount(tokenIndex: string): number {
    return this.errorCounts.get(tokenIndex) || 0
  }
  
  resetErrorCount(tokenIndex: string): void {
    this.errorCounts.set(tokenIndex, 0)
  }
  
  shouldResetAfterSuccess(providerId: string, timing: string): boolean {
    if (timing === 'never') return false
    
    const now = Date.now()
    const resetTime = this.lastResetTime.get(providerId) || 0
    
    switch (timing) {
      case '1m':
        return now - resetTime > 60 * 1000
      case '1h':
        return now - resetTime > 60 * 60 * 1000
      case '1d':
        return now - resetTime > 24 * 60 * 60 * 1000
      case '1mo':
        return now - resetTime > 30 * 24 * 60 * 60 * 1000
      default:
        return false
    }
  }
  
  recordSuccess(providerId: string): void {
    this.lastResetTime.set(providerId, Date.now())
  }
}
```

- [ ] **Step 2: Create rate limit tracker instance**

```typescript
// Export singleton instance
export const rateLimitTracker = new RateLimitTracker()
```

- [ ] **Step 3: Write tests for rate limit tracking**

```typescript
// src/utils/rateLimitTracker.test.ts
test('RateLimitTracker tracks error counts', () => {
  rateLimitTracker.incrementError('0')
  rateLimitTracker.incrementError('0')
  
  expect(rateLimitTracker.getErrorCount('0')).toBe(2)
})

test('RateLimitTracker resets error counts', () => {
  rateLimitTracker.incrementError('1')
  rateLimitTracker.resetErrorCount('1')
  
  expect(rateLimitTracker.getErrorCount('1')).toBe(0)
})
```

- [ ] **Step 4: Commit changes**

```bash
git add src/utils/rateLimitTracker.ts src/utils/rateLimitTracker.test.ts
git commit -m "feat: add rate limit tracking utility"
```

---

### Task 3: Create Backup Token Manager

**Files:**
- Create: `src/services/api/backupTokenManager.ts`
- Test: `src/services/api/backupTokenManager.test.ts`

- [ ] **Step 1: Create BackupTokenManager class**

```typescript
// src/services/api/backupTokenManager.ts
import { rateLimitTracker } from '../../utils/rateLimitTracker.js'

export class BackupTokenManager {
  private profiles: Map<string, any> = new Map()
  
  constructor() {}
  
  updateProfile(profileId: string, profile: any): void {
    this.profiles.set(profileId, profile)
  }
  
  getActiveToken(profileId: string): string | null {
    const profile = this.profiles.get(profileId)
    if (!profile || !profile.apiKeys.length) return null
    
    const index = profile.activeApiKeyIndex || 0
    return profile.apiKeys[index]
  }
  
  switchToNextToken(profileId: string): boolean {
    const profile = this.profiles.get(profileId)
    if (!profile || !profile.apiKeys.length) return false
    
    const currentIndex = profile.activeApiKeyIndex || 0
    const nextIndex = (currentIndex + 1) % profile.apiKeys.length
    
    profile.activeApiKeyIndex = nextIndex
    this.profiles.set(profileId, profile)
    
    return true
  }
  
  handleRateLimitError(profileId: string): boolean {
    const profile = this.profiles.get(profileId)
    if (!profile || !profile.backupTokenConfig) return false
    
    const currentTokenIndex = profile.activeApiKeyIndex?.toString() || '0'
    const errorCount = rateLimitTracker.incrementError(currentTokenIndex)
    
    if (errorCount >= profile.backupTokenConfig.consecutiveErrorThreshold) {
      if (this.switchToNextToken(profileId)) {
        rateLimitTracker.resetErrorCount(currentTokenIndex)
        return true
      }
    }
    
    return false
  }
  
  shouldResetAfterSuccess(profileId: string): boolean {
    const profile = this.profiles.get(profileId)
    if (!profile?.backupTokenConfig?.resetAfterSuccessTiming) return false
    
    return rateLimitTracker.shouldResetAfterSuccess(
      profileId,
      profile.backupTokenConfig.resetAfterSuccessTiming
    )
  }
  
  recordSuccess(profileId: string): void {
    const profile = this.profiles.get(profileId)
    if (profile?.backupTokenConfig?.resetAfterSuccessTiming) {
      rateLimitTracker.recordSuccess(profileId)
    }
  }
}

export const backupTokenManager = new BackupTokenManager()
```

- [ ] **Step 2: Write tests for backup token manager**

```typescript
// src/services/api/backupTokenManager.test.ts
test('BackupTokenManager switches tokens on rate limit', () => {
  backupTokenManager.updateProfile('test', {
    apiKeys: ['token1', 'token2', 'token3'],
    activeApiKeyIndex: 0,
    backupTokenConfig: {
      consecutiveErrorThreshold: 2,
      resetAfterSuccessTiming: 'never',
      enableLogging: true
    }
  })
  
  // Simulate rate limit errors
  backupTokenManager.handleRateLimitError('test')
  backupTokenManager.handleRateLimitError('test')
  
  const activeToken = backupTokenManager.getActiveToken('test')
  expect(activeToken).toBe('token2')
})
```

- [ ] **Step 3: Commit changes**

```bash
git add src/services/api/backupTokenManager.ts src/services/api/backupTokenManager.test.ts
git commit -m "feat: add backup token manager service"
```

---

### Task 4: Integrate Rate Limit Error Handling

**Files:**
- Modify: `src/bridge/bridgeApi.ts`
- Modify: `src/services/api/client.ts`

- [ ] **Step 1: Modify bridgeApi.ts to handle rate limits with backup tokens**

```typescript
// In bridgeApi.ts, find the 429 case
case 429: {
  const context = `${endpoint} (${method})`
  throw new Error(`${context}: Rate limited (429). Polling too frequently.`)
}

// Replace with:
case 429: {
  const context = `${endpoint} (${method})`
  
  // Check if we should try backup token
  if (backupTokenManager.handleRateLimitError(currentProfileId)) {
    // Log the token switch
    const newToken = backupTokenManager.getActiveToken(currentProfileId)
    console.warn(`Backup API token switched to ${maskSecretForDisplay(newToken)}`)
    
    // Retry with new token
    const retryToken = backupTokenManager.getActiveToken(currentProfileId)
    if (retryToken) {
      return requestWithToken(endpoint, method, retryToken, body)
    }
  }
  
  throw new Error(`${context}: Rate limited (429). Polling too frequently.`)
}
```

- [ ] **Step 2: Modify client.ts to integrate backup token manager**

```typescript
// In src/services/api/client.ts, modify request functions
export async function requestWithToken(endpoint: string, method: string, token?: string) {
  const activeToken = token || backupTokenManager.getActiveToken(currentProfileId)
  if (!activeToken) {
    throw new Error('No API token available')
  }
  
  try {
    const response = await makeRequest(endpoint, method, activeToken)
    
    // Record success for potential reset
    if (currentProfileId) {
      backupTokenManager.recordSuccess(currentProfileId)
    }
    
    return response
  } catch (error) {
    if (error instanceof RateLimitError && currentProfileId) {
      // Try backup token
      const backupToken = backupTokenManager.getActiveToken(currentProfileId)
      if (backupToken && backupToken !== activeToken) {
        return requestWithToken(endpoint, method, backupToken)
      }
    }
    throw error
  }
}
```

- [ ] **Step 3: Add helper function for masked display**

```typescript
// Add to utils/auth.ts or similar
export function maskSecretForDisplay(secret: string | null): string {
  if (!secret) return '[none]'
  return `${secret.substring(0, 8)}...${secret.substring(secret.length - 4)}`
}
```

- [ ] **Step 4: Commit changes**

```bash
git add src/bridge/bridgeApi.ts src/services/api/client.ts
git commit -m "feat: integrate backup token switching in API error handling"
```

---

### Task 5: Extend Provider Manager UI

**Files:**
- Modify: `src/components/ProviderManager.tsx`

- [ ] **Step 1: Add backup tokens input field**

```typescript
// In ProviderManager.tsx, add to FORM_STEPS:
{
  key: 'backupApiTokens',
  label: 'Backup API Tokens',
  placeholder: 'Optional: token1:token2:token3',
  helpText: 'Separate multiple tokens with colons. Rate limit switching will be enabled.',
  optional: true
}
```

- [ ] **Step 2: Add backup tokens processing**

```typescript
// Add after FORM_STEPS definition
const processBackupTokens = (input: string): string[] => {
  if (!input.trim()) return []
  return input.split(':').filter(token => token.trim() !== '')
}

// In form state handling
case 'form': {
  const backupTokens = processBackupTokens(backupApiTokens || '')
  const apiKeys = backupTokens.length > 0 ? backupTokens : [apiKey]
  
  const profile = {
    name,
    baseUrl,
    model,
    apiKeys,
    activeApiKeyIndex: 0,
    backupTokenConfig: {
      consecutiveErrorThreshold: 3, // Default
      resetAfterSuccessTiming: 'never',
      enableLogging: true
    }
  }
}
```

- [ ] **Step 3: Add validation for backup tokens**

```typescript
// Add validation function
const validateBackupTokens = (tokens: string[]): { isValid: boolean; errors: string[] } => {
  const errors: string[] = []
  
  if (tokens.length > 0) {
    tokens.forEach((token, index) => {
      if (token.trim().length < 10) {
        errors.push(`Token ${index + 1} appears to be too short`)
      }
    })
  }
  
  return {
    isValid: errors.length === 0,
    errors
  }
}
```

- [ ] **Step 4: Commit changes**

```bash
git add src/components/ProviderManager.tsx
git commit -m "feat: add backup token input to provider configuration UI"
```

---

### Task 6: Create Backup Token CLI Command

**Files:**
- Create: `src/commands/backup-token/index.ts`
- Create: `src/commands/backup-token/backup-token.tsx`

- [ ] **Step 1: Create backup token command index**

```typescript
// src/commands/backup-token/index.ts
import type { Command } from '../../commands.js'

const backupTokenCommand = {
  type: 'local-jsx',
  name: 'backup-token',
  description: 'Manage backup API tokens',
  load: () => import('./backup-token.js'),
} satisfies Command

export default backupTokenCommand
```

- [ ] **Step 2: Create backup token command implementation**

```typescript
// src/commands/backup-token/backup-token.tsx
import { backupTokenManager } from '../../services/api/backupTokenManager.js'

export default async function BackupTokenCommand(argv: string[]) {
  if (argv.length === 0 || argv[0] === 'help') {
    console.log(`
Usage: /backup-token [command]

Commands:
  status     - Show current token status
  switch     - Manually switch to next token
  config     - Configure backup token settings
  reset      - Reset to first token`)
    return
  }

  const command = argv[0]
  
  switch (command) {
    case 'status':
      await showTokenStatus()
      break
    case 'switch':
      await switchToken()
      break
    case 'config':
      await configureBackupTokens()
      break
    case 'reset':
      await resetToFirstToken()
      break
    default:
      console.error(`Unknown command: ${command}`)
      process.exit(1)
  }
}

async function showTokenStatus() {
  const profile = getCurrentProfile()
  if (!profile) {
    console.log('No active profile')
    return
  }

  const activeToken = backupTokenManager.getActiveToken(profile.id)
  const activeIndex = profile.activeApiKeyIndex || 0
  
  console.log(`Profile: ${profile.name}`)
  console.log(`Active Token: ${maskSecretForDisplay(activeToken)}`)
  console.log(`Token Index: ${activeIndex + 1}/${profile.apiKeys.length}`)
  console.log(`Rate Limit Errors: ${rateLimitTracker.getErrorCount(activeIndex.toString())}`)
}

async function switchToken() {
  const profile = getCurrentProfile()
  if (!profile) {
    console.log('No active profile')
    return
  }

  if (profile.apiKeys.length <= 1) {
    console.log('Only one token available')
    return
  }

  const success = backupTokenManager.switchToNextToken(profile.id)
  if (success) {
    const newToken = backupTokenManager.getActiveToken(profile.id)
    console.log(`Switched to token: ${maskSecretForDisplay(newToken)}`)
  } else {
    console.log('Failed to switch token')
  }
}
```

- [ ] **Step 3: Add to CLI command registry**

```typescript
// In src/commands.ts, add import:
import backupTokenCommand from './commands/backup-token/index.js'

// Add to commands list:
const commandList: Command[] = [
  // ... existing commands
  backupTokenCommand,
  // ... rest of commands
]
```

- [ ] **Step 4: Commit changes**

```bash
git add src/commands/backup-token/index.ts src/commands/backup-token/backup-token.tsx src/commands.ts
git commit -m "feat: add backup token CLI command"
```

---

### Task 7: Add Configuration File Support

**Files:**
- Create: `src/utils/config/backupTokenConfig.ts`

- [ ] **Step 1: Create configuration storage**

```typescript
// src/utils/config/backupTokenConfig.ts
import { loadConfigFile, saveConfigFile } from './configStorage.js'

interface BackupTokenGlobalConfig {
  defaultConsecutiveErrorThreshold: number
  defaultResetTiming: 'never' | '1m' | '1h' | '1d' | '1mo' | 'custom'
  customResetTime?: number
  enableLogging: boolean
}

const DEFAULT_CONFIG: BackupTokenGlobalConfig = {
  defaultConsecutiveErrorThreshold: 3,
  defaultResetTiming: 'never',
  enableLogging: true
}

export function getBackupTokenConfig(): BackupTokenGlobalConfig {
  const saved = loadConfigFile('backup-token')
  return { ...DEFAULT_CONFIG, ...saved }
}

export function saveBackupTokenConfig(config: Partial<BackupTokenGlobalConfig>): void {
  const current = getBackupTokenConfig()
  saveConfigFile('backup-token', { ...current, ...config })
}
```

- [ ] **Step 2: Update Provider UI to use global defaults**

```typescript
// Modify ProviderManager to use global defaults
const globalConfig = getBackupTokenConfig()

const profile = {
  name,
  baseUrl,
  model,
  apiKeys,
  activeApiKeyIndex: 0,
  backupTokenConfig: {
    consecutiveErrorThreshold: globalConfig.defaultConsecutiveErrorThreshold,
    resetAfterSuccessTiming: globalConfig.defaultResetTiming,
    customResetTime: globalConfig.customResetTime,
    enableLogging: globalConfig.enableLogging
  }
}
```

- [ ] **Step 3: Commit changes**

```bash
git add src/utils/config/backupTokenConfig.ts
git commit -m "feat: add global backup token configuration support"
```

---

### Task 8: Add Documentation

**Files:**
- Create: `docs/user-guide/backup-tokens.md`

- [ ] **Step 1: Create user guide**

```markdown
# Backup API Tokens

## Overview
Backup API tokens provide automatic switching between multiple API keys when a rate limit is encountered. This ensures your workflow continues uninterrupted when one of your API keys reaches its limits.

## Configuration

### Entering Backup Tokens
1. Run `/provider` to open the provider configuration
2. In the provider form, enter your backup tokens in the "Backup API Tokens" field
3. Separate multiple tokens with colons: `token1:token2:token3`
4. Save the configuration

### Manual Management
Use the `/backup-token` command to manually manage backup tokens:

```bash
# View current token status
/backup-token status

# Manually switch to next token
/backup-token switch

# Reset to first token
/backup-token reset
```

## Configuration Options
- **Consecutive Error Threshold**: Number of rate limit errors before switching tokens (default: 3)
- **Reset Timing**: When to reset to first token after successful requests
  - `never`: Never automatically reset (default)
  - `1m`: Reset after 1 minute
  - `1h`: Reset after 1 hour
  - `1d`: Reset after 1 day
  - `1mo`: Reset after 1 month

## Behavior
- When a token encounters rate limit errors, consecutive errors are tracked
- After the threshold is reached, automatically switches to the next token in the list
- If all tokens are exhausted, falls back to current single-token behavior
- Tokens are automatically saved and restored between sessions
```

- [ ] **Step 2: Commit changes**

```bash
git add docs/user-guide/backup-tokens.md
git commit -m "docs: add backup tokens user guide"
```

---

## Execution Options

Plan complete and saved to `docs/superpowers/plans/2024-01-15-backup-tokens.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?