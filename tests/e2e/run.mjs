/**
 * End-to-end test: loads the built extension into a real Chromium, points it at
 * a local mock LLM (OpenAI-compatible), and lets the agent fill in and submit a
 * form on a local test page.
 *
 *   npm run build && npm run test:e2e
 *
 * Env: CHROME_PATH (browser binary), HEADED=1 (watch it run).
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { strToU8, zipSync } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extension = path.join(root, '.output/chrome-mv3');
const shots = path.join(root, 'test-results');
fs.mkdirSync(shots, { recursive: true });

// ---------- test page ----------
// State is updated only by input/change events, the way React-style forms work,
// so a fill that merely sets `.value` would submit empty data.
const FORM = `<!doctype html><meta charset="utf-8"><title>Job application</title>
<style>body{font:16px system-ui;max-width:520px;margin:40px auto}label{display:block;margin:12px 0}
input,select,textarea{display:block;width:100%;padding:6px;font:inherit}input[type=checkbox]{display:inline;width:auto}
.spacer{height:900px}</style>
<nav>${Array.from({ length: 30 }, (_, i) => `<a href="/jobs/${i}">Open role number ${i}</a>`).join(' ')}</nav>
<h1>Job application</h1>
<p>Please fill in all required fields.</p>
<form id="f">
  <label>Full name <input name="name" required></label>
  <label>Email <input name="email" type="email" required></label>
  <label>Country <select name="country"><option value="">Choose…</option><option value="de">Germany</option><option value="in">India</option><option value="fr">France</option></select></label>
  <label>Start date <input name="start" type="date"></label>
  <div class="spacer">The rest of the form is further down.</div>
  <label>Why do you want this job? <textarea name="why"></textarea></label>
  <label><input name="terms" type="checkbox" required> I agree to the terms</label>
  <button type="submit">Send application</button>
</form>
<div id="out"></div>
<script>
  const state = {}, trusted = {};
  const f = document.getElementById('f');
  const track = (e) => {
    state[e.target.name] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    trusted[e.target.name] = e.isTrusted;
  };
  f.addEventListener('input', track);
  f.addEventListener('change', track);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    await fetch('/submitted', { method: 'POST', body: JSON.stringify({ state, trusted, submitTrusted: e.isTrusted }) });
    f.remove();
    document.getElementById('out').textContent = 'Thanks, ' + state.name + '! Your application was received.';
  });
</script>`;

// ---------- mock LLM ----------
const submissions = [];
const llmRequests = [];
let turn = 0;
let callId = 0;

/** Everything the model can currently see: the full state plus the updates after it. */
const visible = (body) =>
  body.messages
    .flatMap((m) => [...String(m.content ?? '').matchAll(/<page_(?:state|update)>\n([\s\S]*?)\n<\/page_(?:state|update)>/g)])
    .map((m) => m[1])
    .join('\n');
