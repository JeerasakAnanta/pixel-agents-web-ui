/**
 * Team-specific hook event handling — extracted from HookEventHandler so that
 * team logic lives in one place and the main handler stays focused on session
 * routing and tool tracking.
 *
 * All functions receive a TeamHookContext instead of `this` so they are plain
 * functions (easier to test, no class coupling).
 */
import type { HookProvider } from '@pixel-agents/core/provider.js';

import type { AgentStateStore } from './agentStateStore.js';
import { debug, isDebug } from './logger.js';
import { getInlineTeammates } from './teamUtils.js';
import { cancelPermissionTimer } from './timerManager.js';
import type { AgentState } from './types.js';

/** Raw hook event payload (subset needed by team handlers). */
export interface TeamHookEvent {
  session_id: string;
  hook_event_name: string;
  [key: string]: unknown;
}

/** Callbacks for session lifecycle events needed by team handlers. */
export interface TeamLifecycleCallbacks {
  onTeammateDetected?: (parentAgentId: number, sessionId: string, agentType: string) => void;
}

/** Dependencies injected by HookEventHandler into each team handler call. */
export interface TeamHookContext {
  agents: AgentStateStore;
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
  provider: HookProvider;
  lifecycleCallbacks: TeamLifecycleCallbacks;
  /** Forward to HookEventHandler.markAgentWaiting (same logic, shared). */
  markAgentWaiting: (agent: AgentState, agentId: number) => void;
  /** Forward to HookEventHandler.getSubagentToolSet (merged provider + team sets). */
  getSubagentToolSet: () => ReadonlySet<string>;
}

/**
 * Handle SubagentStart: route between teammate spawn and basic within-turn subagent.
 *
 * - Teammate path (Agent + run_in_background + teamName set): triggers teammate
 *   discovery via lifecycle callback.
 * - Basic subagent path (Task/Agent without run_in_background): creates child
 *   character immediately without waiting for JSONL polling.
 */
export function handleSubagentStart(
  event: TeamHookEvent,
  agent: AgentState,
  agentId: number,
  ctx: TeamHookContext,
): void {
  const agentType = ctx.provider.team?.extractTeammateNameFromEvent(event) ?? 'unknown';

  if (ctx.provider.team && agent.currentHookIsTeammateSpawn === true && agent.teamName) {
    if (isDebug())
      debug(
        `[Pixel Agents] Hook: Agent ${agentId} - SubagentStart: teammate "${agentType}" detected, triggering discovery`,
      );
    ctx.lifecycleCallbacks.onTeammateDetected?.(agentId, event.session_id, agentType);
    return;
  }

  const parentTools = ctx.getSubagentToolSet();
  let parentToolId: string | undefined;
  for (const [toolId, toolName] of agent.activeToolNames) {
    if (parentTools.has(toolName)) {
      parentToolId = toolId;
      break;
    }
  }
  if (!parentToolId) return;

  const subToolId = `hook-sub-${agentType}-${Date.now()}`;
  const status = `Subtask: ${agentType}`;

  let subTools = agent.activeSubagentToolIds.get(parentToolId);
  if (!subTools) {
    subTools = new Set();
    agent.activeSubagentToolIds.set(parentToolId, subTools);
  }
  subTools.add(subToolId);

  let subNames = agent.activeSubagentToolNames.get(parentToolId);
  if (!subNames) {
    subNames = new Map();
    agent.activeSubagentToolNames.set(parentToolId, subNames);
  }
  subNames.set(subToolId, agentType);

  ctx.agents.broadcast({
    type: 'subagentToolStart',
    id: agentId,
    parentToolId,
    toolId: subToolId,
    status,
  });
}

/**
 * Handle SubagentStop: route between teammate idle and basic within-turn subagent removal.
 *
 * - Teammate path: marks inline teammates as waiting (not destroyed).
 * - Basic subagent path: removes the child character from the office.
 */
