import { useEffect, useRef } from 'react'
import { logError } from 'src/utils/log.js'
import { z } from 'zod/v4'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
} from '../services/mcp/types.js'
import { drainIDEAdditions, getConnectedIdeClient } from '../utils/ide.js'
import { lazySchema } from '../utils/lazySchema.js'
export type SelectionPoint = {
  line: number
  character: number
}

export type SelectionData = {
  selection: {
    start: SelectionPoint
    end: SelectionPoint
  } | null
  text?: string
  filePath?: string
}

export type IDESelection = {
  lineCount: number
  lineStart?: number
  text?: string
  filePath?: string
}

// Define the selection changed notification schema
const SelectionChangedSchema = lazySchema(() =>
  z.object({
    method: z.literal('selection_changed'),
    params: z.object({
      selection: z
        .object({
          start: z.object({
            line: z.number(),
            character: z.number(),
          }),
          end: z.object({
            line: z.number(),
            character: z.number(),
          }),
        })
        .nullable()
        .optional(),
      text: z.string().optional(),
      filePath: z.string().optional(),
    }),
  }),
)

/**
 * A hook that tracks IDE text selection information by directly registering
 * with MCP client notification handlers
 */
export function useIdeSelection(
  mcpClients: MCPServerConnection[],
  onSelect: (selection: IDESelection) => void,
): void {
  const handlersRegistered = useRef(false)
  const currentIDERef = useRef<ConnectedMCPServer | null>(null)

  useEffect(() => {
    // Find the IDE client from the MCP clients list
    const ideClient = getConnectedIdeClient(mcpClients)

    // If the IDE client changed, we need to re-register handlers.
    // Normalize undefined to null so the initial ref value (null) matches
    // "no IDE found" (undefined), avoiding spurious resets on every MCP update.
    if (currentIDERef.current !== (ideClient ?? null)) {
      handlersRegistered.current = false
      currentIDERef.current = ideClient || null
      // Reset the selection when the IDE client changes.
      onSelect({
        lineCount: 0,
        lineStart: undefined,
        text: undefined,
        filePath: undefined,
      })
    }

    // Skip if we've already registered handlers for the current IDE or if there's no IDE client
    if (handlersRegistered.current || !ideClient) {
      return
    }

    // Handler function for selection changes
    const selectionChangeHandler = (data: SelectionData) => {
      if (data.selection?.start && data.selection?.end) {
        const { start, end } = data.selection
        let lineCount = end.line - start.line + 1
        // If on the first character of the line, do not count the line
        // as being selected.
        if (end.character === 0) {
          lineCount--
        }
        const selection = {
          lineCount,
          lineStart: start.line,
          text: data.text,
          filePath: data.filePath,
        }

        onSelect(selection)
      }
    }

    // Register notification handler for selection_changed events
    ideClient.client.setNotificationHandler(
      SelectionChangedSchema(),
      notification => {
        if (currentIDERef.current !== ideClient) {
          return
        }

        try {
          // Get the selection data from the notification params
          const selectionData = notification.params

          // Process selection data - validate it has required properties
          if (
            selectionData.selection &&
            selectionData.selection.start &&
            selectionData.selection.end
          ) {
            // Handle selection changes
            selectionChangeHandler(selectionData as SelectionData)
          } else if (selectionData.text !== undefined) {
            // Handle empty selection (when text is empty string)
            selectionChangeHandler({
              selection: null,
              text: selectionData.text,
              filePath: selectionData.filePath,
            })
          }
        } catch (error) {
          logError(error as Error)
        }
      },
    )

    // Mark that we've registered handlers
    handlersRegistered.current = true

    // No cleanup needed as MCP clients manage their own lifecycle
  }, [mcpClients, onSelect])
}

/**
 * Drain the IDE addToContext FIFO queue and append each entry to the prompt input.
 *
 * The JetBrains right-click "Add to Neocode Context" action pushes payloads
 * via MCP notification. They land in `pendingIDEAdditions` (see `registerAddToContextHandler`
 * in `utils/ide.ts`). This hook drains the queue on an interval and:
 *   - appends each entry's `text` to the active prompt input via `onAppend`
 *   - emits a `notify` callback for any entry where the IDE signalled `fits: false`
 *     (text exceeded the context window — user gets a heads-up)
 *
 * Polling instead of a direct subscription: notifications are delivered to the
 * MCP client's notification handler (in `registerAddToContextHandler`), but the
 * consumer here is the React prompt input. Bridging via a small in-memory queue
 * + interval keeps the React tree out of the MCP notification hot path.
 *
 * No-op when no IDE client is connected.
 */
export function useAddToContext(
  mcpClients: MCPServerConnection[],
  onAppend: (text: string) => void,
  notify?: (entry: { textLength: number; fits: boolean }) => void,
): void {
  // Track the current IDE client so we stop draining when the IDE disconnects.
  // The queue is global; we don't need to clear it — undrained entries from a
  // disconnected IDE will simply be picked up by the next connection.
  const ideClient = getConnectedIdeClient(mcpClients)
  const hasIDE = !!ideClient

  useEffect(() => {
    if (!hasIDE) return
    const interval = setInterval(() => {
      const drained = drainIDEAdditions()
      if (drained.length === 0) return
      for (const entry of drained) {
        try {
          onAppend(entry.text)
          if (notify && entry.fits === false) {
            notify({ textLength: entry.text.length, fits: false })
          }
        } catch (err) {
          logError(err as Error)
        }
      }
    }, 250)
    return () => clearInterval(interval)
  }, [hasIDE, onAppend, notify])
}
