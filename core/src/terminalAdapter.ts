/**
 * Minimal terminal interface for fileWatcher's terminal adoption logic.
 * Only exposes the `.name` property needed for matching terminals to agents.
 */
export interface TerminalHandle {
  name: string;
  /** VS Code-specific: bring terminal to front */
  show?(): void;
  /** VS Code-specific: close/dispose the terminal */
  dispose?(): void;
  /** VS Code-specific: send text input to the terminal (appends newline) */
  sendText?(text: string): void;
  /** VS Code-specific: defined when terminal has exited */
  exitStatus?: unknown;
}

/**
 * Adapter for terminal access. VS Code provides vscode.window.activeTerminal
 * and vscode.window.terminals; standalone server has no terminals.
 */
export interface ITerminalAdapter {
  activeTerminal(): TerminalHandle | undefined;
  allTerminals(): TerminalHandle[];
}
