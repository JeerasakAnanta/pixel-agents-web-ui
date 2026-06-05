import * as fs from 'fs';

import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { LoadedAssets, LoadedCharacterSprites } from './assetLoader.js';
import { readConfig, writeConfig } from './configPersistence.js';
import { readLayoutFromFile, writeLayoutToFile } from './layoutPersistence.js';
import { claudeProvider } from './providers/index.js';
import { spawnAgent } from './spawnAgent.js';

type WsSend = (message: Record<string, unknown>) => void;

/** Async hook toggle side effect (install/uninstall + script copy). Provided by cli.ts. */
export type SetHooksEnabledSideEffect = (enabled: boolean) => Promise<void> | void;

/** Cached assets loaded at server startup. Sent to each WebSocket client on webviewReady. */
export interface AssetCache {
  characters: LoadedCharacterSprites | null;
  floorTiles: string[][][] | null;
  wallTiles: string[][][][] | null;
  furniture: LoadedAssets | null;
  defaultLayout: Record<string, unknown> | null;
}

export interface ClientMessageContext {
  store: AgentStateStore;
  runtime?: AgentRuntime;
  cache: AssetCache | null;
  /** Default working directory for new agents (set via --workspace CLI flag) */
  workspace?: string;
  /** Install/uninstall hooks side effect. Needs server url+token known only to cli.ts. */
  onSetHooksEnabled?: SetHooksEnabledSideEffect;
}

// ── Setting key constants (mirror adapters/vscode/constants.ts) ──
const KEY_SOUND_ENABLED = 'pixel-agents.soundEnabled';
const KEY_LAST_SEEN_VERSION = 'pixel-agents.lastSeenVersion';
const KEY_ALWAYS_SHOW_LABELS = 'pixel-agents.alwaysShowLabels';
const KEY_WATCH_ALL_SESSIONS = 'pixel-agents.watchAllSessions';
const KEY_HOOKS_ENABLED = 'pixel-agents.hooksEnabled';
const KEY_HOOKS_INFO_SHOWN = 'pixel-agents.hooksInfoShown';

/**
 * Handle incoming ClientMessage from a WebSocket client.
 *
 * In standalone mode, the server is the authority for all state: assets,
 * layout, settings, agents. Assets are loaded once at startup and cached
 * in memory. Each connecting client receives the full state on webviewReady.
 */
export function handleClientMessage(
  msg: Record<string, unknown>,
  send: WsSend,
  ctx: ClientMessageContext,
): void {
  const { store, runtime } = ctx;
  const adapter = store.getAdapter();

  switch (msg.type) {
    case 'webviewReady':
      handleWebviewReady(send, ctx);
      break;

    case 'saveLayout':
      if (msg.layout) {
        writeLayoutToFile(msg.layout as Record<string, unknown>);
      }
      break;

    case 'saveAgentSeats':
      if (msg.seats) {
        adapter?.saveSeats(
          msg.seats as Record<string, { palette?: number; hueShift?: number; seatId?: string }>,
        );
      }
      break;

    case 'setSoundEnabled':
      adapter?.setSetting(KEY_SOUND_ENABLED, msg.enabled);
      break;

    case 'setLastSeenVersion':
      adapter?.setSetting(KEY_LAST_SEEN_VERSION, msg.version as string);
      break;

    case 'setAlwaysShowLabels':
      adapter?.setSetting(KEY_ALWAYS_SHOW_LABELS, msg.enabled);
      break;

    case 'setWatchAllSessions': {
      const enabled = msg.enabled as boolean;
      adapter?.setSetting(KEY_WATCH_ALL_SESSIONS, enabled);
      if (runtime) runtime.watchAllSessions.current = enabled;
      break;
    }

    case 'setHooksEnabled': {
      const enabled = msg.enabled as boolean;
      adapter?.setSetting(KEY_HOOKS_ENABLED, enabled);
      if (runtime) runtime.hooksEnabled.current = enabled;
      void ctx.onSetHooksEnabled?.(enabled);
      break;
    }

    case 'setHooksInfoShown':
      adapter?.setSetting(KEY_HOOKS_INFO_SHOWN, true);
      break;

    case 'addExternalAssetDirectory': {
      const newPath = msg.path as string | undefined;
      if (!newPath) break;
      const cfg = readConfig();
      if (!cfg.externalAssetDirectories.includes(newPath)) {
        cfg.externalAssetDirectories.push(newPath);
        writeConfig(cfg);
      }
      send({ type: 'externalAssetDirectoriesUpdated', dirs: cfg.externalAssetDirectories });
      break;
    }

    case 'removeExternalAssetDirectory': {
      const removePath = msg.path as string | undefined;
      if (!removePath) break;
      const cfg = readConfig();
      cfg.externalAssetDirectories = cfg.externalAssetDirectories.filter((d) => d !== removePath);
      writeConfig(cfg);
      send({ type: 'externalAssetDirectoriesUpdated', dirs: cfg.externalAssetDirectories });
      break;
    }

    case 'launchAgent': {
      if (runtime) {
        const cwd = (msg.folderPath as string | undefined) ?? ctx.workspace ?? process.cwd();
        void spawnAgent(store, runtime, {
          cwd,
          bypassPermissions: msg.bypassPermissions as boolean | undefined,
        });
      }
      break;
    }

    case 'launchSwarm': {
      if (runtime) {
        const cwd = (msg.folderPath as string | undefined) ?? ctx.workspace ?? process.cwd();
        const count = Math.max(2, Math.min(10, (msg.count as number) || 3));
        for (let i = 0; i < count; i++) {
          void spawnAgent(store, runtime, {
            cwd,
            bypassPermissions: msg.bypassPermissions as boolean | undefined,
          });
        }
      }
      break;
    }

    case 'closeAgent': {
      const agentId = msg.id as number;
      const agent = store.get(agentId);
      if (agent && runtime) {
        runtime.dismissalTracker.dismiss(agent.jsonlFile);
        runtime.removeAgent(agentId);
      }
      break;
    }

    case 'focusAgent':
      // no-op: no terminal to focus in standalone mode
      break;

    case 'requestDiagnostics': {
      const diagnostics: Array<Record<string, unknown>> = [];
      for (const [, agent] of store) {
        let jsonlExists = false;
        let fileSize = 0;
        try {
          const s = fs.statSync(agent.jsonlFile);
          jsonlExists = true;
          fileSize = s.size;
        } catch {
          /* file missing */
        }
        diagnostics.push({
          id: agent.id,
          projectDir: agent.projectDir,
          projectDirExists: fs.existsSync(agent.projectDir),
          jsonlFile: agent.jsonlFile,
          jsonlExists,
          fileSize,
          fileOffset: agent.fileOffset,
          lastDataAt: agent.lastDataAt,
          linesProcessed: agent.linesProcessed,
        });
      }
      send({ type: 'agentDiagnostics', agents: diagnostics });
      break;
    }

    case 'exportLayout': {
      const layout = readLayoutFromFile();
      if (layout) send({ type: 'layoutExportData', json: JSON.stringify(layout, null, 2) });
      break;
    }

    case 'importLayout': {
      if (msg.layout) {
        writeLayoutToFile(msg.layout as Record<string, unknown>);
        send({ type: 'layoutLoaded', layout: msg.layout });
      }
      break;
    }

    case 'openSessionsFolder': {
      const dirs = claudeProvider.getSessionDirs!(process.cwd());
      send({ type: 'sessionsFolder', path: dirs[0] ?? process.cwd() });
      break;
    }

    default:
      break;
  }
}

