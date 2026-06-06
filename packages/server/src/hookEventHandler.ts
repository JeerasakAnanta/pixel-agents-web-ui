import type { AgentEvent, HookProvider } from '@pixel-agents/core/provider.js';
import * as path from 'path';

import type { AgentStateStore } from './agentStateStore.js';
import { SESSION_END_GRACE_MS } from './constants.js';
import type { SessionRouter } from './sessionRouter.js';
import type { TeamHookContext, TeamHookEvent } from './teamHookHandler.js';
import {
  handlePermissionRequestForTeammates,
  handleSubagentStart,
  handleSubagentStop,
  handleTaskCompleted,
  handleTeammateIdle,
} from './teamHookHandler.js';
import { hasInlineTeammates } from './teamUtils.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import type { AgentState } from './types.js';

const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';

/** Normalized hook event received from any provider's hook script via the HTTP server. */
export interface HookEvent {
  hook_event_name: string;
  session_id: string;
  [key: string]: unknown;
}

/** Callback for session lifecycle events detected via hooks. */
interface SessionLifecycleCallbacks {
  onExternalSessionDetected?: (
    sessionId: string,
    transcriptPath: string | undefined,
    cwd: string,
  ) => void;
  onSessionClear?: (
    agentId: number,
    newSessionId: string,
    newTranscriptPath: string | undefined,
  ) => void;
  onSessionResume?: (transcriptPath: string) => void;
  onSessionEnd?: (agentId: number, reason: string) => void;
  onTeammateDetected?: (parentAgentId: number, sessionId: string, agentType: string) => void;
  onTeammateRemoved?: (teammateAgentId: number) => void;
}

/**
 * Dispatches normalized AgentEvents to agents based on session_id.
 * Team-specific event handling (SubagentStart, SubagentStop, TeammateIdle,
 * TaskCompleted) is delegated to teamHookHandler.ts free functions.
 */
export class HookEventHandler {
  private lifecycleCallbacks: SessionLifecycleCallbacks = {};

  private static readonly SUPPORTED_PROTOCOL_VERSION = 1;

  constructor(
    private agents: AgentStateStore,
    private waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
    private permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
    private provider: HookProvider,
    private sessionRouter: SessionRouter,
    private watchAllSessionsRef?: { current: boolean },
  ) {
    if (provider.protocolVersion !== HookEventHandler.SUPPORTED_PROTOCOL_VERSION) {
      console.warn(
        `[Pixel Agents] HookProvider "${provider.id}" reports protocolVersion=${provider.protocolVersion}, ` +
          `but handler understands ${HookEventHandler.SUPPORTED_PROTOCOL_VERSION}. ` +
          `Events from this provider will be dropped.`,
      );
    }
  }

  private getSubagentToolSet(): ReadonlySet<string> {
    if (this.provider.team) {
      return new Set<string>([
        ...this.provider.team.teammateSpawnTools,
        ...this.provider.team.withinTurnSubagentTools,
      ]);
    }
    return this.provider.subagentToolNames;
  }

  private isTrackedSession(transcriptPath?: string, cwd?: string): boolean {
    if (this.watchAllSessionsRef?.current) return true;
    const projectDir = transcriptPath ? path.dirname(transcriptPath) : cwd;
    if (!projectDir) return false;
    return [...this.agents.values()].some(
      (a) => path.resolve(a.projectDir).toLowerCase() === path.resolve(projectDir).toLowerCase(),
    );
  }

  setLifecycleCallbacks(callbacks: SessionLifecycleCallbacks): void {
    this.lifecycleCallbacks = callbacks;
  }

  registerAgent(sessionId: string, agentId: number): void {
    const flushed = this.sessionRouter.register(sessionId, agentId);
    if (debug && flushed.length > 0)
      console.log(
        `[Pixel Agents] Hook: flushing ${flushed.length} buffered event(s) for session ${sessionId.slice(0, 8)}...`,
      );
    for (const { providerId, event } of flushed) {
      this.handleEvent(providerId, event as HookEvent);
    }
  }

