/**
 * Core JSONL file polling: startFileWatching, readNewLines, reassignAgentToFile.
 * Uses a single setInterval (500ms) per agent — reliable on all platforms.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { AgentStateStore } from '../agentStateStore.js';
import { CLEAR_IDLE_THRESHOLD_MS, FILE_WATCHER_POLL_INTERVAL_MS } from '../constants.js';
import { cancelPermissionTimer, cancelWaitingTimer, clearAgentActivity } from '../timerManager.js';
import { processTranscriptLine } from '../transcriptParser.js';
import type { AgentState } from '../types.js';
import { getClearDetectionDeps, requireDismissalTracker } from './state.js';

export function startFileWatching(
  agentId: number,
  _filePath: string,
  agents: AgentStateStore,
  _fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  // Single polling approach: reliable on all platforms (macOS, Linux, WSL2, Windows).
  const interval = setInterval(() => {
    if (!agents.has(agentId)) {
      clearInterval(interval);
      return;
    }
    const agent = agents.get(agentId)!;
    const prevOffset = agent.fileOffset;
    readNewLines(agentId, agents, waitingTimers, permissionTimers);

    // HEURISTIC FALLBACK: Per-agent /clear detection (skipped when hooks handle sessions).
    const clearDeps = getClearDetectionDeps();
    if (
      !agent.hookDelivered &&
      clearDeps &&
      agent.fileOffset === prevOffset &&
      agent.terminalRef &&
      !agent.isExternal &&
      ![...agents.values()].some((a) => a.isExternal) &&
      agent.linesProcessed > 0 &&
      clearDeps.activeAgentIdRef.current === agentId &&
      Date.now() - agent.lastDataAt > CLEAR_IDLE_THRESHOLD_MS
    ) {
      try {
        const dirFiles = fs
          .readdirSync(clearDeps.projectDir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => path.join(clearDeps.projectDir, f));

        for (const file of dirFiles) {
          if (clearDeps.knownJsonlFiles.has(file)) continue;
          if (requireDismissalTracker().isDismissed(file)) continue;
          let tracked = false;
          for (const a of agents.values()) {
            if (a.jsonlFile === file) {
              tracked = true;
              break;
            }
          }
          if (tracked) continue;
          try {
            const buf = Buffer.alloc(8192);
            const fd = fs.openSync(file, 'r');
            const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
            fs.closeSync(fd);
            if (!buf.toString('utf-8', 0, bytesRead).includes('/clear</command-name>')) continue;
          } catch {
            continue;
          }
          clearDeps.knownJsonlFiles.add(file);
          console.log(
            `[Pixel Agents] Watcher: Agent ${agentId} - /clear detected, reassigning to ${path.basename(file)}`,
          );
          reassignAgentToFile(
            agentId,
            file,
            agents,
            clearDeps.fileWatchers,
            clearDeps.pollingTimers,
            clearDeps.waitingTimers,
            clearDeps.permissionTimers,
            clearDeps.persistAgents,
          );
          break;
        }
      } catch {
        /* ignore dir read errors */
      }
    }
  }, FILE_WATCHER_POLL_INTERVAL_MS);
  pollingTimers.set(agentId, interval);
}

export function readNewLines(
  agentId: number,
  agents: AgentStateStore,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;
  try {
    const stat = fs.statSync(agent.jsonlFile);
    if (stat.size <= agent.fileOffset) return;

    // Cap single read at 64KB to prevent blocking on massive JSONL dumps.
    const MAX_READ_BYTES = 65536;
    const bytesToRead = Math.min(stat.size - agent.fileOffset, MAX_READ_BYTES);
    const buf = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(agent.jsonlFile, 'r');
    fs.readSync(fd, buf, 0, buf.length, agent.fileOffset);
    fs.closeSync(fd);
    agent.fileOffset += bytesToRead;

    const text = agent.lineBuffer + buf.toString('utf-8');
    const lines = text.split('\n');
    agent.lineBuffer = lines.pop() || '';

    const hasLines = lines.some((l) => l.trim());
    if (hasLines) {
      cancelWaitingTimer(agentId, waitingTimers);
      cancelPermissionTimer(agentId, permissionTimers);
      if (agent.permissionSent && !agent.hookDelivered && !agent.leadAgentId) {
        agent.permissionSent = false;
        agents.broadcast({ type: 'agentToolPermissionClear', id: agentId });
      }
    }

    for (const line of lines) {
      if (!line.trim()) continue;
      processTranscriptLine(agentId, line, agents, waitingTimers, permissionTimers);
    }
  } catch (e) {
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') return;
    console.log(`[Pixel Agents] Watcher: Agent ${agentId} - read error: ${e}`);
  }
}

export function reassignAgentToFile(
  agentId: number,
  newFilePath: string,
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  persistAgents: () => void,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  fileWatchers.get(agentId)?.close();
  fileWatchers.delete(agentId);
  const pt = pollingTimers.get(agentId);
  if (pt) clearInterval(pt);
  pollingTimers.delete(agentId);

  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);
  clearAgentActivity(agent, agentId, agents, permissionTimers);

  requireDismissalTracker().permanentlyDismiss(agent.jsonlFile);

  agent.sessionId = path.basename(newFilePath, '.jsonl');
  agent.jsonlFile = newFilePath;
  agent.fileOffset = 0;
  agent.lineBuffer = '';
  persistAgents();

  startFileWatching(
    agentId,
    newFilePath,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
  );
  readNewLines(agentId, agents, waitingTimers, permissionTimers);
}

/** Create a new AgentState shell (shared between adoptTerminalForFile and adoptExternalSession). */
export function makeAgentState(
  id: number,
  sessionId: string,
  projectDir: string,
  jsonlFile: string,
  fileOffset: number,
  isExternal: boolean,
  extra?: Partial<AgentState>,
): AgentState {
  return {
    id,
    sessionId,
    terminalRef: undefined,
    isExternal,
    projectDir,
    jsonlFile,
    fileOffset,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    hookDelivered: false,
    lastDataAt: Date.now(),
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    inputTokens: 0,
    outputTokens: 0,
    ...extra,
  };
}
