import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import { readNewLines, startFileWatching } from './fileWatcher.js';
import { claudeProvider } from './providers/index.js';

/** Detect if running inside WSL2 */
function isWsl(): boolean {
  try {
    const release = fs.readFileSync('/proc/version', 'utf-8').toLowerCase();
    return release.includes('microsoft') || release.includes('wsl');
  } catch {
    return false;
  }
}

/**
 * Spawn a terminal window running `claude --session-id <uuid>`.
 * Returns the child process (already unref'd — won't block Node exit).
 *
 * Priority order:
 *   WSL2  → Windows Terminal (wt.exe) → cmd.exe fallback
 *   macOS → Terminal.app (open -a Terminal)
 *   Linux → detects installed emulator (gnome-terminal, xterm, kitty, …)
 */
function spawnTerminal(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): void {
  const fullEnv = { ...process.env, ...env };
  const claudeCmd = [command, ...args].join(' ');

  if (isWsl()) {
    // Detect Windows username via cmd.exe (differs from WSL $USER)
    let winUser = '';
    try {
      winUser = childProcess.execSync('cmd.exe /c "echo %USERNAME%"', { encoding: 'utf-8' }).trim();
    } catch {
      /* ignore */
    }

    const wtExe = winUser
      ? `/mnt/c/Users/${winUser}/AppData/Local/Microsoft/WindowsApps/wt.exe`
      : '';
    const wtExists = wtExe !== '' && fs.existsSync(wtExe);

    if (wtExists) {
      // Detect current WSL distro name (e.g. "Ubuntu-24.04")
      let distro = 'Ubuntu';
      try {
        const raw = childProcess.execSync('wsl.exe --list --quiet', { encoding: 'utf-8' });
        // wsl --list output uses UTF-16LE on Windows → strip null bytes and CR
        const lines = raw
          .replace(/\0/g, '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        if (lines[0]) distro = lines[0];
      } catch {
        /* use default */
      }

      // Windows Terminal: open new tab in WSL at the correct directory
      const wslPath = `\\\\wsl.localhost\\${distro}${cwd.replace(/\//g, '\\')}`;
      console.log(`[Pixel Agents] Opening Windows Terminal: ${wslPath}`);
      childProcess
        .spawn(
          wtExe,
          [
            'new-tab',
            '--startingDirectory',
            wslPath,
            'wsl',
            '--',
            'bash',
            '-c',
            `cd ${JSON.stringify(cwd)} && ${claudeCmd}`,
          ],
          { detached: true, stdio: 'ignore' },
        )
        .unref();
    } else {
      // Fallback: cmd.exe /c start wsl bash -c "..."
      childProcess
        .spawn(
          '/mnt/c/Windows/System32/cmd.exe',
          ['/c', 'start', 'wsl', '--', 'bash', '-c', `cd ${JSON.stringify(cwd)} && ${claudeCmd}`],
          { detached: true, stdio: 'ignore' },
        )
        .unref();
    }
    return;
  }

  if (os.platform() === 'darwin') {
    // macOS: open a new Terminal.app window
    const script = `tell application "Terminal" to do script "cd ${JSON.stringify(cwd)} && ${claudeCmd}"`;
    childProcess
      .spawn('osascript', ['-e', script], {
        detached: true,
        stdio: 'ignore',
      })
      .unref();
    return;
  }

  // Linux: try common terminal emulators in priority order
  const candidates: [string, string[]][] = [
    [
      'gnome-terminal',
      ['--', 'bash', '-c', `cd ${JSON.stringify(cwd)} && ${claudeCmd}; exec bash`],
    ],
    ['xterm', ['-e', `cd ${JSON.stringify(cwd)} && ${claudeCmd}`]],
    ['kitty', ['bash', '-c', `cd ${JSON.stringify(cwd)} && ${claudeCmd}`]],
    ['alacritty', ['-e', 'bash', '-c', `cd ${JSON.stringify(cwd)} && ${claudeCmd}; exec bash`]],
    ['wezterm', ['start', '--cwd', cwd, 'bash', '-c', claudeCmd]],
    [
      'xfce4-terminal',
      ['--command', `bash -c "cd ${JSON.stringify(cwd)} && ${claudeCmd}; exec bash"`],
    ],
    ['konsole', ['-e', 'bash', '-c', `cd ${JSON.stringify(cwd)} && ${claudeCmd}`]],
  ];

  for (const [bin, termArgs] of candidates) {
    try {
      childProcess.execSync(`which ${bin}`, { stdio: 'ignore' });
      childProcess
        .spawn(bin, termArgs, {
          cwd,
          env: fullEnv,
          detached: true,
          stdio: 'ignore',
        })
        .unref();
      return;
    } catch {
      // not installed, try next
    }
  }

  console.warn('[Pixel Agents] No terminal emulator found — falling back to headless spawn');
  childProcess
    .spawn(command, args, {
      cwd,
      env: fullEnv,
      detached: true,
      stdio: 'ignore',
    })
    .unref();
}

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

  spawnTerminal(launch.command, launch.args, cwd, launch.env ?? {});

  const dirs = claudeProvider.getSessionDirs!(cwd);
  const projectDir = dirs[0];
  if (!projectDir) throw new Error('No project dir for cwd: ' + cwd);

  const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);
  runtime.knownJsonlFiles.add(expectedFile);

  const id = store.nextAgentId.current++;
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
  };

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

  return id;
}
