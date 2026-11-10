/**
 * Thin wrapper over chrome.debugger (Chrome DevTools Protocol).
 * CDP input produces trusted events, which some sites require. If attaching
 * fails or the user dismisses Chrome's debugging banner, callers fall back to
 * plain DOM events.
 */
const attached = new Set<number>();
const refused = new Set<number>();

chrome.debugger?.onDetach.addListener((source, reason) => {
  if (source.tabId == null) return;
  attached.delete(source.tabId);
  // The user pressed "Cancel" on the banner: respect that for this tab.
  if (reason === 'canceled_by_user') refused.add(source.tabId);
});

export async function ensure(tabId: number): Promise<boolean> {
  if (attached.has(tabId)) return true;
  if (refused.has(tabId) || !chrome.debugger) return false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached.add(tabId);
    return true;
  } catch {
    return false;
  }
}

export async function detach(tabId: number): Promise<void> {
  // `refused` is kept: if the user cancelled the debugging bar on this tab, do not attach again.
  if (!attached.delete(tabId)) return;
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

const send = (tabId: number, method: string, params: Record<string, unknown>) =>
  chrome.debugger.sendCommand({ tabId }, method, params);

export async function click(tabId: number, x: number, y: number): Promise<void> {
  const base = { x, y, button: 'left', clickCount: 1 };
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
}

export async function insertText(tabId: number, text: string): Promise<void> {
  await send(tabId, 'Input.insertText', { text });
}

/**
 * Types with one real key press per character. Masked fields, date pickers and
 * autocompletes react to key events that a plain text insert never sends.
 */
export async function typeKeys(tabId: number, text: string): Promise<void> {
  for (const ch of text) {
    const upper = ch.toUpperCase();
    const vk = /[0-9A-Z]/.test(upper) ? upper.charCodeAt(0) : 0;
    const code = /[0-9]/.test(ch) ? `Digit${ch}` : /[a-z]/i.test(ch) ? `Key${upper}` : '';
    const base = { key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await send(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyDown', text: ch, unmodifiedText: ch });
    await send(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }
}

export const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  Space: { code: 'Space', vk: 32, text: ' ' },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
};

export async function pressKey(tabId: number, key: string): Promise<void> {
  const k = KEYS[key];
  const base = {
    key: key === 'Space' ? ' ' : key,
    code: k.code,
    windowsVirtualKeyCode: k.vk,
    nativeVirtualKeyCode: k.vk,
  };
  await send(tabId, 'Input.dispatchKeyEvent', { ...base, type: k.text ? 'keyDown' : 'rawKeyDown', text: k.text });
  await send(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}
