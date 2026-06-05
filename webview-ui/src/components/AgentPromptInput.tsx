import { useEffect, useRef, useState } from 'react';

import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';

interface AgentPromptInputProps {
  selectedAgentId: number | null;
  agentStatus: 'active' | 'waiting' | undefined;
  agentFolderName: string | undefined;
  /** True when the agent has at least one tool actively running (not done). */
  agentHasActiveTools: boolean;
}

export function AgentPromptInput({
  selectedAgentId,
  agentStatus,
  agentFolderName,
  agentHasActiveTools,
}: AgentPromptInputProps) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const isWaiting = agentStatus === 'waiting';
  // isActive: explicitly waiting for a tool to finish (has running tools) OR
  // the server sent an 'active' status (legacy/non-hook path).
  const isActive = agentStatus === 'active' || agentHasActiveTools;
  const canSend = !isActive && text.trim().length > 0;

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
      if (canSend) handleSend();
    }
  };

  const label = agentFolderName ? agentFolderName : `Agent #${selectedAgentId}`;

  let statusDot: string;
  let statusMsg: string;
  if (isActive) {
    statusDot = '🟡';
    statusMsg = 'Working…';
  } else {
    // Both 'waiting' (explicit hook signal) and unknown (fresh agent, between turns)
    // are ready to receive a message.
    statusDot = '🟢';
    statusMsg = 'Ready — Enter to send';
  }

  const inputBorder = !isActive ? 'var(--pixel-accent)' : 'var(--pixel-border)';

  return (
    <div
      className="absolute z-20 pixel-panel"
      style={{
        bottom: '80px',
        left: '50%',
        transform: 'translateX(-50%)',
        width: '560px',
        maxWidth: 'calc(100vw - 24px)',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: '11px',
          letterSpacing: '0.06em',
        }}
      >
        <span style={{ color: 'var(--pixel-text)', fontWeight: 'bold' }}>
          {label.toUpperCase()}
        </span>
        <span style={{ color: !isActive ? 'var(--pixel-accent)' : 'var(--pixel-text-dim)' }}>
          {statusDot} {statusMsg}
        </span>
      </div>

      {/* Input row */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isActive}
          placeholder={
            isActive
              ? 'Agent is working…'
              : 'Type a message… Enter to send, Shift+Enter for newline'
          }
          rows={3}
          style={{
            flex: 1,
            background: 'var(--pixel-bg-raised)',
            border: `2px solid ${inputBorder}`,
            color: 'var(--pixel-text)',
            padding: '8px 10px',
            fontSize: '13px',
            resize: 'vertical',
            minHeight: '70px',
            outline: 'none',
            opacity: isActive ? 0.45 : 1,
          }}
        />

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flexShrink: 0 }}>
          <Button
            variant="accent"
            onClick={handleSend}
            disabled={!canSend}
            style={{ width: '80px', flex: 1, opacity: canSend ? 1 : 0.35 }}
          >
            Send
          </Button>

          {/* Close button */}
          <Button
            variant="default"
            onClick={() => {
              transport.send({ type: 'focusAgent', id: selectedAgentId });
            }}
            style={{ width: '80px', fontSize: '11px' }}
            title="Focus terminal"
          >
            Terminal
          </Button>
        </div>
      </div>
    </div>
  );
}
