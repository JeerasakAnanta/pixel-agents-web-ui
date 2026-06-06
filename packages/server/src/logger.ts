/**
 * Centralized logger for Pixel Agents server.
 *
 * In VS Code extension mode, configure with an OutputChannel so logs appear in
 * View → Output → "Pixel Agents" instead of only the hidden debug console.
 * In standalone CLI mode the channel is null and all output goes to stdout/stderr.
 *
 * Usage:
 *   import { log, debug, warn, error } from './logger.js';
 *   log('Agent 1 adopted terminal "Claude 1"');
 *   debug('Hook: SessionStart received');
 *
 * Setup (extension.ts):
 *   import { configureLogger } from '@pixel-agents/server/logger.js';
 *   const out = vscode.window.createOutputChannel('Pixel Agents');
 *   configureLogger({ channel: out });
 */

/** Minimal interface satisfied by vscode.OutputChannel. */
export interface OutputChannel {
  appendLine(value: string): void;
  show(preserveFocus?: boolean): void;
}

interface LoggerConfig {
  /** VS Code OutputChannel to route output through. null = use console. */
  channel: OutputChannel | null;
}

let _channel: OutputChannel | null = null;
let _debug = process.env.PIXEL_AGENTS_DEBUG !== '0';

export function configureLogger(config: Partial<LoggerConfig> & { debugMode?: boolean }): void {
  if (config.channel !== undefined) _channel = config.channel;
  if (config.debugMode !== undefined) _debug = config.debugMode;
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function write(level: string, msg: string): void {
  const line = `[${timestamp()}] [${level}] ${msg}`;
  if (_channel) {
    _channel.appendLine(line);
  } else {
    if (level === 'ERROR' || level === 'WARN') {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}

/** Always-visible informational message. */
export function log(msg: string): void {
  write('INFO', msg);
}

/** Debug-only message — suppressed unless PIXEL_AGENTS_DEBUG is set. */
export function debug(msg: string): void {
  if (_debug) write('DEBUG', msg);
}

/** Warning — always visible. */
export function warn(msg: string): void {
  write('WARN', msg);
}

/** Error — always visible. */
export function error(msg: string): void {
  write('ERROR', msg);
}

/** True when debug logging is enabled. Use for expensive message construction guards. */
export function isDebug(): boolean {
  return _debug;
}
