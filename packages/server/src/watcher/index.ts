export {
  adoptExternalSessionFromHook,
  scanExternalDir,
  startExternalSessionScanning,
  startStaleExternalAgentCheck,
} from './externalScanner.js';
export { readNewLines, reassignAgentToFile, startFileWatching } from './jsonlPoller.js';
export { ensureProjectScan, scanForNewJsonlFiles } from './projectScanner.js';
export {
  getDismissalTracker,
  isTrackedProjectDir,
  setAgentRemovalCallback,
  setDismissalTracker,
  setHookProvider,
  setTeammateRemovalCallback,
  setTeamProvider,
  setTerminalAdapter,
} from './state.js';
export {
  scanAllTeammateFiles,
  scanForTeammateFiles,
  scanTeamConfigsForRemovals,
} from './teammateScanner.js';
