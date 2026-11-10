/**
 * Date-input matrix: for every widget in the lab (lab.mjs) the extension's REAL
 * tools are driven through a mock LLM to set 15 January 2027, once per method:
 *
 *   fill ISO   fill_form  "2027-01-15"
 *   fill DMY   fill_form  "15.01.2027"
 *   type ISO   type       "2027-01-15"
 *   type DMY   type       "15.01.2027"
 *   calendar   click to open the popup, move to January 2027 and click day 15,
 *              using only what the page outline exposes
 *
 * Each is run with useDebugger on and off. The value the widget COMMITTED
 * (window.__values.value, set by the library's own callbacks) decides PASS/FAIL.
 *
 *   npx wxt build && node tests/e2e/dates/run.mjs
 *
 * Env: CHROME_PATH (default /usr/bin/google-chrome), HEADED=1, JOBS (parallel tabs, default 4),
 *      ONLY=widget[,widget]  METHODS=fill_iso,calendar  DEBUGGER=on|off  to run a subset.
 * Output: the table on stdout; details in tests/e2e/dates/results/ (results.json, outlines.txt).
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PAGES, buildBundles, serveLab } from './lab.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const extension = path.join(root, '.output/chrome-mv3');
const resultsDir = path.join(here, 'results');
if (!fs.existsSync(path.join(extension, 'manifest.json'))) {
  console.error('No build found. Run: npx wxt build');
  process.exit(2);
}

const started = Date.now();
const METHODS = ['fill_iso', 'fill_dmy', 'type_iso', 'type_dmy', 'calendar'];
const TITLES = { fill_iso: 'fill ISO', fill_dmy: 'fill DMY', type_iso: 'type ISO', type_dmy: 'type DMY', calendar: 'calendar' };
// Extra attempts for MUI: one value per field section, and the calendar when the model picks the
// OLDER of two identically named day cells (the outline lists both months during the slide animation).
const EXTRA = {
  fill_sections: 'fill_form, one value per section (15 / 01 / 2027)',
  type_sections: 'type, one value per section (15 / 01 / 2027)',
  calendar_stale: 'calendar, clicking the first-listed "15" cell when the outline lists several',
};
const TARGET_MONTH = 'January 2027';

// ---------- what the scripted "model" knows about each widget ----------
// `field`: the outline line of the date field. `calendar`: how a model would work the popup,
// expressed as patterns over outline lines; nothing here touches the DOM.
const START = (kind) => new RegExp(`^\\[\\d+\\] ${kind} "Start date"`);
const TEXT = START('input\\[type=text\\]');
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const monthShown = (lines) => lines.map((l) => l.match(new RegExp(`\\b(${MONTHS}) (\\d{4})\\b`))).find(Boolean)?.slice(1).join(' ');

const WIDGETS = {
  'native-date': { field: START('input\\[type=date\\]'), iso: '2027-01-15', dmy: '15.01.2027', expect: '2027-01-15', calendar: { open: [START('input\\[type=date\\]')] } },
  'native-datetime': {
    field: START('input\\[type=datetime-local\\]'),
    iso: '2027-01-15T10:30',
    dmy: '15.01.2027 10:30',
    expect: '2027-01-15T10:30',
    calendar: { open: [START('input\\[type=datetime-local\\]')] },
  },
  'native-time': { field: START('input\\[type=time\\]'), iso: '10:30', dmy: '10:30 AM', expect: '10:30', calendar: { open: [START('input\\[type=time\\]')] } },
  'native-month': { field: START('input\\[type=month\\]'), iso: '2027-01', dmy: '01.2027', expect: '2027-01', calendar: { open: [START('input\\[type=month\\]')] } },
  'text-dmy': { field: TEXT, calendar: null },
  imask: { field: TEXT, calendar: null },
  flatpickr: { field: TEXT, calendar: 'flatpickr' },
  'flatpickr-input': { field: TEXT, calendar: 'flatpickr' },
  'flatpickr-alt': { field: /^\[\d+\] input\[type=text\] "(Start date|Select date)"/, calendar: 'flatpickr' },
  'react-datepicker': {
    field: TEXT,
    calendar: { open: [TEXT], next: /^\[\d+\] \S+ "Next Month"/, day: /^\[\d+\] \S+ "(Choose )?\w+, January 15(th)?, 2027"/ },
  },
  mui: {
    // The outline offers an input named "Start date" (MUI's hidden form input) next to three spinbuttons.
    // The standard columns use that input, as a model reading the outline would; the extra columns use the sections.
    field: TEXT,
    sections: { Day: '15', Month: '01', Year: '2027' },
    calendar: { open: [/^\[\d+\] button "Choose date/], next: /^\[\d+\] button "Next month"/, day: /^\[\d+\] \S+ "15"/ },
  },
  selects: { field: /^\[\d+\] select "Day"/, calendar: null },
};
for (const w of Object.values(WIDGETS)) {
  w.iso ??= '2027-01-15';
  w.dmy ??= '15.01.2027';
  w.expect ??= '2027-01-15';
}

// ---------- attempts ----------
const pick = (env, all) => (process.env[env] ? process.env[env].split(',').filter((x) => all.includes(x)) : all);
const widgetIds = pick('ONLY', Object.keys(WIDGETS));
const methods = pick('METHODS', METHODS);
const extras = pick('METHODS', Object.keys(EXTRA));
const modes = process.env.DEBUGGER ? [process.env.DEBUGGER !== 'off'] : [true, false];
/** id -> attempt record (also what the mock LLM looks up). */
const attempts = new Map();
for (const dbg of modes)
  for (const widget of widgetIds)
    for (const method of [...methods, ...(WIDGETS[widget].sections ? extras : [])]) {
      const id = `${widget}|${method}|${dbg ? 'dbg' : 'dom'}`;
      attempts.set(id, { id, widget, method, dbg, toolResults: [], outlines: [], calls: [], note: '' });
    }