export function handleSubagentStop(agent: AgentState, agentId: number, ctx: TeamHookContext): void {
  const inlineTeammates = getInlineTeammates(agentId, ctx.agents);
  if (inlineTeammates.length > 0) {
    if (isDebug())
      debug(
        `[Pixel Agents] Hook: Agent ${agentId} - SubagentStop: marking inline teammates as waiting`,
      );
    for (const [id, a] of inlineTeammates) {
      ctx.markAgentWaiting(a, id);
    }
    return;
  }

  const subagentParentTools = ctx.getSubagentToolSet();
  let parentToolId: string | undefined;
  for (const [toolId, toolName] of agent.activeToolNames) {
    if (subagentParentTools.has(toolName) && agent.activeSubagentToolIds.has(toolId)) {
      parentToolId = toolId;
      break;
    }
  }
  if (!parentToolId) return;

  agent.activeSubagentToolIds.delete(parentToolId);
  agent.activeSubagentToolNames.delete(parentToolId);
  ctx.agents.broadcast({
    type: 'subagentClear',
    id: agentId,
    parentToolId,
  });
}

/**
 * Handle PermissionRequest when the agent has inline teammates.
 * Routes permission to the teammates instead of the lead.
 * Returns true if permission was routed to teammates, false if caller should handle it normally.
 */
export function handlePermissionRequestForTeammates(
  agentId: number,
  ctx: TeamHookContext,
): boolean {
  const inlineTeammates = getInlineTeammates(agentId, ctx.agents);
  if (inlineTeammates.length === 0) return false;

  for (const [id, a] of inlineTeammates) {
    cancelPermissionTimer(id, ctx.permissionTimers);
    a.permissionSent = true;
    ctx.agents.broadcast({ type: 'agentToolPermission', id });
  }
  return true;
}

/**
 * Handle TeammateIdle: teammate signaled it is idle and available for work.
 * Routes to the specific teammate by agentName, or marks all inline teammates waiting.
 */
export function handleTeammateIdle(
  event: TeamHookEvent,
  agent: AgentState,
  agentId: number,
  ctx: TeamHookContext,
): void {
  const agentType = ctx.provider.team?.extractTeammateNameFromEvent(event);
  const inlineTeammates = getInlineTeammates(agentId, ctx.agents);

  if (inlineTeammates.length === 0) {
    ctx.markAgentWaiting(agent, agentId);
    return;
  }

  if (agentType) {
    const match = inlineTeammates.find(([, a]) => a.agentName === agentType);
    if (match) {
      const [id, a] = match;
      if (isDebug())
        debug(`[Pixel Agents] Hook: TeammateIdle "${agentType}" -> teammate Agent ${id}`);
      ctx.markAgentWaiting(a, id);
      return;
    }
  }

  if (isDebug())
    debug(
      `[Pixel Agents] Hook: TeammateIdle (no agent_type match) -> marking ${inlineTeammates.length} teammate(s) waiting`,
    );
  for (const [id, a] of inlineTeammates) {
    ctx.markAgentWaiting(a, id);
  }
}

/**
 * Handle TaskCompleted: a teammate marked its task done.
 * Routes to the specific teammate when identifiable, otherwise marks all inline teammates waiting.
 */
export function handleTaskCompleted(
  event: TeamHookEvent,
  agentId: number,
  ctx: TeamHookContext,
): void {
  const subject = (event.subject as string) ?? '';
  const agentType = ctx.provider.team?.extractTeammateNameFromEvent(event);
  if (isDebug())
    debug(
      `[Pixel Agents] Hook: Agent ${agentId} - TaskCompleted: ${subject}${agentType ? ` (agent_type=${agentType})` : ''}`,
    );

  const inlineTeammates = getInlineTeammates(agentId, ctx.agents);
  if (inlineTeammates.length === 0) return;

  if (agentType) {
    const match = inlineTeammates.find(([, a]) => a.agentName === agentType);
    if (match) {
      const [id, a] = match;
      ctx.markAgentWaiting(a, id);
      return;
    }
  }
  for (const [id, a] of inlineTeammates) {
    ctx.markAgentWaiting(a, id);
  }
}