  unregisterAgent(sessionId: string): void {
    this.sessionRouter.unregister(sessionId);
  }

  handleEvent(_providerId: string, event: HookEvent): void {
    if (this.provider.protocolVersion !== HookEventHandler.SUPPORTED_PROTOCOL_VERSION) {
      return;
    }
    const normalized = this.provider.normalizeHookEvent(event);
    if (!normalized) return;
    const normEvent = normalized.event;
    const eventName = event.hook_event_name;

    if (normEvent.kind === 'sessionStart') {
      const sid = event.session_id.slice(0, 8);
      const source = normEvent.source ?? 'unknown';
      const transcriptPath = normEvent.transcriptPath;
      const cwd = normEvent.cwd;
      const tracked = this.isTrackedSession(transcriptPath, cwd);
      if (debug && tracked)
        console.log(`[Pixel Agents] Hook: SessionStart(source=${source}, session=${sid}...)`);

      const existingAgentId = this.sessionRouter.resolve(event.session_id);
      if (existingAgentId !== undefined) {
        const agent = this.agents.get(existingAgentId);
        if (agent) {
          agent.hookDelivered = true;
          if (!agent.isWaiting) {
            agent.isWaiting = true;
            this.agents.broadcast({ type: 'agentStatus', id: existingAgentId, status: 'waiting' });
          }
        }
        if (debug)
          console.log(
            `[Pixel Agents] Hook: Agent ${existingAgentId} - SessionStart(source=${source}) known`,
          );
        return;
      }
      for (const [id, agent] of this.agents) {
        if (agent.sessionId === event.session_id) {
          this.registerAgent(agent.sessionId, id);
          agent.hookDelivered = true;
          if (!agent.isWaiting) {
            agent.isWaiting = true;
            this.agents.broadcast({ type: 'agentStatus', id, status: 'waiting' });
          }
          if (debug)
            console.log(
              `[Pixel Agents] Hook: Agent ${id} - SessionStart(source=${source}) auto-discovered`,
            );
          return;
        }
      }
      if (normEvent.source === 'clear' || normEvent.source === 'resume') {
        const projectDir = transcriptPath ? path.dirname(transcriptPath) : cwd;
        if (projectDir) {
          for (const [id, agent] of this.agents) {
            const isMatch =
              agent.pendingClear &&
              path.resolve(agent.projectDir).toLowerCase() ===
                path.resolve(projectDir).toLowerCase();
            if (isMatch) {
              agent.pendingClear = false;
              console.log(
                `[Pixel Agents] Hook: Agent ${id} - /${normEvent.source} detected, reassigning to ${event.session_id}`,
              );
              this.sessionRouter.unregister(agent.sessionId);
              this.registerAgent(event.session_id, id);
              this.lifecycleCallbacks.onSessionClear?.(id, event.session_id, transcriptPath);
              return;
            }
          }
        }
      }
      if (transcriptPath || cwd) {
        if (normEvent.source === 'resume' && transcriptPath) {
          this.lifecycleCallbacks.onSessionResume?.(transcriptPath);
        }
        if (debug && tracked)
          console.log(
            `[Pixel Agents] Hook: SessionStart(source=${source}) -> pending external session ${sid}..., awaiting confirmation`,
          );
        this.sessionRouter.storePending(event.session_id, {
          sessionId: event.session_id,
          transcriptPath,
          cwd: cwd ?? '',
        });
      } else {
        if (debug && tracked)
          console.log(
            `[Pixel Agents] Hook: SessionStart -> unknown session ${sid}..., no transcript_path`,
          );
      }
      return;
    }

    if (normEvent.kind === 'sessionEnd' && this.sessionRouter.hasPending(event.session_id)) {
      this.sessionRouter.discardPending(event.session_id);
      if (debug)
        console.log(
          `[Pixel Agents] Hook: SessionEnd discarded pending external session ${event.session_id.slice(0, 8)}...`,
        );
      return;
    }

    const pending = this.sessionRouter.confirmPending(event.session_id);
    if (pending) {
      if (debug)
        console.log(
          `[Pixel Agents] Hook: ${eventName} confirmed external session ${event.session_id.slice(0, 8)}..., creating agent`,
        );
      this.lifecycleCallbacks.onExternalSessionDetected?.(
        pending.sessionId,
        pending.transcriptPath,
        pending.cwd,
      );
      this.handleEvent(_providerId, event);
      return;
    }

    let agentId = this.sessionRouter.resolve(event.session_id);
    if (agentId === undefined) {
      for (const [id, agent] of this.agents) {
        if (agent.sessionId === event.session_id) {
          this.registerAgent(agent.sessionId, id);
          agentId = id;
          break;
        }
      }
    }
    if (agentId === undefined) {
      const isPending = this.sessionRouter.hasPending(event.session_id);
      const hasBuffered = this.sessionRouter.hasBuffered(event.session_id);
      const hasUnregisteredAgents = [...this.agents.values()].some(
        (a) => a.sessionId && !this.sessionRouter.hasSession(a.sessionId),
      );
      if (isPending || hasBuffered || hasUnregisteredAgents) {
        if (debug)
          console.log(
            `[Pixel Agents] Hook: ${eventName} - unknown session ${event.session_id.slice(0, 8)}..., buffering`,
          );
        this.sessionRouter.bufferEvent(_providerId, event);
      }
      return;
    }

    const agent = this.agents.get(agentId);
    if (!agent) return;

    agent.hookDelivered = true;
    if (debug)
      console.log(
        `[Pixel Agents] Hook: Agent ${agentId} - ${eventName} (session=${event.session_id.slice(0, 8)}...)`,
      );

    switch (normEvent.kind) {
      case 'sessionEnd':
        return this.handleSessionEnd(normEvent, agent, agentId);
      case 'toolStart':
        return this.handlePreToolUse(normEvent, agent, agentId);
      case 'toolEnd':
        return this.handlePostToolUse(agent, agentId);
      case 'subagentStart':
        if (!this.provider.team) return;
        return handleSubagentStart(event as TeamHookEvent, agent, agentId, this.teamCtx());
      case 'subagentEnd':
        if (!this.provider.team) return;
        return handleSubagentStop(agent, agentId, this.teamCtx());
      case 'permissionRequest':
        return this.handlePermissionRequest(agent, agentId);
      case 'turnEnd':
        return this.handleStop(agent, agentId);
      case 'subagentTurnEnd':
        if (!this.provider.team) return;
        if (normEvent.reason === 'completed') {
          return handleTaskCompleted(event as TeamHookEvent, agentId, this.teamCtx());
        }
        return handleTeammateIdle(event as TeamHookEvent, agent, agentId, this.teamCtx());
      case 'progress':
        return;
    }
  }

