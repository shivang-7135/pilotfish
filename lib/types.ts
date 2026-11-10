export type ProviderId = 'openrouter' | 'openai' | 'anthropic' | 'custom';

export interface Settings {
  provider: ProviderId;
  apiKeys: Record<ProviderId, string>;
  models: Record<ProviderId, string>;
  /** Base URL of any OpenAI-compatible API (Ollama, LM Studio, a proxy…). */
  customBaseUrl: string;
  /** When to pause and ask before the agent acts. */
  confirmMode: 'risky' | 'always' | 'never';
  maxSteps: number;
  /** Use chrome.debugger (CDP) for trusted clicks and typing. */
  useDebugger: boolean;
}

/** What the user lets the agent know about them. Stored only on this device. */
export interface Memory {
  /** Short facts that are always available to the agent (name, address, phone…). */
  about: string;
  /** Longer documents (a CV, a cover letter). Only their names are sent; the agent reads one when it needs it. */
  docs: MemoryDoc[];
}
export interface MemoryDoc {
  id: string;
  name: string;
  text: string;
}

export interface Attachment {
  name: string;
  text: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * Provider-neutral conversation history.
 * `pageState` is a full page outline; `pageUpdate` is a diff against the state before it.
 */
export type ChatMessage =
  | { role: 'user'; content: string; pageState?: string; pageUpdate?: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; pageState?: string; pageUpdate?: string };

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelReply {
  text: string;
  toolCalls: ToolCall[];
  usage: { input: number; output: number; cached: number };
}

export type StepStatus = 'running' | 'ok' | 'error' | 'denied';

/** Background → side panel. The same events are stored and replayed when a panel (re)opens. */
export type AgentEvent =
  | { type: 'user'; text: string; files?: string[] }
  | { type: 'status'; running: boolean }
  | { type: 'assistant'; text: string }
  | { type: 'step'; id: string; label: string; status: StepStatus; detail?: string }
  | { type: 'confirm'; id: string; message: string }
  | { type: 'confirm_done'; id: string }
  | { type: 'ask'; question: string }
  | { type: 'done'; summary: string }
  | { type: 'error'; message: string }
  | { type: 'usage'; input: number; output: number; cached: number };

export type PortMessage =
  | AgentEvent
  | { type: 'replay'; events: AgentEvent[] }
  /** Puts a rewound message back in the composer for editing. */
  | { type: 'draft'; text: string; attachments: Attachment[] };

/** One saved conversation, as listed in the History screen. */
export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
}

/** Side panel → background. */
export type PanelMessage =
  | { type: 'run'; text: string; attachments?: Attachment[] }
  | { type: 'stop' }
  | { type: 'confirm_reply'; id: string; allow: boolean }
  /** Start a new, empty chat in this tab (the current one stays in History). */
  | { type: 'reset' }
  /** Run the last message again from scratch. */
  | { type: 'retry' }
  /** Take the last message back for editing. */
  | { type: 'edit' }
  | { type: 'open_chat'; id: string }
  | { type: 'delete_chat'; id: string }
  | { type: 'clear_chats' };

/** Each tab has its own agent; the panel connects with `${PORT_PREFIX}${tabId}`. */
export const PORT_PREFIX = 'pilotfish:';
