import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  PORT_PREFIX,
  type AgentEvent,
  type Attachment,
  type PanelMessage,
  type PortMessage,
  type Settings,
  type StepStatus,
} from '@/lib/types';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '@/lib/storage';
import { PROVIDER_LABELS } from '@/lib/providers';
import { ACCEPT, extractText } from '@/lib/extract';
import { SettingsView } from './Settings';
import { MemoryView } from './Memory';
import { HistoryView } from './History';

type Item =
  | { kind: 'user'; text: string; files?: string[] }
  | { kind: 'assistant' | 'done' | 'ask' | 'error'; text: string }
  | { kind: 'step'; id: string; label: string; status: StepStatus; detail?: string };

interface Chat {
  items: Item[];
  running: boolean;
  confirm: { id: string; message: string } | null;
  usage: { input: number; output: number; cached: number };
}
const EMPTY: Chat = { items: [], running: false, confirm: null, usage: { input: 0, output: 0, cached: 0 } };

/** The panel is a pure view of the tab agent's event log, so a replay rebuilds it exactly. */
function reduce(chat: Chat, e: PortMessage): Chat {
  switch (e.type) {
    case 'replay':
      return e.events.reduce(reduce, EMPTY);
    case 'draft':
      return chat; // handled by the composer
    case 'user':
      return { ...chat, items: [...chat.items, { kind: 'user', text: e.text, files: e.files }] };
    case 'status':
      return { ...chat, running: e.running, confirm: e.running ? chat.confirm : null };
    case 'assistant':
      return { ...chat, items: [...chat.items, { kind: 'assistant', text: e.text }] };
    case 'step': {
      const step: Item = { kind: 'step', id: e.id, label: e.label, status: e.status, detail: e.detail };
      const i = chat.items.findIndex((it) => it.kind === 'step' && it.id === e.id);
      return { ...chat, items: i < 0 ? [...chat.items, step] : chat.items.map((it, j) => (j === i ? step : it)) };
    }
    case 'confirm':
      return { ...chat, confirm: { id: e.id, message: e.message } };
    case 'confirm_done':
      return { ...chat, confirm: chat.confirm?.id === e.id ? null : chat.confirm };
    case 'ask':
      return { ...chat, items: [...chat.items, { kind: 'ask', text: e.question }] };
    case 'done':
      return { ...chat, items: [...chat.items, { kind: 'done', text: e.summary }] };
    case 'error':
      return { ...chat, items: [...chat.items, { kind: 'error', text: e.message }] };
    case 'usage':
      return {
        ...chat,
        usage: {
          input: chat.usage.input + e.input,
          output: chat.usage.output + e.output,
          cached: chat.usage.cached + e.cached,
        },
      };
  }
}

const SUGGESTIONS = ['Summarize this page in 5 bullet points', 'Fill in this form from my memory', 'Fill in this form with: '];
const STATUS_ICON: Record<StepStatus, string> = { running: '', ok: '✓', error: '!', denied: '✕' };

