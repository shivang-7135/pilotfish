import { useEffect, useState } from 'react';
import type { ChatSummary } from '@/lib/types';
import { listChats } from '@/lib/chats';

interface Props {
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
  onClose: () => void;
}

const when = (t: number) => {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
};

export function HistoryView({ onOpen, onDelete, onClear, onClose }: Props) {
  const [chats, setChats] = useState<ChatSummary[] | null>(null);

  useEffect(() => {
    const load = () => listChats().then(setChats);
    load();
    chrome.storage.onChanged.addListener(load);
    return () => chrome.storage.onChanged.removeListener(load);
  }, []);

  return (
    <div className="app settings">
      <header className="bar">
        <button className="icon" onClick={onClose} aria-label="Back to chat">
          ←
        </button>
        <div className="brand">Chats</div>
        {!!chats?.length && (
          <button
            className="small"
            onClick={() => {
              if (confirm('Delete all saved chats?')) onClear();
            }}
          >
            Delete all
          </button>
        )}
      </header>
      <main className="form">
        <p className="hint">
          Saved on this device. Opening a chat continues it in this tab; the agent re-reads the page first.
        </p>
        {chats?.length === 0 && <p className="hint">No chats yet.</p>}
        {chats?.map((c) => (
          <div key={c.id} className="doc chat-row">
            <button className="open" onClick={() => onOpen(c.id)}>
              <span>{c.title}</span>
              <small>{when(c.updatedAt)}</small>
            </button>
            <button onClick={() => onDelete(c.id)} aria-label={`Delete chat: ${c.title}`}>
              Delete
            </button>
          </div>
        ))}
      </main>
    </div>
  );
}
