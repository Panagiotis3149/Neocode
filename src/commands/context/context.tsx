import { feature } from 'bun:bundle';
import * as React from 'react';
import type { LocalJSXCommandContext } from '../../commands.js';
import { ContextVisualization } from '../../components/ContextVisualization.js';
import { microcompactMessages } from '../../services/compact/microCompact.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import type { Message } from '../../types/message.js';
import { analyzeContextUsage } from '../../utils/analyzeContext.js';
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js';
import { renderToAnsiString } from '../../utils/staticRender.js';
import {
  clearContextWindowOverride,
  getContextWindowOverride,
  parseContextWindowSize,
  setContextWindowOverride,
} from '../../utils/contextWindowOverrides.js';
import { getContextWindowSource } from '../../utils/context.js';

const RESET_ARGS = new Set(['reset', '0', '-1'])

/**
 * Apply the same context transforms query.ts does before the API call, so
 * /context shows what the model actually sees rather than the REPL's raw
 * history. Without projectView the token count overcounts by however much
 * was collapsed — user sees "180k, 3 spans collapsed" when the API sees 120k.
 */
function toApiView(messages: Message[]): Message[] {
  let view = getMessagesAfterCompactBoundary(messages);
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const {
      projectView
    } = require('../../services/contextCollapse/operations.js') as typeof import('../../services/contextCollapse/operations.js');
    /* eslint-enable @typescript-eslint/no-require-imports */
    view = projectView(view);
  }
  return view;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

function applySet(model: string, sizeStr: string): string {
  let tokens: number
  try {
    tokens = parseContextWindowSize(sizeStr)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'RESET') {
      return applyReset(model)
    }
    return msg
  }
  const result = setContextWindowOverride(model, tokens)
  if (result.error) return `Failed: ${result.error.message}`
  return `Set context window override for "${model}" → ${formatTokens(tokens)} (persisted)`
}

function applyReset(model: string): string {
  const result = clearContextWindowOverride(model)
  if (result.error) return `Failed: ${result.error.message}`
  return `Cleared context window override for "${model}"`
}

function buildSourceLine(model: string, betas?: string[]): string | null {
  const { source, isOverride } = getContextWindowSource(model, betas)
  if (isOverride) {
    return `(source: ${source})`
  }
  return null
}

function renderUsageToast(): string {
  return 'Usage: /context [size|reset]  e.g. 256k, 1m, or /context reset'
}

function ContextView({
  onDone,
  context,
}: {
  onDone: LocalJSXCommandOnDone
  context: LocalJSXCommandContext
}) {
  const {
    messages,
    getAppState,
    options: { mainLoopModel, tools },
  } = context

  const [sourceLine, setSourceLine] = React.useState<string | null>(null)

  React.useEffect(() => {
    // Compute source label from main thread only
    const label = buildSourceLine(mainLoopModel)
    setSourceLine(label)
  }, [mainLoopModel])

  React.useEffect(() => {
    // run visualization then append source label if present
    ;(async () => {
      const apiView = toApiView(messages)
      const { messages: compactedMessages } = await microcompactMessages(apiView)
      const terminalWidth = process.stdout.columns || 80
      const appState = getAppState()

      const data = await analyzeContextUsage(
        compactedMessages,
        mainLoopModel,
        async () => appState.toolPermissionContext,
        tools,
        appState.agentDefinitions,
        terminalWidth,
        context,
        undefined,
        apiView,
      )

      const output = await renderToAnsiString(
        <ContextVisualization data={data} />,
      )

      const suffix = sourceLine ? `  ${sourceLine}` : ''
      onDone(output + suffix)
    })()
  }, [sourceLine])

  return null
}

function SetAndClose({
  onDone,
  model,
  sizeStr,
}: {
  onDone: LocalJSXCommandOnDone
  model: string
  sizeStr: string
}) {
  React.useEffect(() => {
    onDone(applySet(model, sizeStr))
  }, [])
  return null
}

function ResetAndClose({ onDone, model }: { onDone: LocalJSXCommandOnDone; model: string }) {
  React.useEffect(() => {
    onDone(applyReset(model))
  }, [])
  return null
}

function UsageToast({ onDone }: { onDone: LocalJSXCommandOnDone }) {
  React.useEffect(() => {
    onDone(renderUsageToast())
  }, [])
  return null
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  const { mainLoopModel } = context.options
  const trimmed = args?.trim().toLowerCase() ?? ''

  if (!trimmed) {
    return <ContextView onDone={onDone} context={context} />
  }

  if (RESET_ARGS.has(trimmed)) {
    return <ResetAndClose onDone={onDone} model={mainLoopModel} />
  }

  // Try parsing as a size — valid size triggers set mode
  // Invalid parse throws; we catch and show usage
  try {
    parseContextWindowSize(trimmed)
    return <SetAndClose onDone={onDone} model={mainLoopModel} sizeStr={trimmed} />
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'RESET') {
      return <ResetAndClose onDone={onDone} model={mainLoopModel} />
    }
    // Usage error — show toast
    return <UsageToast onDone={onDone} />
  }
}