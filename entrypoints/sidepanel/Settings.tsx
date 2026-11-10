import { useEffect, useState } from 'react';
import type { ProviderId, Settings } from '@/lib/types';
import { PROVIDER_LABELS, listModels } from '@/lib/providers';

const KEY_HELP: Record<ProviderId, string> = {
  openrouter: 'Create one at openrouter.ai/keys',
  openai: 'Create one at platform.openai.com/api-keys',
  anthropic: 'Create one at console.anthropic.com',
  custom: 'Optional for local servers such as Ollama',
};

interface Props {
  settings: Settings;
  onChange: (next: Settings) => void;
  onClose: () => void;
}

export function SettingsView({ settings, onChange, onClose }: Props) {
  const p = settings.provider;
  const key = settings.apiKeys[p];
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState('');
  const [showKey, setShowKey] = useState(false);

  // Load the model list once there is something to load it with.
  useEffect(() => {
    setModels([]);
    setStatus('');
    if (!key && (p === 'openai' || p === 'anthropic')) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setStatus('Loading models…');
      try {
        const list = await listModels(p, key, settings.customBaseUrl);
        if (cancelled) return;
        setModels(list);
        setStatus(list.length ? `${list.length} models available` : 'No models found');
      } catch (e: any) {
        if (!cancelled) setStatus(e?.message ?? 'Could not load models');
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [p, key, settings.customBaseUrl]);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...settings, [k]: v });

  return (
    <div className="app settings">
      <header className="bar">
        <button className="icon" onClick={onClose} aria-label="Back to chat">
          ←
        </button>
        <div className="brand">Settings</div>
      </header>
      <main className="form">
        <label>
          Provider
          <select value={p} onChange={(e) => set('provider', e.target.value as ProviderId)}>
            {(Object.keys(PROVIDER_LABELS) as ProviderId[]).map((id) => (
              <option key={id} value={id}>
                {PROVIDER_LABELS[id]}
              </option>
            ))}
          </select>
        </label>

        {p === 'custom' && (
          <label>
            Base URL
            <input
              value={settings.customBaseUrl}
              placeholder="http://localhost:11434/v1"
              onChange={(e) => set('customBaseUrl', e.target.value)}
            />
          </label>
        )}

        <label>
          API key
          <span className="row">
            <input
              type={showKey ? 'text' : 'password'}
              value={key}
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste your key"
              onChange={(e) => set('apiKeys', { ...settings.apiKeys, [p]: e.target.value.trim() })}
            />
            <button type="button" onClick={() => setShowKey(!showKey)}>
              {showKey ? 'Hide' : 'Show'}
            </button>
          </span>
          <small>{KEY_HELP[p]}. Stored only in this browser.</small>
        </label>

        <label>
          Model
          <input
            list="model-list"
            value={settings.models[p]}
            spellCheck={false}
            placeholder={models.length ? 'Pick or type a model id' : 'Model id'}
            onChange={(e) => set('models', { ...settings.models, [p]: e.target.value.trim() })}
          />
          <datalist id="model-list">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <small>
            {status || 'The model must support tool calling.'} Small models (mini, haiku or flash class) are much faster
            and cheaper, and are enough for most form filling.
          </small>
        </label>

        <label>
          Ask before acting
          <select value={settings.confirmMode} onChange={(e) => set('confirmMode', e.target.value as Settings['confirmMode'])}>
            <option value="risky">Only risky actions (submit, pay, send, passwords)</option>
            <option value="always">Every action</option>
            <option value="never">Never (not recommended)</option>
          </select>
        </label>

        <label>
          Step limit per task
          <input
            type="number"
            min={1}
            max={200}
            value={settings.maxSteps}
            onChange={(e) => set('maxSteps', Math.min(200, Math.max(1, Number(e.target.value) || 1)))}
          />
        </label>

        <label className="check">
          <input type="checkbox" checked={settings.useDebugger} onChange={(e) => set('useDebugger', e.target.checked)} />
          <span>
            Use trusted input (debugger)
            <small>
              More reliable clicks and typing. Chrome shows a “started debugging this browser” bar while a task runs.
            </small>
          </span>
        </label>

        <button className="primary" onClick={onClose}>
          Done
        </button>
      </main>
    </div>
  );
}
