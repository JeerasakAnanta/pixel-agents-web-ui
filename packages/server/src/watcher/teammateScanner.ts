/**
 * Teammate-specific scanning: scanForTeammateFiles, scanTeamConfigsForRemovals,
 * and scanAllTeammateFiles (periodic fallback for hooks-missed teammates).
 */
import * as fs from 'fs';
import * as path from 'path';

import type { AgentStateStore } from '../agentStateStore.js';
import type { AgentState } from '../types.js';
import { makeAgentState, readNewLines, startFileWatching } from './jsonlPoller.js';
import { getTeamProvider, knownTeammateFiles } from './state.js';

const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';

export function scanForTeammateFiles(
  projectDir: string,
  sessionId: string,
  parentAgentId: number,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  persistAgents: () => void,
  onAgentCreated?: (agent: AgentState) => void,
): void {
  const teamProvider = getTeamProvider();
  if (!teamProvider) return;

  const teammates = teamProvider.discoverTeammates(projectDir, sessionId);
  const parentAgent = agents.get(parentAgentId);

  for (const { jsonlPath: file, teammateName } of teammates) {
    if (knownTeammateFiles.has(file)) continue;

    let alreadyTracked = false;
    for (const a of agents.values()) {
      if (a.jsonlFile === file) {
        alreadyTracked = true;
        break;
      }
    }
    if (alreadyTracked) continue;

    knownTeammateFiles.add(file);

    let existingTeammate: AgentState | undefined;
    for (const a of agents.values()) {
      if (a.leadAgentId === parentAgentId && a.agentName === teammateName) {
        existingTeammate = a;
        break;
      }
    }
    if (existingTeammate) {
      if (debug)
        console.log(
          `[Pixel Agents] Teammate "${teammateName}" already exists (Agent ${existingTeammate.id}), reassigning to ${path.basename(file)}`,
        );
      const oldTimer = pollingTimers.get(existingTeammate.id);
      if (oldTimer) clearInterval(oldTimer);
      pollingTimers.delete(existingTeammate.id);
      existingTeammate.jsonlFile = file;
      existingTeammate.fileOffset = 0;
      existingTeammate.lineBuffer = '';
      existingTeammate.lastDataAt = Date.now();
      existingTeammate.linesProcessed = 0;
      existingTeammate.isWaiting = false;
      startFileWatching(
        existingTeammate.id,
        file,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
      );
      readNewLines(existingTeammate.id, agents, waitingTimers, permissionTimers);
      continue;
    }

    const id = nextAgentIdRef.current++;
    const agent = makeAgentState(id, sessionId, projectDir, file, 0, true, {
      // Keep hookDelivered false: teammates need JSONL-based tool tracking.
      hookDelivered: false,
      lastDataAt: Date.now(),
      agentName: teammateName,
      leadAgentId: parentAgentId,
      teamName: parentAgent?.teamName,
    });

    agents.set(id, agent);
    persistAgents();

    console.log(
      `[Pixel Agents] Teammate detected: "${teammateName}" (Agent ${id}) for parent Agent ${parentAgentId} (${path.basename(file)})`,
    );

    onAgentCreated?.(agent);

    startFileWatching(
      id,
      file,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
    );
    readNewLines(id, agents, waitingTimers, permissionTimers);
  }
}

export function scanTeamConfigsForRemovals(agents: AgentStateStore): number[] {
  const toRemove: number[] = [];
  const teamProvider = getTeamProvider();
  if (!teamProvider) return toRemove;

  const teammatesByTeam = new Map<string, Array<{ id: number; agent: AgentState }>>();
  for (const [id, agent] of agents) {
    if (agent.leadAgentId === undefined || agent.teamUsesTmux || !agent.teamName) continue;
    let list = teammatesByTeam.get(agent.teamName);
    if (!list) {
      list = [];
      teammatesByTeam.set(agent.teamName, list);
    }
    list.push({ id, agent });
  }

  for (const [teamName, members] of teammatesByTeam) {
    const memberNames = teamProvider.getTeamMembers(teamName);
    for (const { id, agent } of members) {
      if (memberNames === null) {
        toRemove.push(id);
      } else if (agent.agentName && !memberNames.has(agent.agentName)) {
        toRemove.push(id);
      }
    }
  }

  return toRemove;
}

export function scanAllTeammateFiles(
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  persistAgents: () => void,
  onAgentCreated?: (agent: AgentState) => void,
): void {
  for (const [agentId, agent] of agents) {
    if (agent.leadAgentId !== undefined) continue;
    if (!agent.sessionId || !agent.projectDir) continue;
    if (!agent.teamName) continue;

    scanForTeammateFiles(
      agent.projectDir,
      agent.sessionId,
      agentId,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      persistAgents,
      onAgentCreated,
    );
  }
}
