import type { ITerminalAdapter, TerminalHandle } from '@pixel-agents/core/terminalAdapter.js';
import * as vscode from 'vscode';

/** VS Code implementation of ITerminalAdapter. Wraps vscode.window terminal access. */
export class VscodeTerminalAdapter implements ITerminalAdapter {
  activeTerminal(): TerminalHandle | undefined {
    return vscode.window.activeTerminal;
  }

  allTerminals(): TerminalHandle[] {
    return [...vscode.window.terminals];
  }
}
