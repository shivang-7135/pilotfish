/**
 * Date-input lab: one page per widget, each built with the REAL library
 * (served from node_modules, no CDN). Every widget commits its value the way
 * its library reports it (change events / library callbacks / React onChange)
 * into window.__values.value, normalised to ISO so results are comparable.
 *
 *   node tests/e2e/dates/lab.mjs        # serve the lab for manual browsing
 *
 * The page clock is frozen at 10 Nov 2026 so calendars always open on the
 * same month, whenever the suite is run.
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const nm = (p) => path.join(root, 'node_modules', p);
const out = path.join(here, '.build');

const HEAD = (id) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Date lab: ${id}</title>
<style>body{font:16px system-ui;max-width:560px;margin:40px auto;min-height:700px}label{display:block;margin:12px 0}
input,select{padding:6px;font:inherit}.err{color:#b00}</style>
<script>
(() => {
  // Frozen clock: 10 Nov 2026, 09:00 local time.
  const Real = Date, FIXED = new Real(2026, 10, 10, 9, 0, 0).getTime();
  class Fixed extends Real {
    constructor(...a) { if (a.length) super(...a); else super(FIXED); }
    static now() { return FIXED; }
  }
  window.Date = Fixed;
  window.__values = {};
  window.__log = [];
  window.__commit = (name, value) => { window.__values[name] = value; window.__log.push(name + '=' + value); };
})();
</script>`;
const page = (id, head, body) =>
  `${HEAD(id)}${head}</head><body><h1>Booking</h1><p>Choose your start date.</p>
<label>Guest name <input name="guest" id="guest"></label>
${body}
</body></html>`;

const nativeInput = (type) => `<label>Start date <input id="start" name="start" type="${type}"></label>
<script>
  // Framework-style: state only follows input/change events.
  for (const ev of ['input', 'change']) document.getElementById('start').addEventListener(ev, (e) => __commit('value', e.target.value));
</script>`;

/** id -> { title, html } */
export const PAGES = {
  'native-date': { title: 'native <input type=date>', html: () => page('native-date', '', nativeInput('date')) },
  'native-datetime': { title: 'native datetime-local', html: () => page('native-datetime', '', nativeInput('datetime-local')) },
  'native-time': { title: 'native <input type=time>', html: () => page('native-time', '', nativeInput('time')) },
  'native-month': { title: 'native <input type=month>', html: () => page('native-month', '', nativeInput('month')) },

  'text-dmy': {
    title: 'text input DD.MM.YYYY (validated on change)',
    html: () =>
      page(
        'text-dmy',
        '',
        `<label>Start date <input id="start" name="start" type="text" placeholder="DD.MM.YYYY" autocomplete="off"></label>
<div id="err" class="err"></div>
<script>
  const el = document.getElementById('start'), err = document.getElementById('err');
  el.addEventListener('change', () => {
    const m = el.value.trim().match(/^(\\d{2})\\.(\\d{2})\\.(\\d{4})$/);
    const d = m && new Date(+m[3], +m[2] - 1, +m[1]);
    const ok = !!m && d.getMonth() === +m[2] - 1 && d.getDate() === +m[1];
    el.setAttribute('aria-invalid', String(!ok));
    err.textContent = ok ? '' : 'Please enter the date as DD.MM.YYYY';
    __commit('value', ok ? m[3] + '-' + m[2] + '-' + m[1] : 'invalid:' + el.value);
  });
</script>`,
      ),
  },

  imask: {
    title: 'imask masked input (DD.MM.YYYY)',
    html: () =>
      page(
        'imask',
        '<script src="/vendor/imask.js"></script>',
        `<label>Start date <input id="start" name="start" type="text" placeholder="DD.MM.YYYY" autocomplete="off"></label>
<script>
  // Date mask, default pattern d.m.Y. The app only learns the date through the mask's own events.
  const mask = IMask(document.getElementById('start'), { mask: Date, lazy: true, min: new Date(2000, 0, 1), max: new Date(2100, 0, 1) });
  const iso = (d) => d ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : '';
  mask.on('accept', () => __commit('raw', mask.value));
  mask.on('complete', () => __commit('value', iso(mask.typedValue)));
  window.__mask = mask;
</script>`,
      ),
  },

  flatpickr: {
    title: 'flatpickr (default config)',
    html: () =>
      page(
        'flatpickr',
        '<link rel="stylesheet" href="/vendor/flatpickr.css"><script src="/vendor/flatpickr.js"></script>',
        `<label>Start date <input id="start" name="start" type="text" placeholder="Select date"></label>
<script>
  window.__fp = flatpickr('#start', { onChange: (dates, str) => __commit('value', str) });
</script>`,
      ),
  },
  'flatpickr-input': {
    title: 'flatpickr allowInput, d.m.Y',
    html: () =>
      page(
        'flatpickr-input',
        '<link rel="stylesheet" href="/vendor/flatpickr.css"><script src="/vendor/flatpickr.js"></script>',
        `<label>Start date <input id="start" name="start" type="text" placeholder="DD.MM.YYYY"></label>
<script>
  window.__fp = flatpickr('#start', { allowInput: true, dateFormat: 'd.m.Y', onChange: (dates) => __commit('value', dates[0] ? __fp.formatDate(dates[0], 'Y-m-d') : '') });
</script>`,
      ),
  },
  'flatpickr-alt': {
    title: 'flatpickr altInput (readonly)',
    html: () =>
      page(
        'flatpickr-alt',
        '<link rel="stylesheet" href="/vendor/flatpickr.css"><script src="/vendor/flatpickr.js"></script>',
        `<label for="start">Start date</label> <input id="start" name="start" type="text" placeholder="Select date">
<script>
  // The real input becomes type=hidden; a readonly display input ("January 15, 2027") replaces it.
  window.__fp = flatpickr('#start', { altInput: true, altFormat: 'F j, Y', dateFormat: 'Y-m-d', onChange: (dates, str) => __commit('value', str) });
</script>`,
      ),
  },

  'react-datepicker': {
    title: 'react-datepicker (dd.MM.yyyy)',
    html: () => page('react-datepicker', '<link rel="stylesheet" href="/build/rdp.css">', '<div id="root"></div><script src="/build/rdp.js"></script>'),
  },
  mui: {
    title: 'MUI X DatePicker (sectioned field)',
    html: () => page('mui', '', '<div id="root"></div><script src="/build/mui.js"></script>'),
  },

  selects: {
    title: 'three <select>s day/month/year',
    html: () => {
      const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      const opts = (list) => list.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
      return page(
        'selects',
        '',
        `<fieldset><legend>Start date</legend>
<label>Day <select id="day" name="day">${opts([['', 'Day'], ...Array.from({ length: 31 }, (_, i) => [i + 1, i + 1])])}</select></label>
<label>Month <select id="month" name="month">${opts([['', 'Month'], ...months.map((m, i) => [i + 1, m])])}</select></label>
<label>Year <select id="year" name="year">${opts([['', 'Year'], ...Array.from({ length: 8 }, (_, i) => [2024 + i, 2024 + i])])}</select></label>
</fieldset>
<script>
  const sel = ['day', 'month', 'year'].map((id) => document.getElementById(id));
  const pad = (v) => String(v).padStart(2, '0');
  for (const s of sel) s.addEventListener('change', () => {
    const [d, m, y] = sel.map((x) => x.value);
    __commit('value', d && m && y ? y + '-' + pad(m) + '-' + pad(d) : 'partial:' + [d, m, y].join('/'));
  });
</script>`,
      );
    },
  },
};

