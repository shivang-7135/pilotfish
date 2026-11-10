import { expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { docxText } from '../../lib/extract';

it('reads paragraphs from a .docx and ignores non-text markup', () => {
  const xml =
    '<w:document><w:body>' +
    '<w:p><w:r><w:t>Ada Lovelace</w:t></w:r></w:p>' +
    '<w:p><w:r><w:drawing><wp:posOffset>12345</wp:posOffset></w:drawing></w:r>' +
    '<w:r><w:t xml:space="preserve">R&amp;D </w:t></w:r><w:r><w:tab/><w:t>Engineer</w:t></w:r></w:p>' +
    '</w:body></w:document>';
  const docx = zipSync({ 'word/document.xml': strToU8(xml), '[Content_Types].xml': strToU8('<Types/>') });
  expect(docxText(docx)).toBe('Ada Lovelace\nR&D \tEngineer\n');
});

it('rejects a zip that is not a Word document', () => {
  expect(() => docxText(zipSync({ 'hello.txt': strToU8('hi') }))).toThrow(/Word document/);
});
