import type { Memory, Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  provider: 'openrouter',
  apiKeys: { openrouter: '', openai: '', anthropic: '', custom: '' },
  models: { openrouter: '', openai: '', anthropic: '', custom: '' },
  customBaseUrl: 'http://localhost:11434/v1',
  confirmMode: 'risky',
  maxSteps: 30,
  useDebugger: true,
};

export const EMPTY_MEMORY: Memory = { about: '', docs: [] };

/** Limits keep memory cheap: `about` rides along on every request. */
export const ABOUT_LIMIT = 3000;
export const DOC_LIMIT = 30000;

/** Keys and memory live only in chrome.storage.local on this device. */
export async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get('settings')).settings as Partial<Settings> | undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...stored?.apiKeys },
    models: { ...DEFAULT_SETTINGS.models, ...stored?.models },
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}

export async function loadMemory(): Promise<Memory> {
  const stored = (await chrome.storage.local.get('memory')).memory as Partial<Memory> | undefined;
  return { about: stored?.about ?? '', docs: stored?.docs ?? [] };
}

export async function saveMemory(memory: Memory): Promise<void> {
  await chrome.storage.local.set({ memory });
}
