import type { ChatMessage, ModelReply, ProviderId, Settings, ToolCall, ToolDef } from './types';

const OPENAI_BASE: Record<Exclude<ProviderId, 'anthropic'>, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  custom: '',
};
const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  custom: 'Custom (OpenAI-compatible)',
};

function baseUrl(provider: ProviderId, customBaseUrl: string): string {
  if (provider === 'anthropic') return ANTHROPIC_BASE;
  if (provider === 'custom') return customBaseUrl.replace(/\/+$/, '');
  return OPENAI_BASE[provider];
}

function headers(provider: ProviderId, key: string): Record<string, string> {
  if (provider === 'anthropic') {
    return {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      // Required for calls made straight from a browser context.
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (key) h.authorization = `Bearer ${key}`;
  if (provider === 'openrouter') h['X-Title'] = 'Pilotfish';
  return h;
}

/**
 * Page context is sent as one full outline plus the small diffs that follow it.
 * Anything older is dropped. Keeping the full outline in place (instead of
 * resending a new one each step) also keeps the request prefix stable, so
 * provider-side prompt caching can reuse it.
 */
/**
 * Untrusted text (pages, files) is wrapped in tags so the model can tell it from instructions.
 * Replacing "<" means that text can never contain a closing tag and escape its wrapper.
 */
export const defuse = (s: string) => s.replace(/</g, '‹');

function contextFor(messages: ChatMessage[]): (i: number) => string {
  let base = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant' && m.pageState) {
      base = i;
      break;
    }
  }
  return (i) => {
    const m = messages[i];
    if (m.role === 'assistant') return '';
    if (i === base) return `\n\n<page_state>\n${defuse(m.pageState ?? '')}\n</page_state>`;
    if (i > base && m.pageUpdate) return `\n\n<page_update>\n${defuse(m.pageUpdate)}\n</page_update>`;
    return '';
  };
}

export function toOpenAIMessages(system: string, messages: ChatMessage[]): unknown[] {
  const ctx = contextFor(messages);
  const out: unknown[] = [{ role: 'system', content: system }];
  messages.forEach((m, i) => {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content + ctx(i) });
    } else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.text || null,
        ...(m.toolCalls.length && {
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        }),
      });
    } else {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content + ctx(i) });
    }
  });
  return out;
}

type AnthropicBlock = Record<string, unknown>;
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

export function toAnthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const ctx = contextFor(messages);
  const out: AnthropicMessage[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: m.content + ctx(i) }] });
    } else if (m.role === 'assistant') {
      const content: AnthropicBlock[] = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      if (!content.length) content.push({ type: 'text', text: '(no output)' });
      out.push({ role: 'assistant', content });
    } else {
      const block: AnthropicBlock = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content + ctx(i) };
      // All results for one assistant turn must share a single user message.
      const prev = out[out.length - 1];
      if (messages[i - 1]?.role === 'tool' && prev?.role === 'user') prev.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  });
  // Cache everything up to the previous turn: it is identical in the next request.
  for (let i = out.length - 2; i >= 0; i--) {
    if (out[i].role === 'assistant') {
      const blocks = out[i].content;
      blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } };
      break;
    }
  }
  return out;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return { _invalid_json: raw };
  }
}

export function parseOpenAIReply(json: any): ModelReply {
  const msg = json?.choices?.[0]?.message;
  if (!msg) throw new Error('The model returned an empty response.');
  const text =
    typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map((p: any) => p?.text ?? '').join('')
        : '';
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c: any, i: number) => ({
    id: c.id || `call_${Date.now()}_${i}`,
    name: c.function?.name ?? '',
    args: parseArgs(c.function?.arguments),
  }));
  return {
    text: text.trim(),
    toolCalls,
    usage: {
      input: json.usage?.prompt_tokens ?? 0,
      output: json.usage?.completion_tokens ?? 0,
      cached: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
  };
}

export function parseAnthropicReply(json: any): ModelReply {
  const blocks: any[] = json?.content ?? [];
  return {
    text: blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim(),
    toolCalls: blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, args: parseArgs(b.input) })),
    usage: {
      // Anthropic reports cached tokens separately; add them back so "input" means the whole prompt.
      input:
        (json?.usage?.input_tokens ?? 0) +
        (json?.usage?.cache_read_input_tokens ?? 0) +
        (json?.usage?.cache_creation_input_tokens ?? 0),
      output: json?.usage?.output_tokens ?? 0,
      cached: json?.usage?.cache_read_input_tokens ?? 0,
    },
  };
}

async function post(url: string, h: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body), signal });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    throw new Error(`Could not reach ${new URL(url).host}. Check your connection or the base URL.`);
  }
  const raw = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok || json?.error) {
    const detail = json?.error?.message ?? json?.message ?? raw.slice(0, 300);
    const hint =
      res.status === 401 || res.status === 403
        ? ' Check the API key in Settings.'
        : res.status === 404
          ? ' Check the model name in Settings.'
          : res.status === 429
            ? ' Rate limit or no credit left.'
            : '';
    throw new Error(`Provider error ${res.status}: ${detail}${hint}`);
  }
  return json;
}

export async function callModel(
  settings: Settings,
  system: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  signal?: AbortSignal,
): Promise<ModelReply> {
  const { provider } = settings;
  const key = settings.apiKeys[provider];
  const model = settings.models[provider];
  if (!model) throw new Error('No model selected. Open Settings and pick one.');
  if (!key && provider !== 'custom') throw new Error('No API key set. Open Settings and add one.');
  const base = baseUrl(provider, settings.customBaseUrl);

  if (provider === 'anthropic') {
    const json = await post(
      `${base}/messages`,
      headers(provider, key),
      {
        model,
        max_tokens: 4096,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: toAnthropicMessages(messages),
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      },
      signal,
    );
    return parseAnthropicReply(json);
  }

  const json = await post(
    `${base}/chat/completions`,
    headers(provider, key),
    {
      model,
      messages: toOpenAIMessages(system, messages),
      tools: tools.map((t) => ({ type: 'function', function: t })),
      tool_choice: 'auto',
    },
    signal,
  );
  return parseOpenAIReply(json);
}

const NOT_CHAT = /embed|whisper|tts|dall-e|image|audio|moderation|realtime|transcribe|sora|babbage|davinci|rerank/i;

/** Lists model ids the key can use, so nobody has to type model names by hand. */
export async function listModels(provider: ProviderId, key: string, customBaseUrl: string): Promise<string[]> {
  const base = baseUrl(provider, customBaseUrl);
  const url = provider === 'anthropic' ? `${base}/models?limit=1000` : `${base}/models`;
  const res = await fetch(url, { headers: headers(provider, key) });
  if (!res.ok) throw new Error(`Could not load models (${res.status}).`);
  const json = await res.json();
  const items: any[] = json?.data ?? json?.models ?? [];
  return items
    .filter((m) => {
      if (provider === 'openrouter' && Array.isArray(m.supported_parameters)) {
        return m.supported_parameters.includes('tools');
      }
      return !NOT_CHAT.test(String(m.id ?? m.name));
    })
    .map((m) => String(m.id ?? m.name))
    .sort((a, b) => a.localeCompare(b));
}
