import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { decryptSecret } from '../../services/secrets';
import { AiSettings } from './ai-settings.model';
import { AI_CATALOG, isProviderId, type AiProviderId } from './catalog';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  model: string;
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: 'timeout' | 'http' | 'rate_limited' | 'auth' | 'invalid_response' | 'network',
    public readonly httpStatus?: number,
    /** Provider's own error message (truncated). Shown only to platform administrators. */
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export interface AiProvider {
  /** Provider id, e.g. "groq". Recorded with every usage row. */
  readonly name: string;
  readonly model: string;
  /** Where the active configuration came from. */
  readonly source?: 'database' | 'env' | 'test';
  isConfigured(): boolean;
  chat(req: ChatRequest): Promise<ChatResponse>;
  listModels?(): Promise<string[]>;
  /** Estimated USD cost for token usage, from configured per-million-token prices. */
  estimateCostUsd(usage: { promptTokens: number; completionTokens: number }): number;
  readonly hasPrices?: boolean;
}

export interface ProviderOptions {
  id: AiProviderId;
  baseUrl: string;
  apiKey: string | undefined | null;
  model: string;
  timeoutMs: number;
  inputCostPerMTokUsd?: number;
  outputCostPerMTokUsd?: number;
  source: 'database' | 'env';
}

async function readError(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      const m = j?.error?.message ?? j?.message ?? j?.error ?? j?.[0]?.error?.message;
      return typeof m === 'string' ? m.slice(0, 300) : text.slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return undefined;
  }
}