  /** Build the TeamHookContext snapshot for team handler delegation. */
  private teamCtx(): TeamHookContext {
    return {
      agents: this.agents,
      permissionTimers: this.permissionTimers,
      provider: this.provider,
      lifecycleCallbacks: {
        onTeammateDetected: this.lifecycleCallbacks.onTeammateDetected,
      },
      markAgentWaiting: (agent, agentId) => this.markAgentWaiting(agent, agentId),
      getSubagentToolSet: () => this.getSubagentToolSet(),
    };
  }

  private handleSessionEnd(
    normEvent: Extract<AgentEvent, { kind: 'sessionEnd' }>,
    agent: AgentState,
    agentId: number,
  ): void {
    const reason = normEvent.reason;
    if (debug)
      console.log(
        `[Pixel Agents] Hook: Agent ${agentId} - SessionEnd(reason=${reason ?? 'unknown'})`,
      );

    const expectsFollowUp = reason === 'clear' || reason === 'resume';

    if (expectsFollowUp) {
      agent.pendingClear = true;
      this.markAgentWaiting(agent, agentId);
      if (debug)
        console.log(
          `[Pixel Agents] Hook: Agent ${agentId} - SessionEnd(reason=${reason}), awaiting possible SessionStart`,
        );
      setTimeout(() => {
        if (agent.pendingClear) {
          agent.pendingClear = false;
          this.lifecycleCallbacks.onSessionEnd?.(agentId, reason);
        }
      }, SESSION_END_GRACE_MS);
    } else {
      this.markAgentWaiting(agent, agentId);
      this.lifecycleCallbacks.onSessionEnd?.(agentId, reason ?? 'unknown');
    }
  }

