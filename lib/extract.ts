import { unzipSync, strFromU8 } from 'fflate';
import { DOC_LIMIT } from './storage';
import type { Attachment } from './types';

export const ACCEPT = '.pdf,.docx,.txt,.md,.csv,.json,.html,.xml,.yaml,.yml,.log,.rtf';

/**
 * Turns a user-chosen file into plain text, entirely in the browser.
 * Nothing is uploaded anywhere; the text only reaches the model when the user sends it.
 */
export async function extractText(file: File): Promise<Attachment> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (file.size > 25 * 1024 * 1024) throw new Error('That file is larger than 25 MB.');
  let text: string;
  if (ext === 'pdf') text = await pdfText(await file.arrayBuffer());
  else if (ext === 'docx') text = docxText(new Uint8Array(await file.arrayBuffer()));
  else if (ext === 'doc') throw new Error('Old .doc files are not supported. Save it as .docx or PDF.');
  else text = await file.text();
  text = tidy(text);
  if (!text) {
    throw new Error(
      ext === 'pdf' ? 'No text found. This PDF is probably a scan (images only).' : 'No text found in that file.',
    );
  }
  const cut = text.length > DOC_LIMIT;
  return { name: file.name, text: cut ? text.slice(0, DOC_LIMIT) + '\n…(truncated)' : text };
}

const tidy = (s: string) =>
  s
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

async function pdfText(data: ArrayBuffer): Promise<string> {
  // Loaded on demand: the PDF engine is large and most sessions never need it.
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    let out = '';
    for (const item of content.items as any[]) {
      if (typeof item.str !== 'string') continue;
      out += item.str + (item.hasEOL ? '\n' : ' ');
    }
    pages.push(out);
  }
  await task.destroy();
  return pages.join('\n\n');
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** A .docx is a zip; the body text is in word/document.xml as <w:p> paragraphs of <w:t> runs. */
export function docxText(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: (f) => f.name === 'word/document.xml' });
  const xml = files['word/document.xml'];
  if (!xml) throw new Error('That does not look like a Word document.');
  // Only <w:t> runs carry body text; other elements (drawings, field codes) hold numbers and markup.
  const token = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br[^>]*\/>|<\/w:tc>/g;
  return strFromU8(xml)
    .split(/<\/w:p>/)
    .map((p) => {
      let out = '';
      for (const m of p.matchAll(token)) {
        out += m[1] !== undefined ? decode(m[1]) : m[0].startsWith('<w:br') ? '\n' : '\t';
      }
      return out;
    })
    .join('\n');
}
