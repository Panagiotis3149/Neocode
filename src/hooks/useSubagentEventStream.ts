import { useEffect, useState } from 'react'
import type { SubagentSupervisor } from '../tools/AgentTool/subagentSupervisor.js'
import type { SupervisorEvent } from '../tools/AgentTool/subagentEventBus.js'

const MAX_RETAINED_EVENTS = 2_000

export function useSubagentEventStream(
  supervisor: SubagentSupervisor | undefined,
): SupervisorEvent[] {
  const [events, setEvents] = useState<SupervisorEvent[]>([])

  useEffect(() => {
    if (!supervisor) {
      setEvents([])
      return
    }

    return supervisor.subscribe(event => {
      setEvents(previous => {
        const next = [...previous, event]
        return next.length > MAX_RETAINED_EVENTS
          ? next.slice(next.length - MAX_RETAINED_EVENTS)
          : next
      })
    })
  }, [supervisor])

  return events
}
