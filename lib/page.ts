/**
 * Runs inside the web page (isolated world) via chrome.scripting.executeScript.
 *
 * IMPORTANT: this function is serialized and injected on its own, so it must be
 * fully self-contained — no imports and no references to anything outside it.
 */
export function pageAgent(cmd: string, arg: any): any {
  const w = window as any;
  const store: {
    ids: WeakMap<Element, number>;
    els: Map<number, Element>;
    next: number;
    title?: string;
  } = w.__pilotfish || (w.__pilotfish = { ids: new WeakMap(), els: new Map(), next: 1 });

  const SEL =
    'a[href],button,input:not([type=hidden]),textarea,select,summary,' +
    '[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],' +
    '[role=option],[role=combobox],[role=textbox],[role=searchbox],[role=switch],' +
    '[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  const NATIVE = ['a', 'button', 'input', 'select', 'textarea', 'summary'];
  const SKIP = ['script', 'style', 'noscript', 'template', 'svg', 'head', 'link', 'meta'];
  const MAX_CHARS = 12000;
  const ACCENT = '#ff6a00';
  const HOST_ID = '__pilotfish_overlay';
  const MARKS = /^(⏳|❓)( |$)/; // the browser trims a trailing space on untitled pages

  const clean = (s: unknown, max = 80): string => {
    const t = String(s == null ? '' : s)
      .replace(/\s+/g, ' ')
      .trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  };

  const refOf = (el: Element): number => {
    let id = store.ids.get(el);
    if (!id) {
      id = store.next++;
      store.ids.set(el, id);
    }
    store.els.set(id, el);
    return id;
  };

  const nameOf = (el: Element, loose = false): string => {
    const n = strictName(el);
    if (n || !loose) return n;
    // Icon-only clickable (e.g. a calendar's "next month" arrow): its class is the best hint left.
    const cls = String((el as HTMLElement).className?.toString?.() || '').split(/\s+/)[0] || '';
    return clean(cls.replace(/[_-]+/g, ' '), 40);
  };
  const strictName = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ');
      if (t.trim()) return clean(t);
    }
    const tag = el.tagName.toLowerCase();
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) {
      // Clone so a wrapped control's own text (e.g. <select> options) is not part of the name.
      const c = labels[0].cloneNode(true) as HTMLElement;
      c.querySelectorAll('select,textarea,input').forEach((n) => n.remove());
      const t = clean(c.textContent);
      if (t) return t;
    }
    if (tag === 'input') {
      const i = el as HTMLInputElement;
      if (['submit', 'button', 'reset'].includes(i.type) && i.value) return clean(i.value);
    } else if (tag !== 'select' && tag !== 'textarea' && !(el as HTMLElement).isContentEditable) {
      const t = clean((el as HTMLElement).innerText || el.textContent);
      if (t) return t;
    }
    return clean(
      el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        el.querySelector('img[alt]')?.getAttribute('alt') ||
        el.getAttribute('name') ||
        el.id ||
        '',
    );
  };

  const describe = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const h = el as HTMLElement;
    const role = el.getAttribute('role');
    const generic = !role && !NATIVE.includes(tag) && !h.isContentEditable;
    let kind = role || (tag === 'a' ? 'link' : generic ? 'clickable' : tag);
    if (tag === 'input') kind = `input[type=${(el as HTMLInputElement).type}]`;
    else if (h.isContentEditable && !role) kind = 'editable';
    let out = `[${refOf(el)}] ${kind}`;
    const name = nameOf(el, generic || role === 'gridcell');
    if (name) out += ` "${name}"`;
    if (generic || role === 'gridcell' || role === 'option') {
      // Calendar cells: tell the model which "15" belongs to the shown month and which is chosen.
      const cls = String(h.className?.toString?.() || '');
      if (/prevMonth|nextMonth|outside|other-month|adjacent/i.test(cls)) out += ' (other month)';
      if (el.getAttribute('aria-selected') === 'true' || /(^|[\s_-])selected/i.test(cls)) out += ' (selected)';
      if (/(^|[\s_-])disabled/i.test(cls)) out += ' (disabled)';
    }

    if (tag === 'input' || tag === 'textarea') {
      const i = el as HTMLInputElement;
      if (i.type === 'checkbox' || i.type === 'radio') out += i.checked ? ' (checked)' : ' (unchecked)';
      else if (i.type === 'password') out += i.value ? ' value=(hidden)' : '';
      else if (i.value) out += ` value="${clean(i.value, 60)}"`;
      else if (i.placeholder && clean(i.placeholder) !== name) out += ` placeholder="${clean(i.placeholder, 40)}"`;
      if (i.readOnly) out += ' (readonly)';
    } else if (tag === 'select') {
      const s = el as HTMLSelectElement;
      const opts = Array.from(s.options);
      out += ` value="${clean(s.selectedOptions[0]?.text, 40)}" options=[${opts
        .slice(0, 12)
        .map((o) => `"${clean(o.text, 30)}"`)
        .join(',')}${opts.length > 12 ? `,… +${opts.length - 12} more` : ''}]`;
    } else if (kind === 'editable') {
      const t = clean(h.innerText, 60);
      if (t) out += ` value="${t}"`;
    } else if (tag === 'a') {
      // Path only: the origin and query string rarely matter and cost tokens.
      let href = el.getAttribute('href') || '';
      try {
        const u = new URL(href, location.href);
        href = u.origin === location.origin ? u.pathname : u.host + u.pathname;
      } catch {
        /* keep raw */
      }
      if (href && href !== '/' && !href.startsWith('javascript:')) out += ` -> ${clean(href, 40)}`;
    }
    const ariaChecked = el.getAttribute('aria-checked');
    if (ariaChecked) out += ariaChecked === 'true' ? ' (checked)' : ' (unchecked)';
    const expanded = el.getAttribute('aria-expanded');
    if (expanded) out += expanded === 'true' ? ' (expanded)' : ' (collapsed)';
    if ((el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true') out += ' (required)';
    if (el.getAttribute('aria-invalid') === 'true') out += ' (invalid)';
    if ((el as HTMLInputElement).disabled || el.getAttribute('aria-disabled') === 'true') out += ' (disabled)';
    return out;
  };

  const snapshot = (): string => {
    store.els.clear();
    const lines: string[] = [];
    let buf = '';
    let chars = 0;
    let truncated = false;
    const push = (line: string) => {
      if (chars > MAX_CHARS) {
        truncated = true;
        return;
      }
      lines.push(line);
      chars += line.length + 1;
    };
    const flush = () => {
      const t = clean(buf, 160);
      buf = '';
      if (t) push(t);
    };
    const walk = (node: Node) => {
      if (truncated) return;
      if (node.nodeType === 3) {
        buf += node.textContent;
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node as HTMLElement;
      const tag = el.tagName.toLowerCase();
      if (SKIP.includes(tag) || el.id === HOST_ID) return;
      if (el.getAttribute('aria-hidden') === 'true' && !el.matches(SEL)) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      if (tag === 'iframe') {
        flush();
        push(`(iframe "${clean(el.getAttribute('title') || el.getAttribute('src'), 60)}" — contents not readable)`);
        return;
      }
      if (el.matches(SEL)) {
        const isToggle = tag === 'input' && ['checkbox', 'radio'].includes((el as HTMLInputElement).type);
        const r = el.getBoundingClientRect();
        const hasBox = r.width > 0 || r.height > 0 || isToggle;
        // A generic clickable wrapper around real controls is a container, not a target.
        const container = !NATIVE.includes(tag) && !!el.querySelector(SEL);
        if (hasBox && !container) {
          flush();
          push(describe(el));
          return;
        }
      }
      // Sites built with React & co. attach clicks to plain elements. A pointer cursor is the
      // most reliable sign (calendar days, custom dropdown options, cards). Only the outermost
      // pointer element counts, and only if it wraps no real control.
      if (cs.cursor === 'pointer' && tag !== 'label' && !el.matches(SEL)) {
        const parent = el.parentElement;
        if (!(parent && getComputedStyle(parent).cursor === 'pointer') && !el.querySelector(SEL)) {
          const r = el.getBoundingClientRect();
          const small = r.width * r.height < window.innerWidth * window.innerHeight * 0.4;
          if (r.width > 0 && r.height > 0 && small && nameOf(el, true)) {
            flush();
            push(describe(el));
            return;
          }
        }
      }
      const block = !cs.display.startsWith('inline') && cs.display !== 'contents';
      if (block) flush();
      if (/^h[1-6]$/.test(tag)) buf += '#'.repeat(Number(tag[1])) + ' ';
      else if (tag === 'li') buf += '- ';
      else if (tag === 'br') buf += ' ';
      for (const child of Array.from(el.childNodes)) walk(child);
      if (el.shadowRoot) for (const child of Array.from(el.shadowRoot.childNodes)) walk(child);
      if (block) flush();
    };
    if (document.body) walk(document.body);
    flush();
    const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const more = maxY - window.scrollY > 40;
    return [
      `URL: ${location.href}`,
      `Title: ${clean(document.title.replace(MARKS, ''), 120)}`,
      // Coarse on purpose: an exact scroll position would change on every step and bloat diffs.
      `Scroll: ${maxY <= 0 ? 'page fits the viewport' : more ? 'more content below' : 'at the bottom'}`,
      '',
      ...lines,
      ...(truncated ? ['…(page truncated — scroll or use read_page for the rest)'] : []),
    ].join('\n');
  };

  // ---------- visible "the agent is working here" overlay ----------
  // Built with inline styles and the Web Animations API only, so a strict page CSP cannot block it.
  const css = (el: HTMLElement, style: string) => {
    el.style.cssText = style;
    return el;
  };
  const overlay = (create: boolean): ShadowRoot | null => {
    let host = document.getElementById(HOST_ID);
    if (!host && create) {
      host = css(
        document.createElement('div'),
        'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;',
      );
      host.id = HOST_ID;
      host.setAttribute('aria-hidden', 'true');
      const root = host.attachShadow({ mode: 'open' });
      const frame = css(
        document.createElement('div'),
        `position:fixed;inset:0;pointer-events:none;border:4px solid ${ACCENT};` +
          `box-shadow:inset 0 0 28px 2px ${ACCENT}99;border-radius:2px;`,
      );
      frame.animate([{ opacity: 1 }, { opacity: 0.55 }, { opacity: 1 }], { duration: 1800, iterations: Infinity });
      const pill = css(
        document.createElement('div'),
        `position:fixed;top:0;left:50%;transform:translateX(-50%);pointer-events:none;background:${ACCENT};color:#fff;` +
          'font:600 12px/1 system-ui,sans-serif;padding:6px 12px 7px;border-radius:0 0 10px 10px;letter-spacing:.01em;' +
          'white-space:nowrap;box-shadow:0 2px 10px rgba(0,0,0,.25);',
      );
      pill.textContent = 'Pilotfish is working in this tab';
      const boxes = document.createElement('div');
      boxes.id = 'boxes';
      root.append(frame, pill, boxes);
      document.documentElement.appendChild(host);
    }
    return host ? host.shadowRoot : null;
  };
  const spotlight = (els: HTMLElement[], label: string) => {
    const root = overlay(true)!;
    const boxes = root.getElementById('boxes')!;
    boxes.replaceChildren();
    els.forEach((el, n) => {
      const r = el.getBoundingClientRect();
      const pad = 5;
      const box = css(
        document.createElement('div'),
        `position:absolute;left:${r.left + scrollX - pad}px;top:${r.top + scrollY - pad}px;` +
          `width:${r.width + pad * 2}px;height:${r.height + pad * 2}px;box-sizing:border-box;pointer-events:none;` +
          `border:3px solid ${ACCENT};border-radius:8px;background:${ACCENT}22;box-shadow:0 0 0 5px ${ACCENT}44,0 0 22px ${ACCENT};`,
      );
      box.animate(
        [{ transform: 'scale(1.12)', opacity: 0.2 }, { transform: 'scale(1)', opacity: 1 }],
        { duration: 220, easing: 'ease-out' },
      );
      if (n === 0 && label) {
        const tag = css(
          document.createElement('div'),
          `position:absolute;left:-3px;${r.top > 34 ? 'bottom:100%;margin-bottom:6px' : 'top:100%;margin-top:6px'};` +
            `background:${ACCENT};color:#fff;font:600 12px/1 system-ui,sans-serif;padding:5px 8px;border-radius:6px;white-space:nowrap;`,
        );
        tag.textContent = label;
        box.appendChild(tag);
      }
      boxes.appendChild(box);
    });
  };
  const setMark = (mark: string) => {
    const base = document.title.replace(MARKS, '');
    const want = mark ? `${mark} ${base}` : base;
    if (document.title !== want) document.title = want;
  };

  const get = (ref: unknown): HTMLElement | null => {
    const el = store.els.get(Number(ref));
    return el && el.isConnected ? (el as HTMLElement) : null;
  };
  const STALE = { error: 'That ref no longer exists on the page. Use refs from the latest page state.' };

  const fire = (el: Element, type: string) => el.dispatchEvent(new Event(type, { bubbles: true }));
  const setValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    // The native setter bypasses React/Vue value tracking so their change handlers fire.
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
    fire(el, 'change');
  };
  const domClick = (el: HTMLElement) => {
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.focus?.();
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  };
  const pad = (n: number | string) => String(n).padStart(2, '0');
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  /** Month number from an English or German month name ("Januar", "März", "Mai", "Okt", "Dez"). */
  const monthOf = (word: string): number => {
    const w = word.toLowerCase().replace('ä', 'a').slice(0, 3);
    return MONTHS.indexOf(({ mai: 'may', okt: 'oct', dez: 'dec' } as Record<string, string>)[w] || w) + 1;
  };
  /** Rejects impossible dates such as 31 February. */
  const real = (y: number, m: number, d: number) =>
    m >= 1 && m <= 12 && d >= 1 && d <= new Date(y, m, 0).getDate() ? { y, m, d } : null;
  /** Reads a date in any common spelling. Refuses 03/04/2027-style dates whose order is a guess. */
  const parseDate = (raw: string): { y: number; m: number; d: number } | null => {
    const t = raw.trim();
    let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return real(+m[1], +m[2], +m[3]);
    m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/); // 15.01.2027 is always day first
    if (m) return real(+m[3], +m[2], +m[1]);
    m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    if (m) {
      const a = +m[1];
      const b = +m[2];
      if (a > 12 && b <= 12) return real(+m[3], b, a);
      if (b > 12 && a <= 12) return real(+m[3], a, b);
      if (a === b) return real(+m[3], a, a);
      return null;
    }
    m = t.match(/^(\d{1,2})\.?\s+([a-zä]{3})[a-zä]*\.?,?\s+(\d{4})/i) || null; // 15 Jan 2027, 15. März 2027
    if (m && monthOf(m[2])) return real(+m[3], monthOf(m[2]), +m[1]);
    m = t.match(/^([a-zä]{3})[a-zä]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i) || null; // January 15, 2027
    if (m && monthOf(m[1])) return real(+m[3], monthOf(m[1]), +m[2]);
    return null;
  };
  const parseTime = (raw: string): string | null => {
    const m = raw.trim().match(/(\d{1,2})[:.](\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (!m) return null;
    let h = +m[1];
    if (m[4]) h = (h % 12) + (m[4].toLowerCase() === 'pm' ? 12 : 0);
    return `${pad(h)}:${m[2]}`;
  };
  const NATIVE_FORMAT: Record<string, string> = {
    date: 'YYYY-MM-DD',
    time: 'HH:MM',
    'datetime-local': 'YYYY-MM-DDTHH:MM',
    month: 'YYYY-MM',
    week: 'YYYY-Www',
  };
  /** Native date/time inputs only accept ISO; convert whatever the model wrote. */
  const toNative = (type: string, raw: string): string => {
    const d = parseDate(raw);
    const iso = d ? `${d.y}-${pad(d.m)}-${pad(d.d)}` : '';
    if (type === 'date') return iso || raw;
    if (type === 'time') return parseTime(raw) || raw;
    if (type === 'datetime-local') {
      // Whatever follows the date part is the time ("2027-1-5 9:30", "15.01.2027, 10:30", "…T10:30").
      const time = parseTime(raw.trim().replace(/^(\d{4}-\d{1,2}-\d{1,2}|\S+)[T\s,]*/, ''));
      return iso ? `${iso}T${time || '00:00'}` : raw;
    }
    if (type === 'month') {
      const mm = raw.trim().match(/^(\d{1,2})[/.-](\d{4})$/);
      if (mm) return `${mm[2]}-${pad(mm[1])}`;
      const named = parseDate(`1 ${raw}`);
      return d ? `${d.y}-${pad(d.m)}` : named ? `${named.y}-${pad(named.m)}` : raw;
    }
    return raw;
  };
  /**
   * A text field that shows its date format (placeholder "DD.MM.YYYY", "TT.MM.JJJJ", "mm/dd/yyyy"…)
   * gets an ISO date rewritten into that format.
   */
  const toFieldFormat = (el: HTMLElement, text: string): string => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text.trim())) return text;
    const hint = [el.getAttribute('placeholder'), el.getAttribute('data-date-format'), el.getAttribute('aria-placeholder')]
      .filter(Boolean)
      .join(' ');
    const m = hint.match(/\b([dtmyj]{1,4})([./-])([dtmyj]{1,4})\2([dtmyj]{2,4})\b/i);
    if (!m) return text;
    const [y, mo, d] = text.trim().split('-');
    const part = (token: string) => {
      const k = token[0].toLowerCase();
      if (k === 'd' || k === 't') return token.length === 1 ? String(+d) : d;
      if (k === 'm') return token.length === 1 ? String(+mo) : mo;
      return token.length === 2 ? y.slice(2) : y;
    };
    return [part(m[1]), part(m[3]), part(m[4])].join(m[2]);
  };

  /** Sets a field's text. Returns an error, or a note when the field shows something else than asked. */
  const fillText = (el: HTMLElement, raw: string): { error?: string; note?: string } => {
    let text = raw;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.readOnly) {
        return { error: 'is read-only and cannot be typed into; click it to open its picker and choose there' };
      }
      const native = el instanceof HTMLInputElement ? NATIVE_FORMAT[el.type] : undefined;
      text = native ? toNative((el as HTMLInputElement).type, raw) : toFieldFormat(el, raw);
      el.focus();
      setValue(el, text);
      // Some widgets (flatpickr's year box, masks) only commit on a key event.
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
      if (native && el.value !== text) {
        return { error: `did not accept "${clean(raw, 30)}"; it needs a real value in the format ${native}` };
      }
      if (text && !el.value) return { error: 'rejected that value; check the expected format' };
      if (el.value !== text && el.type !== 'number') return { note: `field now shows "${clean(el.value, 40)}"` };
      return {};
    }
    if (el.isContentEditable) {
      el.focus();
      getSelection()?.selectAllChildren(el);
      document.execCommand('insertText', false, text);
      const shown = clean(el.innerText, 40);
      return shown === clean(text, 40) ? {} : { note: `field now shows "${shown}"` };
    }
    return { error: 'is not a text field' };
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const pickOption = (el: HTMLSelectElement, value: unknown): { chosen?: string; error?: string } => {
    const want = String(value).trim().toLowerCase();
    const opts = Array.from(el.options);
    const num = /^\d+$/.test(want) ? Number(want) : null;
    const opt =
      opts.find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want) ||
      // "01" should find "1" (day and month dropdowns)
      (num !== null
        ? opts.find((o) => (/^\d+$/.test(o.value.trim()) && +o.value === num) || (/^\d+$/.test(o.text.trim()) && +o.text === num))
        : undefined) ||
      opts.find((o) => o.text.toLowerCase().includes(want));
    if (!opt) return { error: `has no option "${value}". Options: ${opts.slice(0, 40).map((o) => o.text.trim()).join(' | ')}` };
    el.focus();
    el.value = opt.value;
    fire(el, 'input');
    fire(el, 'change');
    return { chosen: opt.text.trim() };
  };
  const info = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    const tag = el.tagName.toLowerCase();
    const i = el as HTMLInputElement;
    const form = i.form || el.closest('form');
    // A search box may submit on Enter without approval, so decide this from what the field IS
    // (type, role, field name), never from free text a page could word to its liking.
    const label = `${i.placeholder || ''} ${el.getAttribute('aria-label') || ''}`.trim();
    const isSearch =
      i.type === 'search' ||
      el.getAttribute('role') === 'searchbox' ||
      form?.getAttribute('role') === 'search' ||
      /(^|[^a-z])(search|query|q|s|suche)([^a-z]|$)/i.test(`${i.name || ''} ${el.id || ''}`) ||
      /^(search|suche)\b/i.test(label);
    return {
      x,
      y,
      covered: !(r.width > 0 && r.height > 0) || !top || !(top === el || el.contains(top) || top.contains(el)),
      tag,
      // An image button submits its form exactly like a submit button.
      type: tag === 'input' || tag === 'button' ? (i.type === 'image' ? 'submit' : i.type || '') : '',
      name: nameOf(el, true) || clean(el.getAttribute('alt') || el.getAttribute('value') || ''),
      desc: describe(el).replace(/^\[\d+\] /, ''),
      autocomplete: el.getAttribute('autocomplete') || '',
      fieldName: `${i.name || ''} ${el.id || ''}`.trim().toLowerCase(),
      isSearch,
      inForm: !!form,
      formHasPassword: !!form?.querySelector('input[type=password]'),
      editable: el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable,
      readonly: !!(i as HTMLInputElement).readOnly && (tag === 'input' || tag === 'textarea'),
      nativePicker: tag === 'input' && i.type in NATIVE_FORMAT,
    };
  };

  switch (cmd) {
    case 'snapshot': {
      // Re-assert the overlay and tab marker: navigation wipes them.
      if (arg?.working) {
        overlay(true);
        setMark('⏳');
      }
      return snapshot();
    }

    /** Scrolls the element into view and reports where and what it is. */
    case 'locate': {
      const el = get(arg);
      if (!el) return STALE;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
      return info(el);
    }

    /** Same facts for many elements, without scrolling (used for the safety check). */
    case 'infoMany':
      return (arg as unknown[]).map((ref) => {
        const el = get(ref);
        return el ? info(el) : null;
      });

    /** The element that has keyboard focus: where a pressed key will land. */
    case 'active': {
      const el = document.activeElement as HTMLElement | null;
      return el && el !== document.body ? info(el) : null;
    }

    case 'highlight': {
      const el = get(arg.ref);
      if (!el) return STALE;
      spotlight([el], arg.label || '');
      return { ok: true };
    }

    case 'click': {
      const el = get(arg);
      if (!el) return STALE;
      domClick(el);
      return { ok: true };
    }

    case 'focusSelect': {
      const el = get(arg);
      if (!el) return STALE;
      el.focus();
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        try {
          el.select();
        } catch {
          /* some input types cannot be selected */
        }
      } else if (el.isContentEditable) {
        getSelection()?.selectAllChildren(el);
      }
      return { ok: true };
    }

    /** The text to type for a value: an ISO date becomes the format the field displays. */
    case 'format': {
      const el = get(arg.ref);
      if (!el) return STALE;
      return { text: toFieldFormat(el, String(arg.text)) };
    }

    /** After real keystrokes: fire the change event typing alone does not, and report what the field shows. */
    case 'commit': {
      const el = get(arg);
      if (!el) return STALE;
      fire(el, 'change');
      return { value: el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.innerText };
    }

    /** Resolves once the page stops changing: no running transitions and no DOM changes for a moment. */
    case 'idle': {
      const started = Date.now();
      const busy = () =>
        !document.hidden &&
        document.getAnimations().some((a) => {
          const end = a.effect?.getComputedTiming().endTime;
          return a.playState === 'running' && typeof end === 'number' && isFinite(end) && end < 3000;
        });
      return new Promise((resolve) => {
        let last = Date.now();
        const mo = new MutationObserver(() => (last = Date.now()));
        mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
        const tick = () => {
          const now = Date.now();
          if (now - started > 1200 || (now - last >= 90 && !busy())) {
            mo.disconnect();
            resolve({ ok: true });
          } else setTimeout(tick, 30);
        };
        setTimeout(tick, 60);
      });
    }

    case 'value': {
      const el = get(arg);
      if (!el) return STALE;
      return { value: el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.innerText };
    }

    case 'fill': {
      const el = get(arg.ref);
      if (!el) return STALE;
      const r = fillText(el, String(arg.text));
      return r.error ? { error: `The field ${r.error}.` } : { ok: true, note: r.note };
    }

    /** Fills a whole form in one round trip: text, dropdowns, checkboxes and radios. */
    case 'fillMany':
      return (async () => {
        const done: HTMLElement[] = [];
        const results: string[] = [];
        for (const { ref, value } of arg as { ref: unknown; value: unknown }[]) {
          const el = get(ref);
          if (!el) {
            results.push(`[${ref}] error: no such element`);
            continue;
          }
          const name = nameOf(el) || el.tagName.toLowerCase();
          const truthy = value === true || /^(true|yes|on|checked|1)$/i.test(String(value));
          let error: string | undefined;
          let note: string | undefined;
          if (el instanceof HTMLSelectElement) {
            error = pickOption(el, value).error;
          } else if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
            if (el.checked !== truthy) domClick(el);
            if (el.checked !== truthy) error = 'could not be toggled';
          } else if (el.getAttribute('role') === 'checkbox' || el.getAttribute('role') === 'switch') {
            if ((el.getAttribute('aria-checked') === 'true') !== truthy) domClick(el);
          } else if (el instanceof HTMLInputElement && el.type === 'file') {
            error = 'is a file picker; ask the user to choose the file';
          } else {
            if (el.isContentEditable) {
              // Sectioned editors drop text inserted in the same tick as the focus.
              el.focus();
              await wait(40);
            }
            ({ error, note } = fillText(el, String(value)));
          }
          // Leaving the field is what a person does next; many forms validate and commit on blur.
          if (!error) {
            el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
            el.blur();
            done.push(el);
          }
          results.push(`[${ref}] "${name}": ${error ? 'error: ' + error : note ? 'ok, but ' + note : 'ok'}`);
        }
        if (done.length) {
          done[0].scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
          spotlight(done, `Filled ${done.length} field${done.length > 1 ? 's' : ''}`);
        }
        return { results };
      })();

    case 'select': {
      const el = get(arg.ref);
      if (!el) return STALE;
      if (!(el instanceof HTMLSelectElement)) {
        return { error: 'Not a native <select>. Click it to open the list, then click the option you want.' };
      }
      const r = pickOption(el, arg.value);
      return r.error ? { error: `The dropdown ${r.error}` } : { ok: true, chosen: r.chosen };
    }

    case 'key': {
      const el = (document.activeElement as HTMLElement) || document.body;
      const init = { key: String(arg), code: String(arg), bubbles: true, cancelable: true };
      const proceed = el.dispatchEvent(new KeyboardEvent('keydown', init));
      el.dispatchEvent(new KeyboardEvent('keyup', init));
      if (arg === 'Enter' && proceed && el instanceof HTMLInputElement && el.form) el.form.requestSubmit();
      return { ok: true };
    }

    case 'scroll': {
      const by = window.innerHeight * 0.8;
      if (arg === 'top') window.scrollTo(0, 0);
      else if (arg === 'bottom') window.scrollTo(0, document.documentElement.scrollHeight);
      else window.scrollBy(0, arg === 'up' ? -by : by);
      return { ok: true };
    }

    case 'text':
      return { text: (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 10000) };

    /** Tab-strip marker so the state is visible even from another tab: ⏳ working, ❓ needs you. */
    case 'mark':
      setMark(String(arg || ''));
      return { ok: true };

    /** Remove every trace of the overlay when the task ends. */
    case 'cleanup':
      document.getElementById(HOST_ID)?.remove();
      setMark('');
      return { ok: true };
  }
  return { error: `Unknown page command: ${cmd}` };
}

/** What `locate` reports about an element; used for clicking and for the safety check. */
export interface Target {
  x: number;
  y: number;
  covered: boolean;
  tag: string;
  type: string;
  name: string;
  desc: string;
  autocomplete: string;
  fieldName: string;
  isSearch: boolean;
  inForm: boolean;
  formHasPassword: boolean;
  editable: boolean;
  readonly: boolean;
  /** <input type=date|time|…>: the value is set directly, never typed. */
  nativePicker: boolean;
}