/**
 * Client for any OpenAI-compatible Chat Completions API (Groq, OpenAI, DeepSeek, xAI,
 * Gemini, OpenRouter, custom). Only base URL, key and model differ between providers.
 */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly name: string;
  readonly model: string;
  readonly source: 'database' | 'env';
  private readonly baseUrl: string;
  private tokenParam: 'max_tokens' | 'max_completion_tokens';
  private sendTemperature = true;

  constructor(private readonly opts: ProviderOptions) {
    this.name = opts.id;
    this.model = opts.model;
    this.source = opts.source;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.tokenParam = AI_CATALOG[opts.id].maxTokensParam;
  }

  get hasPrices() {
    return Boolean(this.opts.inputCostPerMTokUsd || this.opts.outputCostPerMTokUsd);
  }

  isConfigured() {
    return Boolean(this.opts.apiKey && this.baseUrl && this.model);
  }

  estimateCostUsd(usage: { promptTokens: number; completionTokens: number }) {
    return (
      (usage.promptTokens * (this.opts.inputCostPerMTokUsd ?? 0) +
        usage.completionTokens * (this.opts.outputCostPerMTokUsd ?? 0)) /
      1_000_000
    );
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.opts.apiKey}`,
      'Content-Type': 'application/json',
      // OpenRouter uses these for attribution; other providers ignore them.
      'HTTP-Referer': 'https://school-os.local',
      'X-Title': env.APP_NAME,
    };
  }

  private async fetchJson(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(this.opts.timeoutMs) });
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new AiProviderError(
        isTimeout ? 'AI provider timed out' : 'AI provider unreachable',
        isTimeout ? 'timeout' : 'network',
        undefined,
        err instanceof Error ? err.message.slice(0, 200) : undefined,
      );
    }
  }

  private httpError(status: number, detail?: string) {
    const kind = status === 429 ? 'rate_limited' : status === 401 || status === 403 ? 'auth' : 'http';
    return new AiProviderError(`AI provider returned HTTP ${status}`, kind, status, detail);
  }

  async chat(req: ChatRequest, attempt = 0): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: req.messages,
      ...(req.tools?.length ? { tools: req.tools, tool_choice: 'auto' } : {}),
      [this.tokenParam]: req.maxTokens ?? 1200,
      ...(this.sendTemperature ? { temperature: req.temperature ?? 0.3 } : {}),
    };
    const res = await this.fetchJson('/chat/completions', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await readError(res);
      // Some models reject temperature or one of the token-limit fields; adapt once and retry.
      if (res.status === 400 && attempt === 0 && detail) {
        if (/temperature/i.test(detail) && this.sendTemperature) {
          this.sendTemperature = false;
          return this.chat(req, 1);
        }
        if (/max_tokens|max_completion_tokens/i.test(detail)) {
          this.tokenParam = this.tokenParam === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
          return this.chat(req, 1);
        }
      }
      throw this.httpError(res.status, detail);
    }
    let json: any;
    try {
      json = await res.json();
    } catch {
      throw new AiProviderError('AI provider returned invalid JSON', 'invalid_response');
    }
    const message = json?.choices?.[0]?.message;
    if (!message) throw new AiProviderError('AI provider returned no message', 'invalid_response');
    return {
      content: typeof message.content === 'string' ? message.content : null,
      toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
      usage: json.usage
        ? {
            promptTokens: json.usage.prompt_tokens ?? 0,
            completionTokens: json.usage.completion_tokens ?? 0,
            totalTokens:
              json.usage.total_tokens ?? (json.usage.prompt_tokens ?? 0) + (json.usage.completion_tokens ?? 0),
          }
        : null,
      model: json.model ?? this.model,
    };
  }

  /** Live model ids from the provider's `GET /models`. */
  async listModels(): Promise<string[]> {
    const res = await this.fetchJson('/models', { method: 'GET', headers: this.headers() });
    if (!res.ok) throw this.httpError(res.status, await readError(res));
    const json: any = await res.json().catch(() => ({}));
    const list: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
    return list
      .map((m) => String(m?.id ?? m?.name ?? '').replace(/^models\//, ''))
      .filter(Boolean)
      .sort();
  }
}

/** Placeholder when AI is turned off or nothing is configured. */
function disabledProvider(name = 'none', model = 'none'): AiProvider {
  return {
    name,
    model,
    isConfigured: () => false,
    chat: async () => {
      throw new AiProviderError('AI is not configured', 'network');
    },
    estimateCostUsd: () => 0,
  };
}

export function buildProvider(opts: ProviderOptions): AiProvider {
  return new OpenAiCompatibleProvider(opts);
}

/** Provider from environment variables (fallback when nothing is saved in the admin panel). */
export function providerFromEnv(): AiProvider {
  if (env.AI_PROVIDER === 'none') return disabledProvider();
  const id = env.AI_PROVIDER;
  const baseUrl = env.AI_BASE_URL ?? (id === 'xai' ? env.XAI_BASE_URL : undefined) ?? AI_CATALOG[id].baseUrl;
  return buildProvider({
    id,
    baseUrl,
    apiKey: env.AI_API_KEY ?? env.XAI_API_KEY,
    model: env.AI_MODEL,
    timeoutMs: env.AI_TIMEOUT_MS,
    inputCostPerMTokUsd: env.AI_INPUT_COST_PER_MTOK_USD,
    outputCostPerMTokUsd: env.AI_OUTPUT_COST_PER_MTOK_USD,
    source: 'env',
  });
}

export interface StoredProviderConfig {
  apiKeyEncrypted?: string | null;
  model?: string | null;
  baseUrl?: string | null;
  inputCostPerMTokUsd?: number | null;
  outputCostPerMTokUsd?: number | null;
}

export function providerFromStored(id: AiProviderId, cfg: StoredProviderConfig, timeoutMs: number): AiProvider {
  return buildProvider({
    id,
    baseUrl: cfg.baseUrl || AI_CATALOG[id].baseUrl,
    apiKey: decryptSecret(cfg.apiKeyEncrypted),
    model: cfg.model ?? '',
    timeoutMs,
    inputCostPerMTokUsd: cfg.inputCostPerMTokUsd ?? 0,
    outputCostPerMTokUsd: cfg.outputCostPerMTokUsd ?? 0,
    source: 'database',
  });
}

/**
 * The active provider: the one selected in the platform admin panel if it has a usable
 * key and model, otherwise the .env configuration. Cached briefly; changes made through
 * the admin API invalidate the cache immediately on this instance (other instances pick
 * them up within CACHE_MS).
 */
const CACHE_MS = 30_000;
let cache: { provider: AiProvider; at: number } | undefined;
let testOverride: AiProvider | null = null;

export async function getAiProvider(): Promise<AiProvider> {
  if (testOverride) return testOverride;
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.provider;
  let provider: AiProvider = providerFromEnv();
  try {
    const settings = await AiSettings.findOne({ key: 'global' }).lean();
    if (settings) {
      if (settings.enabled === false) {
        provider = disabledProvider(settings.activeProvider ?? 'none');
      } else if (settings.activeProvider && isProviderId(settings.activeProvider)) {
        const cfg = (settings.providers as unknown as Record<string, StoredProviderConfig> | undefined)?.[
          settings.activeProvider
        ];
        if (cfg) {
          const stored = providerFromStored(settings.activeProvider, cfg, settings.timeoutMs ?? env.AI_TIMEOUT_MS);
          if (stored.isConfigured()) provider = stored;
          else
            logger.warn(
              { provider: settings.activeProvider },
              'Active AI provider is missing a key or model; using .env',
            );
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'Could not load AI settings; using .env configuration');
  }
  cache = { provider, at: Date.now() };
  return provider;
}

export function invalidateAiProviderCache() {
  cache = undefined;
}

/** Test hook: inject a fake provider (e.g. one that fails or times out). */
export function setAiProviderForTests(provider: AiProvider | null) {
  testOverride = provider;
  cache = undefined;
}