// ---------- mock LLM ----------
/** The outline the model has "in its head": the full state with every later update applied. */
function currentOutline(messages) {
  let lines = [];
  const refOf = (l) => l.match(/^\[(\d+)\]/)?.[1];
  for (const m of messages) {
    for (const [, tag, text] of String(m.content ?? '').matchAll(/<page_(state|update)>\n([\s\S]*?)\n<\/page_(?:state|update)>/g)) {
      if (tag === 'state') {
        lines = text.split('\n');
        continue;
      }
      for (const l of text.split('\n')) {
        if (l === 'No visible change on the page.') continue;
        if (l.startsWith('Removed elements:')) {
          const gone = new Set([...l.matchAll(/\[(\d+)\]/g)].map((x) => x[1]));
          lines = lines.filter((x) => !gone.has(refOf(x)));
        } else if (l.startsWith('~ ')) {
          const i = lines.findIndex((x) => refOf(x) === refOf(l.slice(2)));
          if (i >= 0) lines[i] = l.slice(2);
          else lines.push(l.slice(2));
        } else if (l.startsWith('+ ')) lines.push(l.slice(2));
        else if (l.startsWith('- ')) {
          const i = lines.indexOf(l.slice(2));
          if (i >= 0) lines.splice(i, 1);
        }
      }
    }
  }
  return lines;
}
const lastContext = (messages) => {
  const all = messages.flatMap((m) => [...String(m.content ?? '').matchAll(/<page_(?:state|update)>\n[\s\S]*?\n<\/page_(?:state|update)>/g)].map((x) => x[0]));
  return all.at(-1) ?? '';
};
/** The newest matching line wins: during transitions old and new calendar cells coexist. */
const refIn = (lines, pattern, newest = false) => {
  const line = newest ? lines.findLast((l) => pattern.test(l)) : lines.find((l) => pattern.test(l));
  return line ? Number(line.match(/^\[(\d+)\]/)[1]) : null;
};