  private handlePreToolUse(
    normEvent: Extract<AgentEvent, { kind: 'toolStart' }>,
    agent: AgentState,
    agentId: number,
  ): void {
    const toolName = normEvent.toolName;
    const toolInput = (normEvent.input as Record<string, unknown> | undefined) ?? {};
    const status = this.provider.formatToolStatus(toolName, toolInput);
    const hookToolId = `hook-${Date.now()}`;

    agent.currentHookToolId = hookToolId;
    agent.currentHookToolName = toolName;
    agent.currentHookIsTeammateSpawn =
      this.provider.team?.isTeammateSpawnCall(toolName, toolInput) ?? false;

    if (hasInlineTeammates(agentId, this.agents)) return;

    cancelWaitingTimer(agentId, this.waitingTimers);
    agent.isWaiting = false;
    agent.permissionSent = false;
    agent.hadToolsInTurn = true;

    if (toolName !== 'Task' && toolName !== 'Agent') {
      this.agents.broadcast({
        type: 'agentToolStart',
        id: agentId,
        toolId: hookToolId,
        status,
        toolName,
      });
    }
    this.agents.broadcast({
      type: 'agentStatus',
      id: agentId,
      status: 'active',
    });
  }

  private handlePostToolUse(agent: AgentState, agentId: number): void {
    if (agent.currentHookToolId) {
      if (!hasInlineTeammates(agentId, this.agents)) {
        this.agents.broadcast({
          type: 'agentToolDone',
          id: agentId,
          toolId: agent.currentHookToolId,
        });
      }
      agent.currentHookToolId = undefined;
      agent.currentHookToolName = undefined;
    }
  }

  private handlePermissionRequest(agent: AgentState, agentId: number): void {
    if (handlePermissionRequestForTeammates(agentId, this.teamCtx())) return;

    cancelPermissionTimer(agentId, this.permissionTimers);
    agent.permissionSent = true;
    this.agents.broadcast({
      type: 'agentToolPermission',
      id: agentId,
    });
    for (const parentToolId of agent.activeSubagentToolNames.keys()) {
      this.agents.broadcast({
        type: 'subagentToolPermission',
        id: agentId,
        parentToolId,
      });
    }
  }

  private handleStop(agent: AgentState, agentId: number): void {
    this.markAgentWaiting(agent, agentId);
  }

  private markAgentWaiting(agent: AgentState, agentId: number): void {
    cancelWaitingTimer(agentId, this.waitingTimers);
    cancelPermissionTimer(agentId, this.permissionTimers);

    const parentTools = this.getSubagentToolSet();
    for (const toolId of [...agent.activeToolIds]) {
      if (agent.backgroundAgentToolIds.has(toolId)) continue;
      agent.activeToolIds.delete(toolId);
      agent.activeToolStatuses.delete(toolId);
      const toolName = agent.activeToolNames.get(toolId);
      agent.activeToolNames.delete(toolId);
      if (toolName && parentTools.has(toolName)) {
        agent.activeSubagentToolIds.delete(toolId);
        agent.activeSubagentToolNames.delete(toolId);
      }
    }
    this.agents.broadcast({ type: 'agentToolsClear', id: agentId });
    for (const toolId of agent.backgroundAgentToolIds) {
      const status = agent.activeToolStatuses.get(toolId);
      if (status) {
        this.agents.broadcast({
          type: 'agentToolStart',
          id: agentId,
          toolId,
          status,
        });
      }
    }

    agent.isWaiting = true;
    agent.permissionSent = false;
    agent.hadToolsInTurn = false;
    this.agents.broadcast({
      type: 'agentStatus',
      id: agentId,
      status: 'waiting',
    });
  }

  dispose(): void {
    this.sessionRouter.dispose();
  }
}
