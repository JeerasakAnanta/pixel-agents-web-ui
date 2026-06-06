// @pixel-agents/server — public API surface
export { InProcessBridge } from './inProcessBridge.js';
// Import specific sub-modules for internal use; this barrel is for external packages only.
export { AgentRuntime } from './agentRuntime.js';
export { AgentStateStore } from './agentStateStore.js';
export type { AssetCache, SetHooksEnabledSideEffect } from './clientMessageHandler.js';
export { handleClientMessage } from './clientMessageHandler.js';
export { readConfig, writeConfig } from './configPersistence.js';
export { FileStateAdapter } from './fileStateAdapter.js';
export { setTerminalAdapter } from './fileWatcher.js';
export type { LayoutWatcher } from './layoutPersistence.js';
export {
  loadLayout,
  readLayoutFromFile,
  watchLayoutFile,
  writeLayoutToFile,
} from './layoutPersistence.js';
export { claudeProvider, copyHookScript } from './providers/index.js';
export { PixelAgentsServer } from './server.js';
export type { AgentState, PersistedAgent } from './types.js';
