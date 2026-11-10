# Pilotfish

An open-source AI browser agent with **one agent per tab**. Open it on a tab, tell it what to do, and it reads the page, fills forms and clicks through tasks there — while a glowing frame and a spotlight show you exactly where it is working. Bring your own key (OpenRouter, OpenAI, Anthropic, or any OpenAI-compatible server such as Ollama).

- **Per tab, not per window.** Each tab has its own panel, chat and agent. Start a task in one tab and carry on in another; the tab title shows ⏳ while it works and ❓ while it waits for your approval.
- **You can see it work.** An orange frame marks the tab, and every field it touches is highlighted with a label.
- **Fast on forms.** A whole form is filled in one step, and after the first look only page *changes* are sent to the model.
- **Chats you can come back to.** Start a new chat with ＋, reopen earlier ones from Chats (◷), and Edit or Retry your last message.
- **Handles real date pickers.** Native date fields, masked inputs and calendar popups are exercised against flatpickr, react-datepicker and MUI X in a test lab (`tests/e2e/dates`). Each widget has at least one working route; not every route works on every widget (see the lab's table).
- **Memory.** Save facts about yourself and documents such as your CV; the agent uses them to fill forms. Attach PDF, Word or text files to any message.
- **No backend, no telemetry.** Requests go straight from your browser to the provider you choose. Keys, memory, chats and files stay in `chrome.storage.local` on your device.
- **Asks before it commits.** Submitting (by button or Enter key), paying, sending, deleting, typing into password or card fields, and leaving for a site you did not mention need your approval. These checks are heuristics, not a guarantee: watch what it does on pages that matter.

Works in Chromium browsers with the side panel API (Chrome 116+, Edge, Brave). Where it is missing, the toolbar button opens the same UI in a small window bound to the tab.

## Get started — pick your path

| I just want to use it | I want to change the code |
|---|---|
| No coding, no tools to install. **3 steps, about 1 minute.** → [Install in 3 steps](#install-in-3-steps-no-coding) | Clone, build, hack on it and send a pull request. → [For developers](#for-developers-build-from-source) |

### Install in 3 steps (no coding)

1. **Download & unzip.** Click [`pilotfish-extension.zip`](pilotfish-extension.zip) → **Download** (or click the green **Code** button → **Download ZIP** and find `pilotfish-extension.zip` inside). Unzip it — you get a folder.
2. **Add to Chrome.** Open `chrome://extensions`, switch on **Developer mode** (top right), click **Load unpacked** and pick the unzipped folder (the one with `manifest.json` in it). Works the same in Edge (`edge://extensions`) and Brave (`brave://extensions`).
3. **Use it.** Click the puzzle-piece icon and pin **Pilotfish**. Open any page, click the icon, go to ⚙ **Settings**, choose a provider and paste your API key. Then just type what you want, e.g. *"Fill in this form from my memory"*.

Tip: add your details or CV under ☰ **Memory** once, and Pilotfish reuses them on every form. It always asks before submitting, paying, sending or deleting.

To update later, download the new zip, replace the folder, and click ↻ on the Pilotfish card in `chrome://extensions`.

## How Pilotfish is different

Most AI browser agents fall into one of four groups. Pilotfish takes a different spot:

| | Cloud agents<br>(remote browser run by the vendor) | AI-first browsers<br>(a whole new browser to install) | Automation libraries<br>(Python/Node frameworks) | **Pilotfish** |
|---|---|---|---|---|
| Runs in | Vendor's VM | Their browser | A script you write | **Your existing Chrome / Edge / Brave** |
| Your logins & cookies | Re-login in their VM | Imported/migrated | Usually a fresh profile | **Already there — it is your browser** |
| Unit of work | One session | One window / assistant | One script | **One agent per tab, several running side by side** |
| Model / billing | Vendor's model, subscription | Mostly vendor's choice | Any | **Any — your own key (OpenRouter, OpenAI, Anthropic, Ollama, any OpenAI-compatible)** |
| Where data goes | Vendor's servers | Vendor's servers (often) | Wherever you send it | **Only to the model provider you pick. No backend, no telemetry** |
| Code | Closed | Mixed | Open | **MIT, ~3.5k lines of TypeScript you can read in an afternoon** |

What that means in practice:

- **Per-tab agents.** Each tab gets its own panel, chat and agent loop. Let one tab fill a job application while another summarizes a report; the tab titles show ⏳ (working) and ❓ (waiting for you).
- **Cheap on tokens.** The page is sent once as a compact numbered outline; after each step the model only gets a *diff* (`~` changed, `+` added, `-` removed). Since earlier messages never change, provider prompt caching kicks in (explicit cache breakpoints for Anthropic).
- **Whole forms in one step.** `fill_form` sets every visible field in a single tool call instead of one click/type round-trip per field.
- **You can watch it.** An orange frame marks the working tab and a spotlight labels every field it touches.
- **Real-world date pickers.** Native date inputs, masked text fields and calendar popups (flatpickr, react-datepicker, MUI X) are covered by a dedicated test lab — a classic failure point for browser agents.
- **Personal memory, locally.** Save "about me" notes and documents (e.g. your CV); the agent uses them to fill forms and reads documents only when needed.
- **Approval gates.** Submitting, paying, sending, deleting, typing into password/card fields and leaving for an unmentioned site all wait for your OK.

## For developers: build from source

Requires Node.js 20+. Fork the repo first if you plan to send a pull request.

```bash
git clone https://github.com/shivang-7135/pilotfish.git
cd pilotfish
npm install
npm run build
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose `.output/chrome-mv3`.
3. Open a page and click the Pilotfish toolbar icon. The panel opens for that tab only.
4. In **Settings** (⚙), pick a provider, paste your API key and choose a model that supports tool calling.
5. In **Memory** (☰), add your details and any documents you want it to use.

After changing code, run `npm run build` again (or use `npm run dev` for live reload) and click ↻ on the extension card. To refresh the prebuilt download for non-developers, run `npm run zip` and copy `.output/pilotfish-<version>-chrome.zip` over `pilotfish-extension.zip`. See [How it works](#how-it-works) for a map of the code and [Develop](#develop) for tests.

## Use

- "Fill in this form from my memory"
- "Summarize this page in 5 bullet points"
- Attach a PDF with 📎 and ask: "Apply for this job using the attached CV"

**Edit** takes your last message back into the box; **Retry** runs it again from scratch. Neither undoes what was already done on the page.

**Stop** ends the task at once. Closing the tab ends it too. Closing only the panel does not: the agent keeps going and the chat is there when you reopen it.

## How it works

```
Side panel (React, one per tab) ──port──▶ Background service worker
  chat, step log, approvals,               one AgentSession per tab: observe → think → act
  attachments, memory, settings            ├─ lib/providers.ts  OpenAI-compatible + Anthropic APIs
                                           ├─ lib/tools.ts      fill_form, click, type, navigate…
                                           ├─ lib/diff.ts       page-state diffs between steps
                                           ├─ lib/safety.ts     which actions need approval
                                           ├─ lib/cdp.ts        trusted input via chrome.debugger
                                           └─ lib/page.ts       injected: page outline, actions, overlay
  lib/extract.ts  PDF / DOCX / text → plain text, in the browser
```

- **Seeing the page.** `lib/page.ts` turns the page into a compact outline where every interactive element has a stable number, e.g. `[12] button "Submit"`.
- **Token use.** The full outline is sent once. After each step the model gets only a diff (`~` changed, `+` added, `-` removed). Because earlier messages never change, provider prompt caching applies; for Anthropic the cache breakpoints are set explicitly.
- **Finding things to click.** Besides real controls and ARIA roles, elements with a pointer cursor are listed too, which is how calendar days and custom dropdown options become reachable.
- **Dates.** Native date/time inputs are set directly in ISO format (other spellings are converted). Text date fields get the format their placeholder shows, typed with real key presses. Every result reports what the field shows afterwards, and read-only fields are refused so the agent uses the calendar instead.
- **Acting.** `fill_form` sets many fields in one call. Clicks and `type` go through the Chrome DevTools Protocol so sites receive trusted events, with a DOM fallback when the debugger is off.
- **Memory.** "About me" notes are part of the instructions on every task. Documents are listed by name only and read on demand with `read_memory`. The agent can offer to save a new fact with `remember`; that always needs your approval.
- **Safety.** Page content, attachments and tool results are wrapped as data (and cannot close their own wrapper), with instructions never to follow commands found in them. After you approve an action the element is located again, so the click lands where you approved it. There is a step limit per task.

## Develop

Pull requests are welcome. CI runs the typecheck, unit tests and build on every push.

```bash
npm run dev        # live-reload build
npm run typecheck
npm test           # unit tests
npm run build && npm run test:e2e   # real Chromium + mock LLM
npm run build && npm run test:dates # date-picker lab: prints a pass/fail table per widget
```

The end-to-end test needs a Chromium that allows `--load-extension` (Chrome for Testing or Chromium; branded Chrome no longer does). Set `CHROME_PATH` to its binary. `HEADED=1` shows the browser.

## Known limits

- Content inside iframes is not readable yet (embedded payment forms, some captchas).
- It cannot operate a website's file picker; you choose the file yourself. No CAPTCHA solving.
- Scanned PDFs (images only) yield no text; there is no OCR.
- The browser's own native date-picker popup cannot be operated (the value is set directly instead).
- Text-only page understanding; no screenshots/vision yet.
- Links that open a new tab are opened in the agent's tab instead.
- "Trusted input" shows Chrome's "started debugging this browser" bar while a task runs.

## Roadmap

- [ ] MCP client (use remote MCP servers as extra tools)
- [ ] MCP server bridge (let Claude Desktop, Cursor or Claude Code drive a tab)
- [ ] Record a task once, replay it as a skill
- [ ] Streaming replies and a cost estimate per task
- [ ] Screenshots for vision models, iframe support

## Security

This extension can read and act on pages you use it on, with your logins, and it sends page content, your memory notes and attachments to the AI provider you configure. Read `lib/safety.ts` and the system prompt in `lib/agent.ts` before trusting it with anything important, and keep "Ask before acting" on. Chats are saved on your device in plain form, including text the agent typed for you and attached files; delete them from the Chats screen when they hold something sensitive. Do not store passwords or card numbers in Memory. Report vulnerabilities privately through GitHub's [private vulnerability reporting](../../security/advisories/new) rather than in a public issue.

## License

MIT. Bundled third-party software is listed in `THIRD_PARTY_NOTICES.md`.