let callId = 0;
const call = (name, args) => ({ id: `c${callId++}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const done = (summary) => [call('done', { summary })];

/** Decides the next tool calls for an attempt. `step` = number of model turns so far. */
function policy(a, lines, step) {
  const w = WIDGETS[a.widget];
  const value = a.method.endsWith('_iso') ? w.iso : w.dmy;

  if (a.method.endsWith('_sections')) {
    if (step > 0) return done('ok');
    const parts = Object.entries(w.sections).map(([n, v]) => ({ ref: refIn(lines, new RegExp(`^\\[\\d+\\] spinbutton "${n}"`)), value: v }));
    if (parts.some((x) => x.ref == null)) return done((a.note = 'sections not in outline'));
    return a.method.startsWith('fill') ? [call('fill_form', { fields: parts })] : parts.map((x) => call('type', { ref: x.ref, text: x.value }));
  }

  if (a.widget === 'selects') {
    if (a.method === 'calendar') return done((a.note = 'n/a'));
    if (step > 0) return done('ok');
    const names = a.method.endsWith('_iso');
    // "ISO" columns use the visible option text (15 / January / 2027), "DMY" columns the numbers (15 / 01 / 2027).
    const parts = { Day: '15', Month: names ? 'January' : '01', Year: '2027' };
    const refs = Object.keys(parts).map((n) => refIn(lines, new RegExp(`^\\[\\d+\\] select "${n}"`)));
    if (refs.includes(null)) return done('selects not in outline');
    return a.method.startsWith('fill')
      ? [call('fill_form', { fields: Object.values(parts).map((v, i) => ({ ref: refs[i], value: v })) })]
      : Object.values(parts).map((v, i) => call('select_option', { ref: refs[i], value: v }));
  }

  if (!a.method.startsWith('calendar')) {
    if (step > 0) return done('ok');
    const ref = refIn(lines, w.field);
    if (ref == null) {
      a.note = 'field not in outline';
      return done(a.note);
    }
    return a.method.startsWith('fill') ? [call('fill_form', { fields: [{ ref, value }] })] : [call('type', { ref, text: value })];
  }

  // --- calendar ---
  const stop = (note) => {
    a.note = note;
    return done(note);
  };
  if (!w.calendar) return stop('n/a');
  if (step > 8) return stop('gave up after 8 steps');

  if (w.calendar === 'flatpickr') {
    const field = refIn(lines, w.field);
    if (step === 0) return field == null ? stop('field not in outline') : [call('click', { ref: field })];
    const day = refIn(lines, /^\[\d+\] \S+ "(January 15, 2027|15)"/);
    const month = lines.find((l) => /^\[\d+\] select "Month"/.test(l));
    const year = lines.find((l) => /^\[\d+\] input\[type=number\] "Year"/.test(l));
    if (!month || !year) return stop('popup not in outline after the click');
    const noCells = day == null ? 'day cells are plain text without refs in the outline; ' : '';
    const onTarget = /value="January"/.test(month) && /value="2027"/.test(year);
    if (!onTarget) {
      // flatpickr's arrows are not in the outline, but its month <select> and year box are.
      if (a.navigated) return stop(`${noCells}the year box did not keep 2027 (shows ${year.match(/value="(\d+)"/)?.[1]})`);
      a.navigated = true;
      return [
        call('fill_form', {
          fields: [
            { ref: refIn(lines, /^\[\d+\] input\[type=number\] "Year"/), value: '2027' },
            { ref: refIn(lines, /^\[\d+\] select "Month"/), value: 'January' },
          ],
        }),
      ];
    }
    if (day == null) return stop('January 2027 shown, but day cells are not in the outline');
    if (a.clickedDay) return done('clicked day');
    a.clickedDay = true;
    return [call('click', { ref: day })];
  }

  const c = w.calendar;
  if (step === 0) {
    const ref = c.open.map((p) => refIn(lines, p)).find((r) => r != null);
    return ref == null ? stop('nothing to open the calendar with in the outline') : [call('click', { ref })];
  }
  if (a.clickedDay) return done('clicked day');
  if (!c.day) return stop('click opened nothing readable (native picker UI is not part of the page)');
  const shown = monthShown(lines);
  if (!shown) return stop('popup not in outline after the click');
  if (shown !== TARGET_MONTH) {
    const next = refIn(lines, c.next);
    return next == null ? stop(`calendar shows ${shown}; no "next month" control in the outline`) : [call('click', { ref: next })];
  }
  const cells = lines.filter((l) => c.day.test(l)).length;
  if (cells > 1) a.note = `outline listed ${cells} cells matching day 15 (old month still listed); clicked the ${a.method === 'calendar_stale' ? 'first' : 'newest'}`;
  const day = refIn(lines, c.day, a.method !== 'calendar_stale');
  if (day == null) return stop('January 2027 shown, but day cells are not in the outline');
  a.clickedDay = true;
  return [call('click', { ref: day })];
}

function nextReply(body) {
  const user = body.messages.find((m) => m.role === 'user');
  const id = String(user?.content ?? '').match(/LAB:(\S+)/)?.[1];
  const a = attempts.get(id);
  if (!a) throw new Error(`unknown attempt in request: ${id}`);
  const step = body.messages.filter((m) => m.role === 'assistant').length;
  const lines = currentOutline(body.messages);
  a.toolResults = body.messages.filter((m) => m.role === 'tool').map((m) => String(m.content).split('\n\n<page_')[0]);
  a.outlines.push({ step, received: lastContext(body.messages), outline: lines.join('\n') });
  const tool_calls = policy(a, lines, step);
  a.calls.push(...tool_calls.map((c) => `${c.function.name} ${c.function.arguments}`));
  return { choices: [{ message: { role: 'assistant', content: null, tool_calls } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const json = (o, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(o));
    };
    try {
      if (serveLab(req, res)) return;
      if (req.url === '/v1/models') json({ data: [{ id: 'mock-model' }] });
      else if (req.url === '/v1/chat/completions') json(nextReply(JSON.parse(raw)));
      else res.writeHead(404).end();
    } catch (e) {
      console.error('mock server error:', e.message);
      json({ error: { message: e.message } }, 500);
    }
  });
});

await buildBundles();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---------- browser ----------
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotfish-dates-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: false,
  viewport: { width: 1000, height: 760 },
  locale: 'en-US',
  args: [...(process.env.HEADED ? [] : ['--headless=new']), `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox'],
});

