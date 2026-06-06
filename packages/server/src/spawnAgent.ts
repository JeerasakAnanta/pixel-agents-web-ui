import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import { readNewLines, startFileWatching } from './fileWatcher.js';
import { claudeProvider } from './providers/index.js';

export async function spawnAgent(
  store: AgentStateStore,
  runtime: AgentRuntime,
  options: { cwd?: string; bypassPermissions?: boolean } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const sessionId = crypto.randomUUID();

  const launch = claudeProvider.buildLaunchCommand!(sessionId, cwd, {
    bypassPermissions: options.bypassPermissions,
  });

  const dirs = claudeProvider.getSessionDirs!(cwd);
  const projectDir = dirs[0];
  if (!projectDir) throw new Error('No project dir for cwd: ' + cwd);

  const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);
  runtime.knownJsonlFiles.add(expectedFile);

  const id = store.nextAgentId.current++;

  // Spawn claude as a headless child process with a piped stdin so the server
  // can write user prompts directly via WebSocket → sendPrompt → agent.stdinRef.
  // stdout/stderr are ignored — claude always writes its transcript to the JSONL
  // file, which is what the server watches for state changes.
  const fullEnv = { ...process.env, ...(launch.env ?? {}) };
  const proc = childProcess.spawn(launch.command, launch.args, {
    cwd,
    env: fullEnv,
    stdio: ['pipe', 'ignore', 'ignore'],
  });

  const agent = {
    id,
    sessionId,
    terminalRef: undefined,
    isExternal: true,
    projectDir,
    jsonlFile: expectedFile,
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set<string>(),
    activeToolStatuses: new Map<string, string>(),
    activeToolNames: new Map<string, string>(),
    activeSubagentToolIds: new Map<string, Set<string>>(),
    activeSubagentToolNames: new Map<string, Map<string, string>>(),
    backgroundAgentToolIds: new Set<string>(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set<string>(),
    hookDelivered: false,
    inputTokens: 0,
    outputTokens: 0,
    stdinRef: proc.stdin ?? undefined,
  };

  // Remove agent when the claude process exits (normal exit, crash, or user /exit)
  proc.on('exit', () => {
    console.log(`[Pixel Agents] Agent ${id}: process exited`);
    runtime.removeAgent(id);
  });

  store.set(id, agent);
  store.persist();
  runtime.startProjectScan(projectDir);
  runtime.registerAgent(sessionId, id);

  const pollTimer = setInterval(() => {
    if (fs.existsSync(agent.jsonlFile)) {
      clearInterval(pollTimer);
      runtime.jsonlPollTimers.delete(id);
      startFileWatching(
        id,
        agent.jsonlFile,
        store,
        runtime.fileWatchers,
        runtime.pollingTimers,
        runtime.waitingTimers,
        runtime.permissionTimers,
      );
      readNewLines(id, store, runtime.waitingTimers, runtime.permissionTimers);
    }
  }, 1000);
  runtime.jsonlPollTimers.set(id, pollTimer);

  console.log(`[Pixel Agents] Agent ${id}: spawned (PID ${proc.pid}), sessionId=${sessionId}`);
  return id;
}
