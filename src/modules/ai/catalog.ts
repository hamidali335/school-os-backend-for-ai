/**
 * AI providers the platform can switch between. All of them expose an OpenAI-compatible
 * Chat Completions API, so one client implementation serves every provider; only the base
 * URL, key and model differ. Model lists here are suggestions for the admin panel; the live
 * list comes from `GET /platform/ai/providers/{id}/models`.
 */
export const AI_PROVIDER_IDS = ['groq', 'openai', 'deepseek', 'xai', 'gemini', 'openrouter', 'custom'] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export interface ProviderCatalogEntry {
  id: AiProviderId;
  name: string;
  description: string;
  baseUrl: string;
  /** Where the API key is created. */
  keysUrl: string;
  keyPrefix?: string;
  /** Request field for the output-token limit. */
  maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  hasFreeTier: boolean;
  suggestedModels: Array<{ id: string; label: string; free?: boolean; notes?: string }>;
}

export const AI_CATALOG: Record<AiProviderId, ProviderCatalogEntry> = {
  groq: {
    id: 'groq',
    name: 'Groq',
    description: 'Very fast inference of open models. Free tier with rate limits — good for development and testing.',
    baseUrl: 'https://api.groq.com/openai/v1',
    keysUrl: 'https://console.groq.com/keys',
    keyPrefix: 'gsk_',
    maxTokensParam: 'max_completion_tokens',
    hasFreeTier: true,
    suggestedModels: [
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', free: true, notes: 'Strong reasoning and tool use' },
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', free: true, notes: 'Faster, lighter' },
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', free: true },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant', free: true, notes: 'Fastest, simple tasks' },
    ],
  },
  openai: {
    id: 'openai',
    name: 'OpenAI (ChatGPT)',
    description: 'OpenAI GPT models.',
    baseUrl: 'https://api.openai.com/v1',
    keysUrl: 'https://platform.openai.com/api-keys',
    keyPrefix: 'sk-',
    maxTokensParam: 'max_completion_tokens',
    hasFreeTier: false,
    suggestedModels: [
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', notes: 'Low cost' },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
      { id: 'gpt-4o', label: 'GPT-4o' },
    ],
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'DeepSeek chat and reasoning models. Low cost.',
    baseUrl: 'https://api.deepseek.com/v1',
    keysUrl: 'https://platform.deepseek.com/api_keys',
    keyPrefix: 'sk-',
    maxTokensParam: 'max_tokens',
    hasFreeTier: false,
    suggestedModels: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat', notes: 'Supports tool calling (Copilot)' },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', notes: 'Reasoning; limited tool support' },
    ],
  },
  xai: {
    id: 'xai',
    name: 'xAI (Grok)',
    description: 'xAI Grok models.',
    baseUrl: 'https://api.x.ai/v1',
    keysUrl: 'https://console.x.ai',
    keyPrefix: 'xai-',
    maxTokensParam: 'max_tokens',
    hasFreeTier: false,
    suggestedModels: [
      { id: 'grok-4-fast', label: 'Grok 4 Fast' },
      { id: 'grok-4', label: 'Grok 4' },
      { id: 'grok-3-mini', label: 'Grok 3 Mini' },
    ],
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    description: 'Google Gemini via its OpenAI-compatible endpoint. Free tier available.',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keysUrl: 'https://aistudio.google.com/app/apikey',
    keyPrefix: 'AIza',
    maxTokensParam: 'max_tokens',
    hasFreeTier: true,
    suggestedModels: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', free: true },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', free: true },
    ],
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'One key for many providers; includes free models (ids ending in ":free").',
    baseUrl: 'https://openrouter.ai/api/v1',
    keysUrl: 'https://openrouter.ai/keys',
    keyPrefix: 'sk-or-',
    maxTokensParam: 'max_tokens',
    hasFreeTier: true,
    suggestedModels: [
      { id: 'openai/gpt-oss-120b:free', label: 'GPT-OSS 120B (free)', free: true },
      { id: 'deepseek/deepseek-chat-v3.1:free', label: 'DeepSeek V3.1 (free)', free: true },
    ],
  },
  custom: {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    description:
      'Any other OpenAI-compatible endpoint (self-hosted, Azure OpenAI proxy, Together, Mistral...). Base URL required.',
    baseUrl: '',
    keysUrl: '',
    maxTokensParam: 'max_tokens',
    hasFreeTier: false,
    suggestedModels: [],
  },
};

export const isProviderId = (v: string): v is AiProviderId => (AI_PROVIDER_IDS as readonly string[]).includes(v);
