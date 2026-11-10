import { useEffect, useRef, useState } from 'react';
import type { Memory } from '@/lib/types';
import { ABOUT_LIMIT, EMPTY_MEMORY, loadMemory, saveMemory } from '@/lib/storage';
import { ACCEPT, extractText } from '@/lib/extract';

const PLACEHOLDER = `Name: Ada Lovelace
Email: ada@example.com
Phone: +49 151 0000000
Address: Musterstraße 1, 56068 Koblenz, Germany
Date of birth: 1990-12-10
Job title: Software engineer`;

export function MemoryView({ onClose }: { onClose: () => void }) {
  const [memory, setMemory] = useState<Memory>(EMPTY_MEMORY);
  const [note, setNote] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadMemory().then(setMemory);
  }, []);

  const update = (next: Memory) => {
    setMemory(next);
    void saveMemory(next);
  };

  const addDocs = async (list: FileList | null) => {
    if (!list?.length) return;
    setNote('Reading…');
    const docs = [...memory.docs];
    const problems: string[] = [];
    for (const f of Array.from(list)) {
      try {
        const { name, text } = await extractText(f);
        const at = docs.findIndex((d) => d.name === name);
        const doc = { id: crypto.randomUUID(), name, text };
        if (at >= 0) docs[at] = doc;
        else docs.push(doc);
      } catch (e: any) {
        problems.push(`${f.name}: ${e?.message ?? 'could not be read'}`);
      }
    }
    update({ ...memory, docs });
    setNote(problems.join(' '));
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="app settings">
      <header className="bar">
        <button className="icon" onClick={onClose} aria-label="Back to chat">
          ←
        </button>
        <div className="brand">Memory</div>
      </header>
      <main className="form">
        <p className="hint">
          What Pilotfish may use to fill forms for you. Stored only in this browser. It is sent to your AI provider
          when you run a task.
        </p>
        <label>
          About me
          <textarea
            rows={9}
            value={memory.about}
            maxLength={ABOUT_LIMIT}
            placeholder={PLACEHOLDER}
            spellCheck={false}
            onChange={(e) => update({ ...memory, about: e.target.value })}
          />
          <small>
            {memory.about.length.toLocaleString()} / {ABOUT_LIMIT.toLocaleString()} characters · sent with every task,
            so keep it to facts. Do not store passwords or card numbers here.
          </small>
        </label>

        <div className="group">
          <strong>Documents</strong>
          <small>
            For longer material such as a CV. Only the file names are sent; the agent opens one when a task needs it.
          </small>
          {memory.docs.map((d) => (
            <div key={d.id} className="doc">
              <span>
                📄 {d.name} <small>{d.text.length.toLocaleString()} chars</small>
              </span>
              <button onClick={() => update({ ...memory, docs: memory.docs.filter((x) => x.id !== d.id) })}>Remove</button>
            </div>
          ))}
          <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden onChange={(e) => addDocs(e.target.files)} />
          <button onClick={() => fileRef.current?.click()}>Add document (PDF, Word, text)</button>
          {note && <small className="file-note">{note}</small>}
        </div>

        <button className="primary" onClick={onClose}>
          Done
        </button>
      </main>
    </div>
  );
}
