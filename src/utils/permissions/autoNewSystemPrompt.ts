/**
 * Extra system-prompt section appended when the active permission mode is
 * Auto (New). Instructs the model to operate autonomously within the
 * per-category policy, only escalating when the policy requires a prompt.
 *
 * `thinkDepth` scales how strongly the model weighs the danger of each action
 * before proceeding. It is implemented purely here — by adjusting the prompt
 * text — and is independent of reasoning effort.
 */

import { getAutoNewModeConfig } from '../settings/settings.js'

// Maps a 1..5 thinkDepth to a short, operationally-worded caution directive.
// Kept deliberately un-alarming: the goal is calibration, not fear.
function dangerConsiderationFor(depth: number): string {
  switch (depth) {
    case 1:
      return 'Treat routine actions as low-stakes. Proceed on your judgement; only pause for clearly irreversible or external-facing operations.'
    case 2:
      return 'Consider the consequence of each action briefly before acting, but keep momentum on ordinary work.'
    case 3:
      return 'For each action, weigh whether it changes shared state, leaves the machine, or is hard to undo — and slow down accordingly.'
    case 4:
      return 'Before acting, explicitly weigh the blast radius: is this reversible, does it touch other users/services, could it lose work? Prefer the safer path when in doubt.'
    case 5:
      return 'Assume every action could matter. Before each step, reason about reversibility, audience, and data loss, and only proceed when you are confident it is the right call. When uncertain, ask.'
    default:
      return 'Consider the consequence of each action briefly before acting, but keep momentum on ordinary work.'
  }
}

export function getAutoNewModeSystemPrompt(): string {
  const config = getAutoNewModeConfig()
  const policyLine = (label: string, value: string) => `- ${label}: ${value}`

  const dangerNote = dangerConsiderationFor(config.thinkDepth)

  const thinkModeNote =
    config.thinkMode === '1'
      ? '1 = reflect "is this really needed?" then still surface it to the user'
      : '2 = reflect "is this safe enough?" then proceed silently (default)'

  return `You are running in Auto (New) mode — an autonomous permission mode.

Operating principles:
- Proceed with routine work WITHOUT asking the user for confirmation whenever the
  per-category policy below permits it. Do not pause to narrate safe, ordinary actions.
- You may read from temp/ directories and standard system introspection freely.
- Only escalate to the user when a command falls into a category whose policy is
  "ask", or a "think" category that reflection does not clear.
- For "think" categories: if the policy is "think", reflect per your thinkMode and
  then proceed or ask accordingly. If the policy is "thinkToThink", briefly check
  whether this is even worth thinking about: if it is minor, just proceed; only if
  it gives you pause, do a normal Think. It is a light triage, not a double-effort
  Think.
- When you DO need to ask, keep it short and specific about what is risky.

How strongly to weigh danger (thinkDepth = ${config.thinkDepth}):
${dangerNote}

Per-category policy (allow = proceed silently, think = reflect then proceed/ask,
thinkToThink = brief triage: proceed unless it's worth a normal Think, ask = prompt the user):
${policyLine('soft delete / move to recycle (trash, remove without force)', config.recycleBin)}
${policyLine('permanent delete (remove with force, git clean, git reset --hard)', config.shiftDelete)}
${policyLine('reading from temp/ directories', config.tempRead)}
${policyLine('writing to temp/ directories', config.tempWrite)}
${policyLine('read-only network actions (fetch, GET requests, listing remotes)', config.onlineRead)}
${policyLine('network writes / uploads (push, POST, publish, copy to remote)', config.onlineWrite)}
${policyLine('listing what is running (process / task listing)', config.systemRead)}
${policyLine('stopping or restarting a process / service', config.systemWrite)}
${policyLine('everything else', config.other)}
- thinkMode: ${config.thinkMode} (${thinkModeNote})

Stay within the user's workspace. Never bypass safety checks for irreversible or
externally-visible operations that the policy routes to the user.`
}
