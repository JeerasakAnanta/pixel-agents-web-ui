/**
 * Module-level singletons and their setter/getter functions.
 * All watcher sub-modules import from here instead of sharing mutable globals.
 */
import type { HookProvider } from '@pixel-agents/core/provider.js';
import type { TeamProvider } from '@pixel-agents/core/teamProvider.js';
import type { ITerminalAdapter } from '@pixel-agents/core/terminalAdapter.js';
import * as fs from 'fs';
import * as path from 'path';

import type { DismissalTracker } from '../dismissalTracker.js';

/** Dismissal tracker instance. Set once at startup via setDismissalTracker(). */
let dismissalTracker: DismissalTracker | null = null;

export function setDismissalTracker(tracker: DismissalTracker): void {
  dismissalTracker = tracker;
}

export function getDismissalTracker(): DismissalTracker | null {
  return dismissalTracker;
}

/** Safe accessor — throws if not yet set (programming error). */
export function requireDismissalTracker(): DismissalTracker {
  if (!dismissalTracker) throw new Error('DismissalTracker not set');
  return dismissalTracker;
}

/** Terminal adapter for matching terminals to agents. Set once at startup. */
let terminalAdapter: ITerminalAdapter | null = null;

export function setTerminalAdapter(adapter: ITerminalAdapter): void {
  terminalAdapter = adapter;
}

export function getTerminalAdapter(): ITerminalAdapter | null {
  return terminalAdapter;
}

/** Agent removal callback. Injected to avoid circular dependency on agentManager. */
let agentRemovalCallback: ((id: number) => void) | null = null;

export function setAgentRemovalCallback(cb: (id: number) => void): void {
  agentRemovalCallback = cb;
}

export function invokeAgentRemovalCallback(id: number): void {
  agentRemovalCallback?.(id);
}

/** Dependencies for per-agent /clear detection in startFileWatching poll loop. */
export interface ClearDetectionDeps {
  projectDir: string;
  knownJsonlFiles: Set<string>;
  activeAgentIdRef: { current: number | null };
  fileWatchers: Map<number, fs.FSWatcher>;
  pollingTimers: Map<number, ReturnType<typeof setInterval>>;
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
  persistAgents: () => void;
}

let clearDetectionDeps: ClearDetectionDeps | null = null;

export function setClearDetectionDeps(deps: ClearDetectionDeps): void {
  clearDetectionDeps = deps;
}

export function getClearDetectionDeps(): ClearDetectionDeps | null {
  return clearDetectionDeps;
}

/** All project directories being scanned (supports multi-root workspaces). */
export const trackedProjectDirs = new Set<string>();

export function isTrackedProjectDir(dir: string): boolean {
  if (trackedProjectDirs.has(dir)) return true;
  const resolved = path.resolve(dir).toLowerCase();
  for (const tracked of trackedProjectDirs) {
    if (path.resolve(tracked).toLowerCase() === resolved) return true;
  }
  return false;
}

/** Known teammate JSONL files (prevents re-adoption). */
export const knownTeammateFiles = new Set<string>();

/** Callback to remove a teammate agent when detected as dismissed via team config. */
let teammateRemovalCallback: ((teammateAgentId: number) => void) | null = null;

export function setTeammateRemovalCallback(cb: (teammateAgentId: number) => void): void {
  teammateRemovalCallback = cb;
}

export function invokeTeammateRemovalCallback(id: number): void {
  teammateRemovalCallback?.(id);
}

/** Team provider: supplies CLI-specific paths, parsers, and tool names. */
let teamProvider: TeamProvider | null = null;

export function setTeamProvider(provider: TeamProvider): void {
  teamProvider = provider;
}

export function getTeamProvider(): TeamProvider | null {
  return teamProvider;
}

/** Hook provider: supplies non-team capabilities (session roots, terminal name prefix). */
let hookProvider: HookProvider | null = null;

export function setHookProvider(provider: HookProvider): void {
  hookProvider = provider;
}

export function getHookProvider(): HookProvider | null {
  return hookProvider;
}

/** Derive a readable folder name from the Claude project dir hash. */
export function folderNameFromProjectDir(dirName: string): string {
  const parts = dirName.replace(/^-+/, '').split('-');
  return parts[parts.length - 1] || dirName;
}
