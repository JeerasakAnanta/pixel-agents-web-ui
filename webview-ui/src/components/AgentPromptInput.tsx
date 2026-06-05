import { useEffect, useRef, useState } from 'react';

import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';

interface AgentPromptInputProps {
  selectedAgentId: number | null;
  agentStatus: 'active' | 'waiting' | undefined;
  agentFolderName: string | undefined;
}

export function AgentPromptInput({
  selectedAgentId,
  agentStatus,
  agentFolderName,
}: AgentPromptInputProps) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const isWaiting = agentStatus === 'waiting';
  const canSend = !isBrowserRuntime && isWaiting && text.trim().length > 0;

  // Clear input and focus when a new agent is selected
  useEffect(() => {
    setText('');
    if (selectedAgentId !== null) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [selectedAgentId]);

  // Auto-focus when agent becomes waiting
  useEffect(() => {
    if (isWaiting) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isWaiting]);

  if (selectedAgentId === null) return null;

  const handleSend = () => {
    if (!canSend) return;
    transport.send({ type: 'sendPrompt', id: selectedAgentId, text: text.trim() });
    setText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const label = agentFolderName ? `Agent: ${agentFolderName}` : `Agent #${selectedAgentId}`;

  let statusText: string;
  if (isBrowserRuntime) {
    statusText = 'Sending prompts requires VS Code extension';
  } else if (agentStatus === 'active') {
    statusText = 'Agent is working...';
  } else if (agentStatus === 'waiting') {
    statusText = 'Ready — type a message and press Enter';
  } else {
    statusText = 'Waiting for agent status...';
  }

  return (
    <div
      className="absolute z-20 pixel-panel"
      style={{
        bottom: '72px',
        left: '50%',
        transform: 'translateX(-50%)',
        width: '480px',
        maxWidth: 'calc(100vw - 32px)',
        padding: '10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: '10px',
          color: 'var(--pixel-text-dim)',
          letterSpacing: '0.05em',
        }}
      >
        <span>{label.toUpperCase()}</span>
        <span
          style={{
            color: isWaiting ? 'var(--pixel-accent)' : 'var(--pixel-text-dim)',
          }}
        >
          {statusText}
        </span>
      </div>

      <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-end' }}>
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!isWaiting || isBrowserRuntime}
          placeholder={
            isWaiting && !isBrowserRuntime
              ? 'Type a message… (Enter to send, Shift+Enter for newline)'
              : ''
          }
          rows={2}
          style={{
            flex: 1,
            background: 'var(--pixel-bg-raised)',
            border: `2px solid ${isWaiting && !isBrowserRuntime ? 'var(--pixel-accent)' : 'var(--pixel-border)'}`,
            color: 'var(--pixel-text)',
            padding: '6px 8px',
            fontSize: '12px',
            resize: 'none',
            outline: 'none',
            opacity: isWaiting && !isBrowserRuntime ? 1 : 0.5,
          }}
        />
        <Button
          variant="accent"
          onClick={handleSend}
          disabled={!canSend}
          style={{ flexShrink: 0, height: '52px', opacity: canSend ? 1 : 0.4 }}
        >
          Send
        </Button>
      </div>
    </div>
  );
}