/** Which tab this panel belongs to: given in the URL, else the tab it was opened on. */
async function resolveTabId(): Promise<number | undefined> {
  const v = new URLSearchParams(location.search).get('tabId');
  if (v) return Number(v);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

export function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [tabId, setTabId] = useState<number>();
  const [tab, setTab] = useState<{ title: string; icon?: string }>({ title: '' });
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<'chat' | 'settings' | 'memory' | 'history'>('chat');
  const [chat, dispatch] = useReducer(reduce, EMPTY);
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [fileNote, setFileNote] = useState('');
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([loadSettings(), resolveTabId()]).then(([s, id]) => {
      setSettings(s);
      setTabId(id);
      setLoaded(true);
    });
  }, []);

  // Live connection to this tab's agent. Reconnects if the background worker restarts.
  useEffect(() => {
    if (tabId == null) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const port = chrome.runtime.connect({ name: PORT_PREFIX + tabId });
      port.onMessage.addListener((m: PortMessage) => {
        if (m.type === 'draft') {
          // "Edit": the last message comes back to the composer, attachments included.
          setInput(m.text);
          setFiles(m.attachments);
          setTimeout(() => inputRef.current?.focus(), 0);
        } else dispatch(m);
      });
      port.onDisconnect.addListener(() => {
        portRef.current = null;
        if (!closed) retry = setTimeout(connect, 400);
      });
      portRef.current = port;
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      portRef.current?.disconnect();
    };
  }, [tabId]);

  // Show which tab this agent belongs to.
  useEffect(() => {
    if (tabId == null) return;
    const show = (t?: chrome.tabs.Tab) =>
      t && setTab({ title: (t.title || t.url || '').replace(/^(⏳|❓)( |$)/, ''), icon: t.favIconUrl });
    chrome.tabs.get(tabId).then(show).catch(() => {});
    const onUpdated = (id: number, _c: unknown, t: chrome.tabs.Tab) => id === tabId && show(t);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => chrome.tabs.onUpdated.removeListener(onUpdated);
  }, [tabId]);

  const post = useCallback((msg: PanelMessage) => portRef.current?.postMessage(msg), []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [chat.items, chat.confirm]);

  const { items, running, confirm, usage } = chat;
  const provider = settings.provider;
  const ready = !!settings.models[provider] && (provider === 'custom' || !!settings.apiKeys[provider]);

  const send = (text: string) => {
    const t = text.trim();
    if (!t || running) return;
    if (!ready) return setView('settings');
    post({ type: 'run', text: t, attachments: files });
    setInput('');
    setFiles([]);
    setFileNote('');
  };

  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setFileNote('Reading…');
    const added: Attachment[] = [];
    const problems: string[] = [];
    for (const f of Array.from(list)) {
      try {
        added.push(await extractText(f));
      } catch (e: any) {
        problems.push(`${f.name}: ${e?.message ?? 'could not be read'}`);
      }
    }
    setFiles((x) => [...x, ...added]);
    setFileNote(problems.join(' '));
    if (fileRef.current) fileRef.current.value = '';
  };

  const update = (next: Settings) => {
    setSettings(next);
    void saveSettings(next);
  };

  if (!loaded) return null;
  if (view === 'settings') return <SettingsView settings={settings} onChange={update} onClose={() => setView('chat')} />;
  if (view === 'memory') return <MemoryView onClose={() => setView('chat')} />;
  if (view === 'history') {
    return (
      <HistoryView
        onOpen={(id) => {
          post({ type: 'open_chat', id });
          setView('chat');
        }}
        onDelete={(id) => post({ type: 'delete_chat', id })}
        onClear={() => post({ type: 'clear_chats' })}
        onClose={() => setView('chat')}
      />
    );
  }
  const lastUser = items.map((it) => it.kind).lastIndexOf('user');

  return (
    <div className="app">
      <header className="bar">
        <div className="brand">
          <span className="logo" aria-hidden />
          Pilotfish
        </div>
        <button className="model" onClick={() => setView('settings')} title="Change provider or model">
          {ready ? settings.models[provider] : 'Set up a model'}
        </button>
        <button
          className="icon"
          onClick={() => {
            post({ type: 'reset' });
            setInput('');
            setFiles([]);
          }}
          disabled={running || items.length === 0}
          title={running ? 'Stop the task before starting a new chat' : 'New chat'}
          aria-label="New chat"
        >
          ＋
        </button>
        <button className="icon" onClick={() => setView('history')} disabled={running} title="Chats" aria-label="Chats">
          ◷
        </button>
        <button className="icon" onClick={() => setView('memory')} title="Memory" aria-label="Memory">
          ☰
        </button>
        <button className="icon" onClick={() => setView('settings')} title="Settings" aria-label="Settings">
          ⚙
        </button>
      </header>
      <div className={`tabline ${running ? 'live' : ''}`} title="Each tab has its own agent and chat">
        {tab.icon ? <img src={tab.icon} alt="" /> : <span className="favicon" />}
        <span>{running ? 'Working in' : 'This tab'}: {tab.title || '…'}</span>
      </div>

      <main className="feed">
        {items.length === 0 && (
          <div className="empty">
            <h1>What should I do in this tab?</h1>
            {ready ? (
              <>
                <p>
                  I work only in this tab and show you exactly where. I ask before anything that submits, pays or
                  sends.
                </p>
                <div className="chips">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => {
                        if (s.endsWith(': ')) {
                          setInput(s);
                          inputRef.current?.focus();
                        } else send(s);
                      }}
                    >
                      {s.endsWith(': ') ? s + '…' : s}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <p>
                  Add an API key from OpenRouter, OpenAI or Anthropic to get started. It stays on this device and is
                  sent only to the provider you pick.
                </p>
                <button className="primary" onClick={() => setView('settings')}>
                  Add API key
                </button>
              </>
            )}
          </div>
        )}

        {items.map((it, i) =>
          it.kind === 'step' ? (
            <div key={it.id} className={`step ${it.status}`}>
              <span className="dot">{STATUS_ICON[it.status]}</span>
              <span className="label">
                {it.label}
                {it.status === 'denied' && <em> — declined</em>}
                {it.detail && <small>{it.detail}</small>}
              </span>
            </div>
          ) : (
            <div key={i} className={`turn ${it.kind}`}>
              <div className={`msg ${it.kind}`}>
                {it.kind === 'ask' && <div className="tag">Question</div>}
                {it.kind === 'done' && <div className="tag">Done</div>}
                {it.text}
                {it.kind === 'user' && !!it.files?.length && <div className="sent-files">📎 {it.files.join(', ')}</div>}
              </div>
              {i === lastUser && !running && (
                <div className="turn-actions">
                  <button onClick={() => post({ type: 'edit' })} title="Change this message and send it again">
                    Edit
                  </button>
                  <button onClick={() => post({ type: 'retry' })} title="Run this message again from the start">
                    Retry
                  </button>
                </div>
              )}
            </div>
          ),
        )}

        {running && !confirm && <div className="thinking">Working…</div>}
        <div ref={endRef} />
      </main>

      {confirm && (
        <div className="confirm" role="alertdialog" aria-label="Approval needed">
          <p>{confirm.message}</p>
          <div>
            <button onClick={() => post({ type: 'confirm_reply', id: confirm.id, allow: false })}>Deny</button>
            <button className="primary" onClick={() => post({ type: 'confirm_reply', id: confirm.id, allow: true })}>
              Allow
            </button>
          </div>
        </div>
      )}

      {(files.length > 0 || fileNote) && (
        <div className="files">
          {files.map((f, i) => (
            <span key={i} className="file">
              📎 {f.name} <small>{f.text.length.toLocaleString()} chars</small>
              <button aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((_, j) => j !== i))}>
                ×
              </button>
            </span>
          ))}
          {fileNote && <small className="file-note">{fileNote}</small>}
        </div>
      )}

      <footer className="composer">
        <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden onChange={(e) => addFiles(e.target.files)} />
        <button
          className="icon attach"
          onClick={() => fileRef.current?.click()}
          disabled={running}
          title="Attach a file (PDF, Word, text). It is read on this device."
          aria-label="Attach a file"
        >
          📎
        </button>
        <textarea
          ref={inputRef}
          value={input}
          rows={2}
          placeholder={running ? 'Working on it…' : 'Ask about this page or give me a task'}
          disabled={running}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        {running ? (
          <button className="stop" onClick={() => post({ type: 'stop' })}>
            Stop
          </button>
        ) : (
          <button className="primary" onClick={() => send(input)} disabled={!input.trim()}>
            Send
          </button>
        )}
      </footer>
      <div className="meta">
        {PROVIDER_LABELS[provider]}
        {usage.input + usage.output > 0 &&
          ` · ${usage.input.toLocaleString()} in${usage.cached ? ` (${usage.cached.toLocaleString()} cached)` : ''} / ${usage.output.toLocaleString()} out tokens`}
      </div>
    </div>
  );
}
