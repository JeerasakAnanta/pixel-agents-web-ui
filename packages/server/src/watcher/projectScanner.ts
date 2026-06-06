/**
 * Project-level JSONL scanning: ensureProjectScan, scanForNewJsonlFiles,
 * and terminal adoption for heuristic-mode session detection.
 */
import type { TerminalHandle } from '@pixel-agents/core/terminalAdapter.js';
import * as fs from 'fs';
import * as path from 'path';

import type { AgentStateStore } from '../agentStateStore.js';
import { PROJECT_SCAN_INTERVAL_MS } from '../constants.js';
import type { AgentState } from '../types.js';
import { makeAgentState, readNewLines, startFileWatching } from './jsonlPoller.js';
import {
  getClearDetectionDeps,
  getHookProvider,
  getTerminalAdapter,
  invokeAgentRemovalCallback,
  requireDismissalTracker,
  setClearDetectionDeps,
  trackedProjectDirs,
} from './state.js';
import { scanAllTeammateFiles, scanTeamConfigsForRemovals } from './teammateScanner.js';

export function ensureProjectScan(
  projectDir: string,
  knownJsonlFiles: Set<string>,
  projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
  activeAgentIdRef: { current: number | null },
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  persistAgents: () => void,
  _onAgentCreated?: (agent: AgentState) => void,
  hooksEnabledRef?: { current: boolean },
): void {
  if (!getClearDetectionDeps()) {
    setClearDetectionDeps({
      projectDir,
      knownJsonlFiles,
      activeAgentIdRef,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      persistAgents,
    });
  }

  try {
    const files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(projectDir, f));
    for (const f of files) {
      knownJsonlFiles.add(f);
      try {
        const stat = fs.statSync(f);
        requireDismissalTracker().seedMtime(f, stat.mtimeMs);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* dir may not exist yet */
  }

  trackedProjectDirs.add(projectDir);

  if (projectScanTimerRef.current) return;
  projectScanTimerRef.current = setInterval(() => {
    scanAllTeammateFiles(
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      persistAgents,
    );

    const toRemove = scanTeamConfigsForRemovals(agents);
    for (const id of toRemove) {
      invokeTeammateRemovalCallback(id);
    }

    if (hooksEnabledRef?.current) return;

    for (const dir of trackedProjectDirs) {
      scanForNewJsonlFiles(
        dir,
        knownJsonlFiles,
        activeAgentIdRef,
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        persistAgents,
      );
    }
  }, PROJECT_SCAN_INTERVAL_MS);
}

export function scanForNewJsonlFiles(
  projectDir: string,
  knownJsonlFiles: Set<string>,
  activeAgentIdRef: { current: number | null },
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  persistAgents: () => void,
  onAgentCreated?: (agent: AgentState) => void,
): void {
  let files: string[];
  try {
    files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(projectDir, f));
  } catch {
    return;
  }

  const terminalAdapter = getTerminalAdapter();
  const hookProvider = getHookProvider();

  for (const file of files) {
    if (knownJsonlFiles.has(file)) continue;

    const activeTerminal = terminalAdapter?.activeTerminal();
    if (
      activeTerminal &&
      hookProvider?.terminalNamePrefix &&
      activeTerminal.name.startsWith(hookProvider.terminalNamePrefix)
    ) {
      let owned = false;
      for (const agent of agents.values()) {
        if (agent.terminalRef === activeTerminal) {
          owned = true;
          break;
        }
      }
      if (!owned) {
        knownJsonlFiles.add(file);
        adoptTerminalForFile(
          activeTerminal,
          file,
          projectDir,
          nextAgentIdRef,
          agents,
          activeAgentIdRef,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          persistAgents,
        );
      } else {
        for (const terminal of terminalAdapter?.allTerminals() ?? []) {
          if (
            !hookProvider?.terminalNamePrefix ||
            !terminal.name.startsWith(hookProvider.terminalNamePrefix)
          )
            continue;
          let ownedByOther = false;
          for (const agent of agents.values()) {
            if (agent.terminalRef === terminal) {
              ownedByOther = true;
              break;
            }
          }
          if (!ownedByOther) {
            knownJsonlFiles.add(file);
            adoptTerminalForFile(
              terminal,
              file,
              projectDir,
              nextAgentIdRef,
              agents,
              activeAgentIdRef,
              fileWatchers,
              pollingTimers,
              waitingTimers,
              permissionTimers,
              persistAgents,
              onAgentCreated,
            );
            break;
          }
        }
      }
    }
  }

  for (const [id, agent] of agents) {
    if (agent.isExternal) continue;
    if (agent.terminalRef && agent.terminalRef.exitStatus !== undefined) {
      console.log(`[Pixel Agents] Watcher: Agent ${id} - terminal closed, cleaning up orphan`);
      invokeAgentRemovalCallback(id);
    }
  }
}

function adoptTerminalForFile(
  terminal: TerminalHandle,
  jsonlFile: string,
  projectDir: string,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  activeAgentIdRef: { current: number | null },
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  persistAgents: () => void,
  onAgentCreated?: (agent: AgentState) => void,
): void {
  const id = nextAgentIdRef.current++;
  const sessionId = path.basename(jsonlFile, '.jsonl');
  let fileOffset = 0;
  try {
    const stat = fs.statSync(jsonlFile);
    fileOffset = stat.size;
  } catch {
    /* start from beginning if stat fails */
  }

  const agent = makeAgentState(id, sessionId, projectDir, jsonlFile, fileOffset, false, {
    terminalRef: terminal,
    isWaiting: false,
    lastDataAt: 0,
  });

  agents.set(id, agent);
  activeAgentIdRef.current = id;
  persistAgents();
  onAgentCreated?.(agent);

  console.log(
    `[Pixel Agents] Watcher: Agent ${id} - adopted terminal "${terminal.name}" for ${path.basename(jsonlFile)}`,
  );

  startFileWatching(
    id,
    jsonlFile,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
  );
  readNewLines(id, agents, waitingTimers, permissionTimers);
}

// Re-export for callers that import this via projectScanner
import { invokeTeammateRemovalCallback } from './state.js';