function handleWebviewReady(send: WsSend, ctx: ClientMessageContext): void {
  const { store, runtime, cache } = ctx;
  const adapter = store.getAdapter();

  // 1. Provider capabilities (must arrive before any agent messages)
  send({
    type: 'providerCapabilities',
    readingTools: [...claudeProvider.readingTools],
    subagentToolNames: [...claudeProvider.subagentToolNames],
  });

  // 2. Assets (from server cache, loaded at startup via pngjs)
  if (cache) {
    if (cache.characters) {
      send({ type: 'characterSpritesLoaded', characters: cache.characters.characters });
    }
    if (cache.floorTiles) {
      send({ type: 'floorTilesLoaded', sprites: cache.floorTiles });
    }
    if (cache.wallTiles) {
      send({ type: 'wallTilesLoaded', sets: cache.wallTiles });
    }
    if (cache.furniture) {
      send({
        type: 'furnitureAssetsLoaded',
        catalog: cache.furniture.catalog,
        sprites: Object.fromEntries(cache.furniture.sprites),
      });
    }
  }

  // 3. Layout (saved file, or bundled default)
  const savedLayout = readLayoutFromFile();
  send({ type: 'layoutLoaded', layout: savedLayout ?? cache?.defaultLayout ?? null });

  // 4. Settings (from adapter, with sensible defaults when adapter is absent)
  const cfg = readConfig();
  const watchAllSessions = adapter?.getSetting(KEY_WATCH_ALL_SESSIONS, false) ?? false;
  const hooksEnabled = adapter?.getSetting(KEY_HOOKS_ENABLED, true) ?? true;
  send({
    type: 'settingsLoaded',
    soundEnabled: adapter?.getSetting(KEY_SOUND_ENABLED, true) ?? true,
    lastSeenVersion: adapter?.getSetting(KEY_LAST_SEEN_VERSION, '') ?? '',
    extensionVersion: process.env.PIXEL_AGENTS_VERSION ?? '',
    watchAllSessions,
    alwaysShowLabels: adapter?.getSetting(KEY_ALWAYS_SHOW_LABELS, false) ?? false,
    hooksEnabled,
    hooksInfoShown: adapter?.getSetting(KEY_HOOKS_INFO_SHOWN, false) ?? false,
    externalAssetDirectories: cfg.externalAssetDirectories,
  });

  // Sync runtime refs with the persisted settings so scanners behave correctly
  // from the first tick after a server restart.
  if (runtime) {
    runtime.watchAllSessions.current = watchAllSessions;
    runtime.hooksEnabled.current = hooksEnabled;
  }

  // 5. Restore persisted external agents (standalone only; VS Code handles its own restore)
  runtime?.restoreExternalAgents();

  // 6. Existing agents (either just restored, or from VS Code adapter if present)
  const agentIds: number[] = [];
  const folderNames: Record<number, string> = {};
  const externalAgents: Record<number, boolean> = {};
  for (const [id, agent] of store) {
    agentIds.push(id);
    if (agent.folderName) {
      folderNames[id] = agent.folderName;
    }
    if (agent.isExternal) {
      externalAgents[id] = true;
    }
  }
  const seats = adapter?.loadSeats() ?? {};
  send({
    type: 'existingAgents',
    agents: agentIds,
    agentMeta: seats,
    folderNames,
    externalAgents,
  });
}