const VENDOR = {
  '/vendor/imask.js': ['imask/dist/imask.min.js', 'text/javascript'],
  '/vendor/flatpickr.js': ['flatpickr/dist/flatpickr.min.js', 'text/javascript'],
  '/vendor/flatpickr.css': ['flatpickr/dist/flatpickr.min.css', 'text/css'],
};

/** Bundles the two React pages with esbuild (about a second). */
export async function buildBundles() {
  await build({
    entryPoints: { rdp: path.join(here, 'react/rdp.jsx'), mui: path.join(here, 'react/mui.jsx') },
    outdir: out,
    bundle: true,
    format: 'iife',
    minify: true,
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    nodePaths: [path.join(root, 'node_modules')],
    logLevel: 'error',
  });
}

/**
 * Lab pages as an http handler. Returns true when it answered the request.
 * Usage: if (serveLab(req, res)) return;
 */
export function serveLab(req, res) {
  const url = req.url.split('?')[0];
  const send = (type, body) => {
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  if (url === '/' || url === '/lab') {
    send('text/html', `<!doctype html><title>Date lab</title><h1>Date lab</h1><ul>${Object.entries(PAGES).map(([id, p]) => `<li><a href="/w/${id}">${p.title.replace(/</g, '&lt;')}</a></li>`).join('')}</ul>`);
    return true;
  }
  if (url.startsWith('/w/') && PAGES[url.slice(3)]) {
    send('text/html', PAGES[url.slice(3)].html());
    return true;
  }
  if (VENDOR[url]) {
    send(VENDOR[url][1], fs.readFileSync(nm(VENDOR[url][0])));
    return true;
  }
  if (url.startsWith('/build/')) {
    const f = path.join(out, path.basename(url));
    if (fs.existsSync(f)) {
      send(f.endsWith('.css') ? 'text/css' : 'text/javascript', fs.readFileSync(f));
      return true;
    }
  }
  return false;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildBundles();
  const server = http.createServer((req, res) => serveLab(req, res) || res.writeHead(404).end());
  server.listen(Number(process.env.PORT) || 4173, '127.0.0.1', () => console.log(`Date lab: http://127.0.0.1:${server.address().port}/`));
}