let crashed = false;
try {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15000 }));
  const extensionId = new URL(sw.url()).host;
  const configure = (useDebugger) =>
    sw.evaluate((settings) => chrome.storage.local.set({ settings }), {
      provider: 'custom',
      apiKeys: { custom: 'test-key' },
      models: { custom: 'mock-model' },
      customBaseUrl: `${origin}/v1`,
      confirmMode: 'never',
      maxSteps: 12,
      useDebugger,
    });

  /** What the widget committed, and what its inputs show. */
  const read = (page) =>
    page.evaluate(() => ({
      value: window.__values?.value ?? '',
      shown: [...document.querySelectorAll('#start, #root input, .MuiPickersSectionList-root, input.flatpickr-input, input.form-control')]
        .map((e) => ('value' in e && e.type !== 'hidden' ? e.value : (e.textContent || '').replace(/[⁦-⁩‎‏]/g, '')))
        .filter(Boolean)
        .join(' / '),
    }));

  /** One tab + its panel, reused for all attempts on one widget. */
  async function worker(queue) {
    for (let widget = queue.shift(); widget; widget = queue.shift()) {
      const page = await context.newPage();
      const url = `${origin}/w/${widget}`;
      await page.goto(url);
      const tabs = await sw.evaluate((u) => chrome.tabs.query({ url: u }), url);
      const tabId = Math.max(...tabs.map((t) => t.id));
      const panel = await context.newPage();
      await panel.setViewportSize({ width: 400, height: 760 });
      await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}`);
      await panel.getByText('What should I do in this tab?').waitFor();

      for (const a of [...attempts.values()].filter((x) => x.widget === widget && x.dbg === currentMode)) {
        const t0 = Date.now();
        try {
          await page.goto(url); // fresh widget for every attempt
          if (await panel.locator('.msg').count()) {
            await panel.getByRole('button', { name: 'New chat' }).click();
            await panel.getByText('What should I do in this tab?').waitFor({ timeout: 5000 });
          }
          await panel.getByRole('textbox').fill(`LAB:${a.id} Set the start date to 15 January 2027.`);
          await panel.getByRole('button', { name: 'Send' }).click();
          await panel.locator('.msg.done, .msg.error').first().waitFor({ timeout: 25000 });
          await panel.getByRole('button', { name: 'Send' }).waitFor({ timeout: 5000 });
          a.stepErrors = await panel.locator('.step.error, .msg.error').allInnerTexts();
          const now = await read(page);
          a.value = now.value;
          a.shown = now.shown;
          const want = WIDGETS[widget].expect;
          if (a.value === want) a.status = 'PASS';
          else {
            // Would it commit once focus moves on (as it does when a person tabs away)?
            await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
            await page.waitForTimeout(60);
            const later = await read(page);
            a.afterBlur = later.value;
            a.status = later.value === want ? 'BLUR' : 'FAIL';
          }
          if (a.note === 'n/a') a.status = 'n/a';
        } catch (e) {
          a.status = 'ERROR';
          a.note = (e.message || String(e)).split('\n')[0];
          await panel.getByRole('button', { name: 'Stop' }).click({ timeout: 1000 }).catch(() => {});
          await panel.getByRole('button', { name: 'Send' }).waitFor({ timeout: 5000 }).catch(() => {});
        }
        a.ms = Date.now() - t0;
      }
      await Promise.all([panel.close(), page.close()]);
    }
  }

  let currentMode = true;
  const jobs = Math.max(1, Number(process.env.JOBS) || 4);
  for (currentMode of modes) {
    await configure(currentMode);
    const queue = [...widgetIds];
    await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, () => worker(queue)));
  }
} catch (e) {
  crashed = true;
  console.error('\nDate lab crashed:', e.message);
} finally {
  await context.close().catch(() => {});
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

// ---------- report ----------
const all = [...attempts.values()];
const cell = (a) => {
  if (!a || !a.status) return '-';
  if (a.status === 'n/a') return 'n/a';
  if (a.status === 'PASS') return 'PASS';
  const got = a.status === 'BLUR' ? 'only after blur' : a.status === 'ERROR' ? a.note : a.value ? `"${a.value}"` : a.shown ? `nothing; shows "${a.shown}"` : 'nothing';
  return `${a.status} (${got.length > 34 ? got.slice(0, 33) + '…' : got})`;
};
const table = (dbg) => {
  const rows = [['widget', ...methods.map((m) => TITLES[m])]];
  for (const w of widgetIds) rows.push([w, ...methods.map((m) => cell(attempts.get(`${w}|${m}|${dbg ? 'dbg' : 'dom'}`)))]);
  const width = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(width[i])).join(' | ');
  return [line(rows[0]), width.map((n) => '-'.repeat(n)).join('-|-'), ...rows.slice(1).map(line)].join('\n');
};
const count = (s) => all.filter((a) => a.status === s).length;
let report = `Target: 15 January 2027 (selects: "ISO" = option text 15/January/2027, "DMY" = 15/01/2027; "type" = select_option).\n`;
report += `PASS = widget committed the date. BLUR = committed only once focus left the field. FAIL (x) = x is what it committed.\n`;
for (const dbg of modes) {
  report += `\n=== useDebugger: ${dbg} ===\n${table(dbg)}\n`;
  for (const a of all.filter((x) => x.dbg === dbg && EXTRA[x.method])) report += `  + ${a.widget}: ${EXTRA[a.method]}: ${cell(a)}\n`;
}
const noted = all.filter((a) => a.note && a.note !== 'n/a');
if (noted.length) report += `\nNotes from the scripted model:\n${[...new Set(noted.map((a) => `  ${a.widget} ${a.method}: ${a.note}`))].join('\n')}\n`;
report += `\n${count('PASS')} pass, ${count('BLUR')} only after blur, ${count('FAIL')} fail, ${count('ERROR')} error, ${count('n/a')} n/a — ${((Date.now() - started) / 1000).toFixed(0)}s`;
console.log(report);

fs.mkdirSync(resultsDir, { recursive: true });
fs.writeFileSync(path.join(resultsDir, 'table.txt'), report + '\n');
fs.writeFileSync(
  path.join(resultsDir, 'results.json'),
  JSON.stringify(all.map(({ outlines, navigated, clickedDay, ...a }) => a), null, 2),
);
// What the model was shown at each step of the calendar attempts (and the first outline of every widget).
let dump = '';
for (const a of all) {
  if (!a.method.startsWith('calendar') && !(a.method === methods[0] && a.dbg === modes[0])) continue;
  dump += `\n${'='.repeat(100)}\n${a.id}  ->  ${a.status}${a.note ? ` (${a.note})` : ''}\ncalls: ${a.calls.join('\n       ')}\n`;
  for (const o of a.outlines) dump += `\n--- model turn ${o.step}: context received ---\n${o.received}\n`;
  const last = a.outlines.at(-1);
  if (a.method.startsWith('calendar') && last) dump += `\n--- full outline as the model has it at the last turn ---\n${last.outline}\n`;
}
fs.writeFileSync(path.join(resultsDir, 'outlines.txt'), dump);
console.log(`Details: ${path.relative(root, resultsDir)}/ (table.txt, results.json, outlines.txt)`);
process.exit(crashed || count('ERROR') ? 1 : 0);
