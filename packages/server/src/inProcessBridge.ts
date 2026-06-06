import type { ClientMessage, ServerMessage } from '@pixel-agents/core/messages.js';

type ServerMessageHandler = (msg: ServerMessage) => void;
type ClientMessageHandler = (msg: ClientMessage) => void;

/**
 * In-process message bridge for the VS Code extension.
 *
 * Instead of going through a real WebSocket (network round-trip inside the same
 * process), the extension adapter uses this bridge to communicate with the server
 * runtime directly in memory — same protocol as WebSocket but zero overhead.
 *
 * Usage:
 *   Server side: call `send(serverMsg)` to push messages to the webview.
 *   Client side (extension): call `post(clientMsg)` to dispatch a client command.
 */
export class InProcessBridge {
  private serverHandlers: ServerMessageHandler[] = [];
  private clientHandlers: ClientMessageHandler[] = [];

  /** Extension calls this to register a handler for messages coming FROM the server. */
  onServerMessage(handler: ServerMessageHandler): () => void {
    this.serverHandlers.push(handler);
    return () => {
      this.serverHandlers = this.serverHandlers.filter((h) => h !== handler);
    };
  }

  /** Server calls this to register a handler for messages coming FROM the extension/client. */
  onClientMessage(handler: ClientMessageHandler): () => void {
    this.clientHandlers.push(handler);
    return () => {
      this.clientHandlers = this.clientHandlers.filter((h) => h !== handler);
    };
  }

  /** Server → Extension: push a server message to all registered extension handlers. */
  send(msg: ServerMessage): void {
    for (const handler of this.serverHandlers) {
      handler(msg);
    }
  }

  /** Extension → Server: dispatch a client message to all registered server handlers. */
  post(msg: ClientMessage): void {
    for (const handler of this.clientHandlers) {
      handler(msg);
    }
  }
}
