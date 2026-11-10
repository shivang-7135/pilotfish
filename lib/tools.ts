import type { ToolCall, ToolDef } from './types';
import { pageAgent, type Target } from './page';
import * as cdp from './cdp';
import { defuse } from './providers';

const ref = { type: 'integer', description: 'The [number] of the element in the page state.' };

export const TOOLS: ToolDef[] = [
  {
    name: 'fill_form',
    description:
      'Fill many form fields in ONE call — always prefer this for forms. value: the text for text fields, the visible option text for dropdowns, true/false for checkboxes and radio buttons. Dates: YYYY-MM-DD for input[type=date]; otherwise the format the field shows. Each result says if a field shows something different afterwards.',
    parameters: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: { ref, value: { type: ['string', 'boolean', 'number'] } },
            required: ['ref', 'value'],
          },
        },
      },
      required: ['fields'],
    },
  },
  {
    name: 'click',
    description: 'Click an element (button, link, tab, custom dropdown…).',
    parameters: { type: 'object', properties: { ref }, required: ['ref'] },
  },
  {
    name: 'type',
    description:
      'Type into one field with real key presses. Use for search boxes, autocompletes, masked or sectioned date fields, or when fill_form did not stick. submit=true presses Enter afterwards.',
    parameters: {
      type: 'object',
      properties: { ref, text: { type: 'string' }, submit: { type: 'boolean' } },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'select_option',
    description: 'Choose an option in a native <select> by its visible text.',
    parameters: { type: 'object', properties: { ref, value: { type: 'string' } }, required: ['ref', 'value'] },
  },
  {
    name: 'press_key',
    description: 'Press a key on the focused element.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', enum: Object.keys(cdp.KEYS) } },
      required: ['key'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page.',
    parameters: {
      type: 'object',
      properties: { direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'] } },
      required: ['direction'],
    },
  },
  {
    name: 'navigate',
    description: 'Open a URL in this tab.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  { name: 'go_back', description: 'Go back one page.', parameters: { type: 'object', properties: {} } },
  {
    name: 'read_page',
    description: 'Get the full text of the page when the page state is truncated or lacks detail.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'wait',
    description: 'Wait for the page to update (max 10 seconds).',
    parameters: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'] },
  },
  {
    name: 'read_memory',
    description: "Read one of the user's saved documents (names are listed in your instructions).",
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'remember',
    description:
      'Offer to save a short, durable fact the user gave you (e.g. their phone number) so future forms can use it. The user must approve.',
    parameters: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] },
  },
  {
    name: 'ask_user',
    description: 'Ask the user for missing information or a decision. Ends your turn until they answer.',
    parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  },
  {
    name: 'done',
    description: 'Finish. Summarize what was done, or why it could not be completed.',
    parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (s: unknown, n = 50) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

export interface Field {
  ref: unknown;
  value: unknown;
}
export const fieldsOf = (call: ToolCall): Field[] =>
  Array.isArray(call.args.fields) ? (call.args.fields as Field[]).filter((f) => f && f.ref != null) : [];

/** Executes tool calls against one browser tab. An agent never leaves its tab. */
export class Browser {
  private note = '';

  constructor(
    readonly tabId: number,
    private useDebugger: boolean,
  ) {}

  /**
   * Links that open a new tab are pulled back into this one, so the agent,
   * its panel and its highlight always stay with the tab the user gave it.
   */
  private onCreated = (tab: chrome.tabs.Tab) => {
    if (tab.openerTabId !== this.tabId || tab.id == null) return;
    const url = tab.pendingUrl || tab.url || '';
    if (!/^https?:/i.test(url)) return;
    void chrome.tabs.remove(tab.id).catch(() => {});
    void chrome.tabs.update(this.tabId, { url }).catch(() => {});
    this.note = ` The link wanted a new tab; it was opened in this tab instead (${short(url, 80)}).`;
  };

  start(): void {
    chrome.tabs.onCreated.addListener(this.onCreated);
  }

  async dispose(): Promise<void> {
    chrome.tabs.onCreated.removeListener(this.onCreated);
    await this.page('cleanup').catch(() => {});
    await cdp.detach(this.tabId);
  }

  private async page<T = any>(cmd: string, arg?: unknown): Promise<T> {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: pageAgent,
      args: [cmd, arg ?? null],
    });
    const out = res?.result as any;
    if (out && typeof out === 'object' && out.error) throw new Error(out.error);
    return out as T;
  }

  /** Waits for a navigation to finish, if the action started one. */
  private async settle(first = 120): Promise<void> {
    await sleep(first);
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      const tab = await chrome.tabs.get(this.tabId).catch(() => null);
      if (!tab || tab.status === 'complete') break;
      await sleep(100);
    }
    // Then let animations and re-renders finish, so the next outline has no half-gone elements.
    await this.page('idle').catch(() => sleep(80));
  }

  private async canDebug(): Promise<boolean> {
    return this.useDebugger && (await cdp.ensure(this.tabId));
  }

  /** Page outline; also (re)draws the "working here" frame, which navigation wipes. */
  async snapshot(): Promise<string> {
    try {
      return await this.page<string>('snapshot', { working: true });
    } catch {
      const tab = await chrome.tabs.get(this.tabId).catch(() => null);
      return `URL: ${tab?.url ?? 'unknown'}\n(This page cannot be read or controlled by extensions — for example browser settings pages or the Chrome Web Store. Use navigate to go somewhere else.)`;
    }
  }

  /** Tab-title marker: '⏳' working, '❓' waiting for the user. */
  async mark(mark: string): Promise<void> {
    await this.page('mark', mark).catch(() => {});
  }

  /** Points at an element on the page, e.g. the one waiting for approval. */
  async highlight(ref: unknown, label: string): Promise<void> {
    await this.page('highlight', { ref, label }).catch(() => {});
  }

  /** Looks up the element a call points at (scrolling it into view). Null when the call has no ref. */
  async target(call: ToolCall): Promise<Target | null> {
    if (call.args.ref == null) return null;
    return this.page<Target>('locate', call.args.ref);
  }

  /** The focused element: what a key press would act on. */
  async activeTarget(): Promise<Target | null> {
    return this.page<Target | null>('active').catch(() => null);
  }

  async currentUrl(): Promise<string> {
    return (await chrome.tabs.get(this.tabId).catch(() => null))?.url ?? '';
  }

  async targets(refs: unknown[]): Promise<(Target | null)[]> {
    return this.page<(Target | null)[]>('infoMany', refs);
  }

  async exec(call: ToolCall, target: Target | null): Promise<string> {
    this.note = '';
    const result = await this.run(call.name, call.args, target, call);
    return result + this.note;
  }

  private async run(name: string, a: Record<string, unknown>, t: Target | null, call: ToolCall): Promise<string> {
    switch (name) {
      case 'fill_form': {
        const fields = fieldsOf(call);
        if (!fields.length) throw new Error('fill_form needs a non-empty "fields" array of {ref, value}.');
        const { results } = await this.page<{ results: string[] }>('fillMany', fields);
        await sleep(60);
        return results.join('\n');
      }
      case 'click': {
        if (!t) throw new Error('click needs a ref.');
        if (t.tag === 'select') throw new Error('Use select_option or fill_form for dropdowns.');
        if (t.type === 'file') throw new Error('File pickers cannot be operated. Ask the user to choose the file.');
        await this.page('highlight', { ref: a.ref, label: 'Clicking' });
        if (!t.covered && (await this.canDebug())) await cdp.click(this.tabId, t.x, t.y);
        else await this.page('click', a.ref);
        if (t.type === 'checkbox' || t.type === 'radio') await sleep(40);
        else await this.settle();
        return `Clicked ${t.desc}.`;
      }
      case 'type': {
        if (!t) throw new Error('type needs a ref.');
        if (!t.editable) throw new Error('That element is not a text field.');
        if (t.readonly) {
          throw new Error('That field is read-only and cannot be typed into. Click it to open its picker and choose there.');
        }
        const asked = String(a.text ?? '');
        const text = t.nativePicker ? asked : (await this.page<{ text: string }>('format', { ref: a.ref, text: asked })).text;
        await this.page('highlight', { ref: a.ref, label: 'Typing' });
        let shown: string | null = null;
        // Native date/time inputs are set directly; typing into their segments is unreliable.
        if (text && !t.nativePicker && (await this.canDebug())) {
          if (!t.covered) await cdp.click(this.tabId, t.x, t.y);
          await this.page('focusSelect', a.ref);
          // Short values get real key presses (masks, date fields, autocompletes); long text is inserted at once.
          if (text.length <= 40 && !/[\n\r\t]/.test(text)) await cdp.typeKeys(this.tabId, text);
          else await cdp.insertText(this.tabId, text);
          shown = (await this.page<{ value: string }>('commit', a.ref)).value;
        }
        let note = '';
        if (shown === null || !shown.trim()) {
          // No debugger, or the keystrokes did not land: set the value through the DOM.
          const r = await this.page<{ note?: string }>('fill', { ref: a.ref, text });
          note = r.note ? ` Note: ${r.note}.` : '';
        } else if (shown.trim() !== text.trim()) {
          note = ` Note: field now shows "${short(shown, 40)}".`;
        }
        if (a.submit) {
          await this.key('Enter');
          await this.settle();
        }
        return `Typed into ${t.desc.split(' value=')[0]}.${note}${a.submit ? ' Pressed Enter.' : ''}`;
      }
      case 'select_option': {
        const r = await this.page<{ chosen: string }>('select', { ref: a.ref, value: a.value });
        await this.page('highlight', { ref: a.ref, label: 'Selected' });
        await sleep(60);
        return `Selected "${r.chosen}".`;
      }
      case 'press_key': {
        const key = String(a.key);
        if (!cdp.KEYS[key]) throw new Error(`Unsupported key. Use one of: ${Object.keys(cdp.KEYS).join(', ')}`);
        await this.key(key);
        await this.settle(key === 'Enter' ? 250 : 60);
        return `Pressed ${key}.`;
      }
      case 'scroll': {
        await this.page('scroll', a.direction);
        await sleep(150);
        return `Scrolled ${a.direction}.`;
      }
      case 'navigate': {
        let url = String(a.url ?? '').trim();
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
        if (!/^https?:/i.test(url)) throw new Error('Only http and https URLs can be opened.');
        await chrome.tabs.update(this.tabId, { url });
        await this.settle();
        return `Opened ${url}.`;
      }
      case 'go_back': {
        await chrome.tabs.goBack(this.tabId);
        await this.settle();
        return 'Went back.';
      }
      case 'read_page': {
        const { text } = await this.page<{ text: string }>('text');
        return `<page_text>\n${defuse(text)}\n</page_text>`;
      }
      case 'wait': {
        const s = Math.min(Math.max(Number(a.seconds) || 1, 0.2), 10);
        await sleep(s * 1000);
        return `Waited ${s}s.`;
      }
    }
    throw new Error(`Unknown tool "${name}".`);
  }

  private async key(key: string): Promise<void> {
    if (await this.canDebug()) await cdp.pressKey(this.tabId, key);
    else await this.page('key', key);
  }
}