const refFor = (state, pattern) => {
  const line = state.split('\n').find((l) => pattern.test(l));
  assert(line, `page state has no line matching ${pattern}:\n${state}`);
  return Number(line.match(/\[(\d+)\]/)[1]);
};
const call = (name, args) => ({ id: `c${callId++}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

function nextReply(body) {
  const state = visible(body);
  assert(state, 'request carries page context');
  const lastTool = [...body.messages].reverse().find((m) => m.role === 'tool');
  const tool_calls = [];
  // Scenario: try to submit with the Enter key instead of the button.
  if (/ENTER-TEST/.test(body.messages[1].content)) {
    if (turn++ === 0) {
      tool_calls.push(
        call('type', { ref: refFor(state, /input\[type=text\] "Full name"/), text: 'Ada Lovelace' }),
        call('press_key', { key: 'Enter' }),
      );
    } else {
      tool_calls.push(call('done', { summary: /declined/.test(lastTool.content) ? 'Enter was declined.' : 'Enter went through.' }));
    }
    return { choices: [{ message: { role: 'assistant', content: null, tool_calls } }], usage: { prompt_tokens: 100, completion_tokens: 10 } };
  }
  switch (turn++) {
    case 0:
      // One batched call fills the form; one real-keystroke call covers the `type` tool.
      tool_calls.push(
        call('fill_form', {
          fields: [
            { ref: refFor(state, /input\[type=text\] "Full name"/), value: 'Ada Lovelace' },
            { ref: refFor(state, /input\[type=email\] "Email"/), value: 'ada@example.com' },
            { ref: refFor(state, /select "Country"/), value: 'Germany' },
            { ref: refFor(state, /input\[type=date\] "Start date"/), value: '2027-01-15' },
            { ref: refFor(state, /input\[type=checkbox\] "I agree to the terms" \(unchecked\)/), value: true },
          ],
        }),
        call('type', { ref: refFor(state, /textarea "Why do you want this job\?"/), text: 'I like building things.' }),
      );
      break;
    case 1: {
      const update = lastTool.content.match(/<page_update>\n([\s\S]*)\n<\/page_update>/)?.[1];
      assert(update, 'the second request carries a page_update, not a second full state');
      assert.match(update, /~ \[\d+\] input\[type=text\] "Full name" value="Ada Lovelace"/, 'update shows the typed name');
      assert.match(update, /"I agree to the terms" \(checked\)/, 'update shows the ticked checkbox');
      assert.match(update, /select "Country" value="Germany"/, 'update shows the chosen country');
      tool_calls.push(call('click', { ref: refFor(state, /button "Send application"/) }));
      break;
    }
    default: {
      const declined = /declined/.test(lastTool?.content ?? '');
      const thanks = state.match(/Thanks, .*received\./)?.[0];
      tool_calls.push(call('done', { summary: declined ? 'Not submitted: you declined.' : `Submitted. ${thanks}` }));
    }
  }
  return {
    choices: [{ message: { role: 'assistant', content: null, tool_calls } }],
    usage: { prompt_tokens: 100, completion_tokens: 10 },
  };
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const json = (o) => {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(o));
    };
    try {
      if (req.url === '/form') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(FORM);
      } else if (req.url === '/submitted') {
        submissions.push(JSON.parse(raw));
        json({ ok: true });
      } else if (req.url === '/v1/models') {
        json({ data: [{ id: 'mock-model' }] });
      } else if (req.url === '/v1/chat/completions') {
        const body = JSON.parse(raw);
        llmRequests.push({ body, auth: req.headers.authorization });
        json(nextReply(body));
      } else {
        res.writeHead(404).end();
      }
    } catch (e) {
      console.error('mock server error:', e.message);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message } }));
    }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---------- browser ----------
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotfish-e2e-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH || undefined,
  headless: false,
  viewport: { width: 1000, height: 760 },
  args: [
    ...(process.env.HEADED ? [] : ['--headless=new']),
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    '--no-sandbox',
  ],
});

let failed = false;
try {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15000 }));
  const extensionId = new URL(sw.url()).host;
  console.log('extension loaded:', extensionId);

  const configure = (over) =>
    sw.evaluate(
      (settings) => chrome.storage.local.set({ settings }),
      {
        provider: 'custom',
        apiKeys: { custom: 'test-key' },
        models: { custom: 'mock-model' },
        customBaseUrl: `${origin}/v1`,
        confirmMode: 'risky',
        maxSteps: 12,
        useDebugger: true,
        ...over,
      },
    );

  const seedMemory = () =>
    sw.evaluate(() =>
      chrome.storage.local.set({
        memory: { about: 'Name: Ada Lovelace\nEmail: ada@example.com', docs: [{ id: '1', name: 'cv.pdf', text: 'CV TEXT' }] },
      }),
    );

  const openForm = async () => {
    const page = await context.newPage();
    await page.goto(`${origin}/form`);
    const tabs = await sw.evaluate((url) => chrome.tabs.query({ url }), `${origin}/form`);
    return { page, tabId: Math.max(...tabs.map((t) => t.id)) };
  };
  const openPanel = async (tabId) => {
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 400, height: 760 });
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}`);
    return panel;
  };

  /** Runs one task through the real side panel UI. */
  async function runTask(name, { useDebugger, allow, attach = [] }) {
    turn = 0;
    await configure({ useDebugger });
    const { page: formPage, tabId } = await openForm();
    const panel = await openPanel(tabId);
    await panel.getByText('What should I do in this tab?').waitFor();
    if (name === 'debugger') await panel.screenshot({ path: path.join(shots, 'panel-empty.png') });

    if (attach.length) {
      await panel.locator('input[type=file]').setInputFiles(attach);
      await panel.locator('.file').nth(attach.length - 1).waitFor({ timeout: 20000 });
      assert.equal(await panel.locator('.file-note').count(), 0, 'attachments were read without errors');
    }
    await panel.getByRole('textbox').fill('Fill in this application for Ada Lovelace and send it.');
    await panel.getByRole('button', { name: 'Send' }).click();

    const dialog = panel.getByRole('alertdialog');
    await dialog.waitFor({ timeout: 30000 });
    assert.match(await dialog.innerText(), /Send application/, 'confirmation names the button');

    // While it waits for approval, the tab itself must show where the agent is.
    const during = await formPage.evaluate(() => ({
      overlay: !!document.getElementById('__pilotfish_overlay'),
      boxes: document.getElementById('__pilotfish_overlay')?.shadowRoot?.getElementById('boxes')?.childElementCount,
      title: document.title,
    }));
    assert.equal(during.overlay, true, 'working frame is shown on the page');
    assert(during.boxes >= 1, 'the element being worked on is highlighted');
    assert.match(during.title, /^❓ /, 'tab title flags that approval is needed');
    await formPage.bringToFront();
    await formPage.screenshot({ path: path.join(shots, `form-working-${name}.png`) });
    await panel.bringToFront();
    await panel.screenshot({ path: path.join(shots, `panel-confirm-${name}.png`) });
    // The page moves while the user decides: the approved click must still hit the approved button.
    await formPage.evaluate(() => window.scrollBy(0, -250));
    await dialog.getByRole('button', { name: allow ? 'Allow' : 'Deny' }).click();

    await panel.locator('.msg.done').waitFor({ timeout: 30000 });
    await panel.getByRole('button', { name: 'Send' }).waitFor();
    await panel.screenshot({ path: path.join(shots, `panel-done-${name}.png`) });
    const summary = await panel.locator('.msg.done').innerText();
    const steps = await panel.locator('.step').allInnerTexts();
    const errors = await panel.locator('.step.error, .msg.error').allInnerTexts();
    const after = await formPage.evaluate(() => ({
      overlay: !!document.getElementById('__pilotfish_overlay'),
      title: document.title,
    }));
    assert.deepEqual(after, { overlay: false, title: 'Job application' }, 'overlay and title marker are removed');
    return { summary, steps, errors, panel, formPage, tabId };
  }
  const close = (r) => Promise.all([r.panel.close(), r.formPage.close()]);

  const expected = {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    country: 'de',
    start: '2027-01-15',
    why: 'I like building things.',
    terms: true,
  };

  // Files to attach: a real PDF and a real .docx.
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText('Reference code: ZX-4417', { x: 50, y: 700, size: 18, font: await pdf.embedFont(StandardFonts.Helvetica) });
  const pdfPath = path.join(profile, 'reference.pdf');
  fs.writeFileSync(pdfPath, await pdf.save());
  const docxPath = path.join(profile, 'letter.docx');
  fs.writeFileSync(
    docxPath,
    zipSync({ 'word/document.xml': strToU8('<w:document><w:body><w:p><w:r><w:t>Cover letter QK-9020</w:t></w:r></w:p></w:body></w:document>') }),
  );
  await seedMemory();

  // 1. Trusted input, attachments, memory, per-tab replay.
  let r = await runTask('debugger', { useDebugger: true, allow: true, attach: [pdfPath, docxPath] });
  assert.deepEqual(r.errors, [], 'no failed steps');
  assert.equal(submissions.length, 1, 'form submitted once');
  assert.deepEqual(submissions[0].state, expected);
  assert.equal(submissions[0].trusted.why, true, 'the type tool produced trusted keystrokes');
  assert.equal(submissions[0].submitTrusted, true, 'the click was a trusted event');
  assert.match(r.summary, /Thanks, Ada Lovelace!/);
  assert.equal(r.steps.length, 3, 'the whole form took three steps');
  assert.equal(llmRequests.length, 3, 'and three model calls');
  console.log('✓ fills the form in one batched step and submits it (trusted input)');

  const first = llmRequests[0].body;
  const userMsg = first.messages[1].content;
  assert.match(userMsg, /<attached_file name="reference.pdf">\nReference code: ZX-4417/, 'PDF text was extracted');
  assert.match(userMsg, /<attached_file name="letter.docx">\nCover letter QK-9020/, 'DOCX text was extracted');
  console.log('✓ attached PDF and Word files are read in the browser and sent as text');

  assert.match(first.messages[0].content, /Name: Ada Lovelace\nEmail: ada@example.com/, 'memory notes are in the prompt');
  assert.match(first.messages[0].content, /Saved documents[^\n]*cv\.pdf/, 'saved documents are listed by name');
  assert.doesNotMatch(first.messages[0].content, /CV TEXT/, 'document bodies are not sent unless read');
  console.log('✓ memory: notes go in the prompt, documents only by name');

  // Each tab has its own agent: reopening this tab's panel brings its chat back, another tab starts empty.
  await r.panel.reload();
  await r.panel.locator('.msg.done').waitFor({ timeout: 10000 });
  assert.equal(await r.panel.locator('.step').count(), 3, 'chat is replayed after the panel reopens');
  const other = await openForm();
  const otherPanel = await openPanel(other.tabId);
  await otherPanel.getByText('What should I do in this tab?').waitFor();
  assert.equal(await otherPanel.locator('.msg').count(), 0, 'a different tab has its own empty chat');
  await Promise.all([otherPanel.close(), other.page.close()]);
  console.log('✓ chats are per tab and survive closing the panel');

  // "+" starts a clean chat; the old one is in Chats and can be reopened.
  await r.panel.getByRole('button', { name: 'New chat' }).click();
  await r.panel.getByText('What should I do in this tab?').waitFor({ timeout: 5000 });
  assert.equal(await r.panel.locator('.msg').count(), 0, 'new chat is empty');
  await r.panel.getByRole('button', { name: 'Chats', exact: true }).click();
  await r.panel.getByRole('button', { name: /^Fill in this application/ }).click();
  await r.panel.locator('.msg.done').waitFor({ timeout: 5000 });
  assert.equal(await r.panel.locator('.step').count(), 3, 'the earlier chat is restored from history');
  console.log('✓ new chat works and earlier chats reopen from history');

  // Edit: the last message returns to the composer with its attachments.
  await r.panel.getByRole('button', { name: 'Edit' }).click();
  await r.panel.getByText('What should I do in this tab?').waitFor({ timeout: 5000 });
  assert.equal(await r.panel.getByRole('textbox').inputValue(), 'Fill in this application for Ada Lovelace and send it.');
  assert.equal(await r.panel.locator('.file').count(), 2, 'attachments come back with the message');
  console.log('✓ the last message can be taken back and edited');
  await close(r);

  // Token use: one full page state, then small updates.
  const last = llmRequests.at(-1).body.messages.slice(1);
  const sent = JSON.stringify(last);
  assert.equal(sent.split('<page_state>').length - 1, 1, 'exactly one full page state is sent');
  assert(sent.includes('<page_update>'), 'later steps are sent as updates');
  const full = last[0].content.match(/<page_state>[\s\S]*<\/page_state>/)[0].length;
  const upd = [...sent.matchAll(/<page_update>(.*?)<\/page_update>/g)].map((m) => m[1].length);
  console.log(`✓ page context: full state ${full} chars once, then updates of ${upd.join(' and ')} chars`);

  // 2. Plain DOM events, debugger off.
  r = await runTask('dom', { useDebugger: false, allow: true });
  assert.deepEqual(r.errors, [], 'no failed steps');
  assert.equal(submissions.length, 2, 'form submitted again');
  assert.deepEqual(submissions[1].state, expected);
  assert.equal(submissions[1].trusted.why, false, 'DOM fallback was used');
  await close(r);
  console.log('✓ same result with the debugger switched off');

  // 3. Denying the confirmation must block the submit.
  r = await runTask('deny', { useDebugger: true, allow: false });
  assert.equal(submissions.length, 2, 'nothing submitted after Deny');
  assert.match(r.summary, /declined/);
  assert(r.steps.some((s) => /declined/.test(s)), 'declined step is shown');
  console.log('✓ Deny blocks the submit and the model is told');

  // Retry: the same message runs again from scratch; this time it is allowed.
  turn = 0;
  await r.formPage.reload(); // actions on the page are not undone by Retry, so start from a clean form
  const before = llmRequests.length;
  await r.panel.getByRole('button', { name: 'Retry' }).click();
  await r.panel.getByRole('alertdialog').getByRole('button', { name: 'Allow' }).click({ timeout: 30000 });
  await r.panel.locator('.msg.done').waitFor({ timeout: 30000 });
  assert.equal(await r.panel.locator('.msg.user').count(), 1, 'retry replaces the turn instead of adding one');
  assert.equal(llmRequests[before].body.messages.filter((m) => m.role === 'user').length, 1, 'the model sees one user message');
  assert.equal(submissions.length, 3, 'the retried task submitted the form');
  assert.deepEqual(submissions[2].state, expected);
  await close(r);
  console.log('✓ Retry reruns the last message with a clean history');

  // 4. Pressing Enter in a form field is a submit too, and must ask first.
  turn = 0;
  {
    const { page: formPage, tabId } = await openForm();
    const panel = await openPanel(tabId);
    await panel.getByText('What should I do in this tab?').waitFor();
    await panel.getByRole('textbox').fill('ENTER-TEST: type my name and press Enter');
    await panel.getByRole('button', { name: 'Send' }).click();
    const dialog = panel.getByRole('alertdialog');
    await dialog.waitFor({ timeout: 30000 });
    assert.match(await dialog.innerText(), /submit the form/, 'Enter in a form field asks for approval');
    await dialog.getByRole('button', { name: 'Deny' }).click();
    await panel.locator('.msg.done').waitFor({ timeout: 30000 });
    assert.match(await panel.locator('.msg.done').innerText(), /declined/);
    assert.equal(submissions.length, 3, 'nothing was submitted by the Enter key');
    await Promise.all([panel.close(), formPage.close()]);
  }
  console.log('✓ Enter in a form field needs approval, like the submit button');

  assert.equal(llmRequests[0].auth, 'Bearer test-key');
  assert.equal(first.model, 'mock-model');
  assert(first.tools.some((t) => t.function.name === 'fill_form'));
  console.log(`\nAll end-to-end checks passed. Screenshots: ${path.relative(root, shots)}/`);
} catch (e) {
  failed = true;
  console.error('\n✗ E2E failed:', e.message);
  for (const p of context.pages()) {
    await p.screenshot({ path: path.join(shots, `failure-${context.pages().indexOf(p)}.png`) }).catch(() => {});
  }
} finally {
  await context.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
