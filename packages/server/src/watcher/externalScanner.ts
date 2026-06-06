/**
 * External session discovery: hook-triggered adoption, periodic filesystem
 * scanning, and stale-agent cleanup.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { AgentStateStore } from '../agentStateStore.js';
import {
  EXTERNAL_ACTIVE_THRESHOLD_MS,
  EXTERNAL_SCAN_INTERVAL_MS,
  EXTERNAL_STALE_CHECK_INTERVAL_MS,
  GLOBAL_SCAN_ACTIVE_MAX_AGE_MS,
  GLOBAL_SCAN_ACTIVE_MIN_SIZE,
} from '../constants.js';
import type { AgentState } from '../types.js';
import { makeAgentState, readNewLines, startFileWatching } from './jsonlPoller.js';
import {
  folderNameFromProjectDir,
  getHookProvider,
  invokeAgentRemovalCallback,
  requireDismissalTracker,
  trackedProjectDirs,
} from './state.js';

export function adoptExternalSessionFromHook(
  sessionId: string,
  transcriptPath: string | undefined,
  cwd: string,
  knownJsonlFiles: Set<string>,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  persistAgents: () => void,
  onAgentCreated?: (agent: AgentState) => void,
): void {
  if (transcriptPath) {
    for (const agent of agents.values()) {
      if (agent.jsonlFile === transcriptPath) return;
    }
    if (requireDismissalTracker().isDismissed(transcriptPath)) return;
    if (requireDismissalTracker().isPermanentlyDismissed(transcriptPath)) return;

    knownJsonlFiles.add(transcriptPath);
    const projectDir = path.dirname(transcriptPath);
    const folderName = folderNameFromProjectDir(path.basename(projectDir));

    adoptExternalSession(
      transcriptPath,
      projectDir,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      persistAgents,
      folderName,
    );

    const adoptedAgent = [...agents.values()].find((a) => a.jsonlFile === transcriptPath);
    if (adoptedAgent && process.env.PIXEL_AGENTS_DEBUG !== '0') {
      console.log(
        `[Pixel Agents] Hook: Agent ${adoptedAgent.id} - detected external session ${path.basename(transcriptPath)}${adoptedAgent.folderName ? ` (${adoptedAgent.folderName})` : ''}`,
      );
    }
    if (adoptedAgent) {
      adoptedAgent.sessionId = sessionId;
      adoptedAgent.hookDelivered = true;
      onAgentCreated?.(adoptedAgent);
    }
  } else {
    const id = nextAgentIdRef.current++;
    const folderName = cwd ? path.basename(cwd) : undefined;
    const agent = makeAgentState(id, sessionId, cwd, '', 0, true, {
      hookDelivered: true,
      hooksOnly: true,
      folderName,
    });
    agents.set(id, agent);
    persistAgents();
    if (process.env.PIXEL_AGENTS_DEBUG !== '0') {
      console.log(
        `[Pixel Agents] Hook: Agent ${id} - detected hooks-only external session${folderName ? ` (${folderName})` : ''}`,
      );
    }
    onAgentCreated?.(agent);
  }
}

function adoptExternalSession(
  jsonlFile: string,
  projectDir: string,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  persistAgents: () => void,
  folderName?: string,
): void {
  const id = nextAgentIdRef.current++;
  let fileOffset = 0;
  try {
    const stat = fs.statSync(jsonlFile);
    fileOffset = stat.size;
  } catch {
    /* start from beginning if stat fails */
  }

  const agent = makeAgentState(
    id,
    path.basename(jsonlFile, '.jsonl'),
    projectDir,
    jsonlFile,
    fileOffset,
    true,
    { folderName },
  );

  agents.set(id, agent);
  persistAgents();

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

export function startExternalSessionScanning(
  _projectDir: string,
  knownJsonlFiles: Set<string>,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  _jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  persistAgents: () => void,
  watchAllSessionsRef?: { current: boolean },
  hooksEnabledRef?: { current: boolean },
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    if (!hooksEnabledRef?.current) {
      for (const dir of trackedProjectDirs) {
        scanExternalDir(
          dir,
          knownJsonlFiles,
          nextAgentIdRef,
          agents,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          persistAgents,
        );
      }
    }
    if (watchAllSessionsRef?.current) {
      scanGlobalProjectDirs(
        knownJsonlFiles,
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        persistAgents,
      );
    }
  }, EXTERNAL_SCAN_INTERVAL_MS);
}