/** Short human-readable description of a step for the side panel. */
export function labelFor(call: ToolCall, target: Target | null, shownText?: string, names?: string[]): string {
  const a = call.args;
  const what = target ? `“${short(target.name || target.tag)}”` : `element ${a.ref}`;
  switch (call.name) {
    case 'fill_form': {
      const n = fieldsOf(call).length;
      const list = (names ?? []).slice(0, 4).map((x) => `“${short(x, 24)}”`);
      return `Fill ${n} field${n === 1 ? '' : 's'}${list.length ? `: ${list.join(', ')}${n > 4 ? '…' : ''}` : ''}`;
    }
    case 'click':
      return `Click ${what}`;
    case 'type':
      return `Type “${short(shownText ?? a.text)}” into ${what}`;
    case 'select_option':
      return `Select “${short(a.value)}” in ${what}`;
    case 'press_key':
      return `Press ${a.key}`;
    case 'scroll':
      return `Scroll ${a.direction}`;
    case 'navigate':
      return `Open ${short(a.url, 70)}`;
    case 'go_back':
      return 'Go back';
    case 'read_page':
      return 'Read the page';
    case 'wait':
      return `Wait ${a.seconds}s`;
    case 'read_memory':
      return `Read “${short(a.name)}” from memory`;
    case 'remember':
      return `Remember: ${short(a.fact, 80)}`;
    default:
      return call.name;
  }
}
