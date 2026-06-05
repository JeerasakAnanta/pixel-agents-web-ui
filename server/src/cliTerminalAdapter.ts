import type { ITerminalAdapter, TerminalHandle } from '../../core/src/terminalAdapter.js';

/**
 * No-op terminal adapter for standalone (CLI) mode.
 * In standalone mode, `claude` runs as a detached child process —
 * there are no VS Code terminal objects to track.
 */
export class CliTerminalAdapter implements ITerminalAdapter {
  activeTerminal(): TerminalHandle | undefined {
    return undefined;
  }
  allTerminals(): TerminalHandle[] {
    return [];
  }
}