export function scanExternalDir(
  projectDir: string,
  knownJsonlFiles: Set<string>,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  persistAgents: () => void,
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

  const now = Date.now();
  const dismissal = requireDismissalTracker();

  const hasOrphanedInternal = [...agents.values()].some((a) => {
    if (a.isExternal || a.projectDir !== projectDir) return false;
    try {
      fs.statSync(a.jsonlFile);
      return false;
    } catch {
      return true;
    }
  });
  if (hasOrphanedInternal) return;

  for (const file of files) {
    const seededMtime = dismissal.getSeededMtime(file);
    if (seededMtime !== undefined) {
      try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs > seededMtime) {
          dismissal.clearSeededMtime(file);
          knownJsonlFiles.delete(file);
        }
      } catch {
        /* ignore */
      }
      continue;
    }

    if (knownJsonlFiles.has(file)) continue;
    if (dismissal.isPermanentlyDismissed(file)) continue;
    if (dismissal.isDismissed(file)) continue;

    const normalizedFile = path.resolve(file);
    let tracked = false;
    for (const agent of agents.values()) {
      if (path.resolve(agent.jsonlFile) === normalizedFile) {
        tracked = true;
        break;
      }
    }
    if (tracked) continue;

    try {
      const stat = fs.statSync(file);
      if (now - stat.mtimeMs > EXTERNAL_ACTIVE_THRESHOLD_MS) continue;
    } catch {
      continue;
    }

    try {
      const buf = Buffer.alloc(8192);
      const fd = fs.openSync(file, 'r');
      const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
      fs.closeSync(fd);
      if (buf.toString('utf-8', 0, bytesRead).includes('/clear</command-name>')) {
        if (!dismissal.hasPendingClear(file)) {
          dismissal.registerPendingClear(file);
          continue;
        }
        dismissal.clearPendingClear(file);
      }
    } catch {
      continue;
    }

    knownJsonlFiles.add(file);
    console.log(`[Pixel Agents] Watcher: detected external session ${path.basename(file)}`);
    adoptExternalSession(
      file,
      projectDir,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      persistAgents,
    );
  }
}

function scanGlobalProjectDirs(
  knownJsonlFiles: Set<string>,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  persistAgents: () => void,
): void {
  const roots = getHookProvider()?.getAllSessionRoots?.() ?? [];
  if (roots.length === 0) return;

  const projectDirs: string[] = [];
  for (const root of roots) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) projectDirs.push(path.join(root, entry.name));
      }
    } catch {
      /* root missing / unreadable -> skip */
    }
  }

  const now = Date.now();
  for (const dirPath of projectDirs) {
    if (trackedProjectDirs.has(dirPath)) continue;

    let files: string[];
    try {
      files = fs
        .readdirSync(dirPath)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(dirPath, f));
    } catch {
      continue;
    }

    for (const file of files) {
      if (knownJsonlFiles.has(file)) continue;
      let tracked = false;
      for (const agent of agents.values()) {
        if (agent.jsonlFile === file) {
          tracked = true;
          break;
        }
      }
      if (tracked) continue;
      try {
        const stat = fs.statSync(file);
        if (stat.size < GLOBAL_SCAN_ACTIVE_MIN_SIZE) continue;
        if (now - stat.mtimeMs > GLOBAL_SCAN_ACTIVE_MAX_AGE_MS) continue;
      } catch {
        continue;
      }

      const folderName = folderNameFromProjectDir(path.basename(dirPath));
      knownJsonlFiles.add(file);
      console.log(
        `[Pixel Agents] Watcher: detected global session ${path.basename(file)} (${folderName})`,
      );
      adoptExternalSession(
        file,
        dirPath,
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        persistAgents,
        folderName,
      );
    }
  }
}

export function startStaleExternalAgentCheck(
  agents: AgentStateStore,
  knownJsonlFiles: Set<string>,
  hooksEnabledRef?: { current: boolean },
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    if (hooksEnabledRef?.current) return;
    const toRemove: number[] = [];

    for (const [id, agent] of agents) {
      if (!agent.isExternal) continue;
      try {
        fs.statSync(agent.jsonlFile);
      } catch {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      const agent = agents.get(id);
      if (agent) knownJsonlFiles.delete(agent.jsonlFile);
      console.log(`[Pixel Agents] Watcher: Agent ${id} - removing stale external agent`);
      invokeAgentRemovalCallback(id);
    }
  }, EXTERNAL_STALE_CHECK_INTERVAL_MS);
}
