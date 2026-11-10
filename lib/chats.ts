import type { AgentEvent, ChatSummary } from './types';
import type { SessionData } from './agent';

/** Saved conversations. Kept in chrome.storage.local on this device only. */
export interface SavedChat {
  log: AgentEvent[];
  data: SessionData;
}

const INDEX = 'chats';
const MAX_CHATS = 40;
const chatKey = (id: string) => `chat:${id}`;

export async function listChats(): Promise<ChatSummary[]> {
  return ((await chrome.storage.local.get(INDEX))[INDEX] as ChatSummary[] | undefined) ?? [];
}

export async function loadChat(id: string): Promise<SavedChat | undefined> {
  return (await chrome.storage.local.get(chatKey(id)))[chatKey(id)] as SavedChat | undefined;
}

// Several tabs can save at once; run index updates one after another so none is lost.
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
};

export function saveChat(id: string, chat: SavedChat): Promise<void> {
  return serial(async () => {
    const first = chat.log.find((e) => e.type === 'user');
    if (!first || first.type !== 'user') return; // nothing worth keeping yet
    const title = first.text.replace(/\s+/g, ' ').trim().slice(0, 80);
    const index = (await listChats()).filter((c) => c.id !== id);
    index.unshift({ id, title, updatedAt: Date.now() });
    const dropped = index.splice(MAX_CHATS);
    await chrome.storage.local.set({ [chatKey(id)]: chat, [INDEX]: index });
    if (dropped.length) await chrome.storage.local.remove(dropped.map((c) => chatKey(c.id)));
  });
}

export function deleteChat(id: string): Promise<void> {
  return serial(async () => {
    await chrome.storage.local.set({ [INDEX]: (await listChats()).filter((c) => c.id !== id) });
    await chrome.storage.local.remove(chatKey(id));
  });
}

export function clearChats(): Promise<void> {
  return serial(async () => {
    const index = await listChats();
    await chrome.storage.local.remove([INDEX, ...index.map((c) => chatKey(c.id))]);
  });
}
