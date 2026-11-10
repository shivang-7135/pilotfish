import { AgentSession, type SessionData } from '@/lib/agent';
import { PORT_PREFIX, type AgentEvent, type PanelMessage, type PortMessage } from '@/lib/types';
import { clearChats, deleteChat, loadChat, saveChat } from '@/lib/chats';

/** One agent per tab. It keeps its own chat, and keeps working while you use other tabs. */
interface TabAgent {
  session: AgentSession;
  /** Which saved conversation this tab is showing. "+" starts a new one; History switches. */
  chatId: string;
  /** Everything shown in the panel, replayed when a panel (re)opens on this tab. */
  log: AgentEvent[];
  ports: Set<chrome.runtime.Port>;
}

const MAX_LOG = 400;

export default defineBackground(() => {
  const agents = new Map<number, TabAgent>();
  /** Remembers which chat a tab shows, so it comes back after a service-worker restart. */
  const key = (tabId: number) => `tabchat:${tabId}`;

  // ---------- one side panel per tab ----------
  const panelPath = (tabId: number) => `/sidepanel.html?tabId=${tabId}`;
  const openWindow = (tabId: number) =>
    chrome.windows.create({ url: chrome.runtime.getURL(panelPath(tabId)), type: 'popup', width: 420, height: 760 });

  if (chrome.sidePanel) {
    // Off everywhere by default; switched on only for tabs where the user clicks the icon.
    chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  }
  chrome.action.onClicked.addListener((tab) => {
    if (tab.id == null) return;
    const tabId = tab.id;
    if (!chrome.sidePanel) return void openWindow(tabId);
    // Both calls are made synchronously so open() still counts as a user gesture.
    chrome.sidePanel.setOptions({ tabId, path: panelPath(tabId), enabled: true }).catch(() => {});
    chrome.sidePanel.open({ tabId }).catch(() => openWindow(tabId));
  });

  // ---------- status you can see from anywhere ----------
  const badge = (tabId: number, text: string, color = '#e8590c') => {
    chrome.action.setBadgeText({ tabId, text }).catch(() => {});
    if (text) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  };

  // The worker would otherwise be suspended during a long model call.
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  const updateKeepAlive = () => {
    const busy = [...agents.values()].some((a) => a.session.running);
    if (busy && !keepAlive) keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20000);
    if (!busy && keepAlive) {
      clearInterval(keepAlive);
      keepAlive = null;
    }
  };

  const persist = (tabId: number, agent: TabAgent) => {
    chrome.storage.session.set({ [key(tabId)]: agent.chatId }).catch(() => {});
    return saveChat(agent.chatId, { log: agent.log, data: agent.session.data() }).catch(() => {});
  };

  const broadcast = (agent: TabAgent, msg: PortMessage) => {
    for (const port of agent.ports) {
      try {
        port.postMessage(msg);
      } catch {
        agent.ports.delete(port);
      }
    }
  };
  /** Sends the whole chat to the panel(s). A log cut off mid-run must not leave the UI "working". */
  const replay = (agent: TabAgent, port?: chrome.runtime.Port) => {
    const events: AgentEvent[] = agent.session.running ? agent.log : [...agent.log, { type: 'status', running: false }];
    const msg: PortMessage = { type: 'replay', events };
    if (port) port.postMessage(msg);
    else broadcast(agent, msg);
  };
  const startNewChat = (tabId: number, agent: TabAgent) => {
    agent.session.reset();
    agent.log = [];
    agent.chatId = crypto.randomUUID();
    chrome.storage.session.set({ [key(tabId)]: agent.chatId }).catch(() => {});
    badge(tabId, '');
    replay(agent);
  };
  /** Drops the last user turn from the visible log, matching AgentSession.rewind(). */
  const trimLastTurn = (agent: TabAgent) => {
    for (let i = agent.log.length - 1; i >= 0; i--) {
      if (agent.log[i].type === 'user') {
        agent.log.splice(i);
        return;
      }
    }
  };

  async function agentFor(tabId: number): Promise<TabAgent> {
    let agent = agents.get(tabId);
    if (agent) return agent;
    let asking = false;
    const created: TabAgent = {
      chatId: crypto.randomUUID(),
      log: [],
      ports: new Set(),
      session: new AgentSession(tabId, (event) => {
        created.log.push(event);
        if (created.log.length > MAX_LOG) created.log.splice(0, created.log.length - MAX_LOG);
        broadcast(created, event);
        if (event.type === 'user') asking = false;
        if (event.type === 'ask') asking = true;
        if (event.type === 'status') {
          // A question for the user stays flagged after the run pauses.
          badge(tabId, event.running ? '…' : asking ? '?' : '', asking && !event.running ? '#c92a2a' : undefined);
          updateKeepAlive();
          if (!event.running) void persist(tabId, created);
        } else if (event.type === 'confirm' || event.type === 'ask') badge(tabId, '?', '#c92a2a');
        else if (event.type === 'confirm_done') badge(tabId, '…');
      }),
    };
    agents.set(tabId, created);
    // Survive a service-worker restart: the chat this tab was showing comes back.
    const stored: Record<string, unknown> = await chrome.storage.session.get(key(tabId)).catch(() => ({}));
    const chatId = stored[key(tabId)] as string | undefined;
    const saved = chatId ? await loadChat(chatId) : undefined;
    if (chatId && saved && !created.log.length) {
      created.chatId = chatId;
      created.log = saved.log ?? [];
      created.session.restore(saved.data);
    }
    return created;
  }

  chrome.runtime.onConnect.addListener(async (port) => {
    if (!port.name.startsWith(PORT_PREFIX)) return;
    const tabId = Number(port.name.slice(PORT_PREFIX.length));
    if (!Number.isInteger(tabId)) return;

    // Register the listener before any await so no early message is lost.
    const queue: PanelMessage[] = [];
    let agent: TabAgent | null = null;
    const handle = (msg: PanelMessage) => {
      const a = agent!;
      switch (msg.type) {
        case 'run':
          void a.session.run(msg.text, msg.attachments ?? []);
          break;
        case 'stop':
          a.session.stop();
          break;
        case 'confirm_reply':
          a.session.resolveConfirm(msg.id, msg.allow);
          break;
        case 'reset':
          if (!a.session.running) startNewChat(tabId, a);
          break;
        case 'retry':
        case 'edit': {
          const input = a.session.rewind();
          if (!input) break;
          trimLastTurn(a);
          replay(a);
          if (msg.type === 'retry') void a.session.run(input.text, input.attachments);
          else {
            port.postMessage({ type: 'draft', ...input } satisfies PortMessage);
            // If that was the chat's only message, nothing is left worth keeping in History.
            if (a.log.some((e) => e.type === 'user')) void persist(tabId, a);
            else void deleteChat(a.chatId);
          }
          break;
        }
        case 'open_chat':
          if (a.session.running || msg.id === a.chatId) break;
          void loadChat(msg.id).then((saved) => {
            if (!saved || a.session.running) return;
            a.session.reset();
            // The page has moved on since this chat was saved, so re-read it on the next message.
            a.session.restore(saved.data, true);
            a.log = saved.log ?? [];
            // If another tab already has this chat open, this tab continues on its own copy.
            const shared = [...agents.values()].some((x) => x !== a && x.chatId === msg.id);
            a.chatId = shared ? crypto.randomUUID() : msg.id;
            chrome.storage.session.set({ [key(tabId)]: a.chatId }).catch(() => {});
            badge(tabId, '');
            replay(a);
          });
          break;
        case 'delete_chat':
          void deleteChat(msg.id).then(() => {
            for (const [id, x] of agents) if (x.chatId === msg.id && !x.session.running) startNewChat(id, x);
          });
          break;
        case 'clear_chats':
          void clearChats().then(() => {
            for (const [id, x] of agents) if (!x.session.running) startNewChat(id, x);
          });
          break;
      }
    };
    port.onMessage.addListener((msg: PanelMessage) => (agent ? handle(msg) : queue.push(msg)));

    agent = await agentFor(tabId);
    const current = agent;
    current.ports.add(port);
    // Closing or hiding the panel does not stop the agent; Stop or closing the tab does.
    port.onDisconnect.addListener(() => current.ports.delete(port));
    replay(current, port);
    queue.forEach(handle);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    agents.get(tabId)?.session.stop();
    agents.delete(tabId);
    chrome.storage.session.remove(key(tabId)).catch(() => {});
    updateKeepAlive();
  });
});
