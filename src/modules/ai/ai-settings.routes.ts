import { env } from '../../config/env';
import { encryptSecret, maskSecret, decryptSecret } from '../../services/secrets';
import type { PlatformContext } from '../../types/context';
import type { Api } from '../../utils/api';
import { AppError, badRequest } from '../../utils/errors';
import { z } from '../../utils/zod';
import { audit } from '../audit/audit.service';
import { AiSettings } from './ai-settings.model';
import { AI_CATALOG, AI_PROVIDER_IDS, type AiProviderId } from './catalog';
import {
  AiProviderError,
  buildProvider,
  getAiProvider,
  invalidateAiProviderCache,
  providerFromEnv,
  providerFromStored,
  type AiProvider,
  type StoredProviderConfig,
} from './provider';

const OWNER_ONLY = ['platform_owner'] as const;

const ProviderParam = z.object({ provider: z.enum(AI_PROVIDER_IDS) });

const ProviderConfigRes = z
  .object({
    provider: z.enum(AI_PROVIDER_IDS),
    hasApiKey: z.boolean(),
    apiKeyMasked: z.string().nullable().openapi({ description: 'e.g. "gsk_…9fA2". The full key is never returned.' }),
    keyReadable: z.boolean().openapi({
      description: 'False if the key can no longer be decrypted (encryption secret changed) — enter it again.',
    }),
    model: z.string().nullable(),
    baseUrl: z.string(),
    inputCostPerMTokUsd: z.number(),
    outputCostPerMTokUsd: z.number(),
    updatedAt: z.string().nullable(),
  })
  .openapi('AiProviderConfig');

const SettingsRes = z
  .object({
    enabled: z.boolean(),
    activeProvider: z.enum(AI_PROVIDER_IDS).nullable(),
    timeoutMs: z.number(),
    effective: z
      .object({
        provider: z.string(),
        model: z.string(),
        source: z.string(),
        configured: z.boolean(),
      })
      .openapi({ description: 'What the system is actually using right now (admin settings, or the .env fallback).' }),
    providers: z.array(ProviderConfigRes),
  })
  .openapi('AiSettings');

async function loadSettings() {
  return (await AiSettings.findOne({ key: 'global' }).lean()) ?? null;
}

function providerMap(
  settings: Awaited<ReturnType<typeof loadSettings>>,
): Record<string, StoredProviderConfig & { apiKeyMasked?: string; updatedAt?: Date }> {
  return (settings?.providers as any) ?? {};
}

async function settingsView() {
  const settings = await loadSettings();
  const map = providerMap(settings);
  const effective = await getAiProvider();
  return {
    enabled: settings?.enabled !== false,
    activeProvider: (settings?.activeProvider as AiProviderId | undefined) ?? null,
    timeoutMs: settings?.timeoutMs ?? env.AI_TIMEOUT_MS,
    effective: {
      provider: effective.name,
      model: effective.model,
      source: effective.source ?? 'env',
      configured: effective.isConfigured(),
    },
    providers: AI_PROVIDER_IDS.map((id) => {
      const cfg = map[id];
      return {
        provider: id,
        hasApiKey: Boolean(cfg?.apiKeyEncrypted),
        apiKeyMasked: cfg?.apiKeyMasked ?? null,
        keyReadable: cfg?.apiKeyEncrypted ? decryptSecret(cfg.apiKeyEncrypted) !== null : false,
        model: cfg?.model ?? null,
        baseUrl: cfg?.baseUrl || AI_CATALOG[id].baseUrl,
        inputCostPerMTokUsd: cfg?.inputCostPerMTokUsd ?? 0,
        outputCostPerMTokUsd: cfg?.outputCostPerMTokUsd ?? 0,
        updatedAt: cfg?.updatedAt ? new Date(cfg.updatedAt).toISOString() : null,
      };
    }),
  };
}

/** Provider for a test/model-list request: an explicit key, else the saved config, else .env. */
async function providerFor(
  id: AiProviderId,
  overrides: { apiKey?: string; model?: string; baseUrl?: string },
): Promise<AiProvider> {
  const settings = await loadSettings();
  const cfg = providerMap(settings)[id];
  const timeoutMs = settings?.timeoutMs ?? env.AI_TIMEOUT_MS;
  const fromEnv = env.AI_PROVIDER === id ? providerFromEnv() : null;
  const stored = cfg ? providerFromStored(id, cfg, timeoutMs) : null;
  const apiKey =
    overrides.apiKey ??
    (cfg?.apiKeyEncrypted ? decryptSecret(cfg.apiKeyEncrypted) : null) ??
    (fromEnv ? (env.AI_API_KEY ?? env.XAI_API_KEY) : null);
  const baseUrl =
    overrides.baseUrl ?? cfg?.baseUrl ?? (fromEnv ? env.AI_BASE_URL : undefined) ?? AI_CATALOG[id].baseUrl;
  const model = overrides.model ?? stored?.model ?? (fromEnv ? env.AI_MODEL : '') ?? '';
  if (!apiKey)
    throw badRequest(
      `No API key for ${AI_CATALOG[id].name}. Save one first or pass apiKey.`,
      undefined,
      'AI_KEY_MISSING',
    );
  if (!baseUrl) throw badRequest('This provider needs a baseUrl', undefined, 'AI_BASE_URL_MISSING');
  return buildProvider({
    id,
    apiKey,
    baseUrl,
    model: model || AI_CATALOG[id].suggestedModels[0]?.id || 'unknown',
    timeoutMs,
    inputCostPerMTokUsd: cfg?.inputCostPerMTokUsd ?? 0,
    outputCostPerMTokUsd: cfg?.outputCostPerMTokUsd ?? 0,
    source: 'database',
  });
}

function providerFailure(err: unknown) {
  if (err instanceof AiProviderError) {
    const hint =
      err.kind === 'auth'
        ? 'The provider rejected the API key. Check that the key belongs to this provider and is active.'
        : err.httpStatus === 404
          ? 'Model or endpoint not found. Check the model id (use the model list) and base URL.'
          : err.kind === 'rate_limited'
            ? 'Rate limit or quota reached at the provider.'
            : err.kind === 'timeout'
              ? 'The provider did not answer in time.'
              : undefined;
    return {
      ok: false as const,
      errorKind: err.kind,
      httpStatus: err.httpStatus ?? null,
      providerMessage: err.detail ?? null,
      hint: hint ?? null,
    };
  }
  throw err;
}

export function registerAiSettingsRoutes(api: Api) {
  const tags = ['Platform AI Settings'];

  api.route({
    method: 'get',
    path: '/platform/ai/providers',
    tags,
    auth: 'platform',
    summary: 'Supported AI providers with default URLs and suggested models',
    description:
      'Use this to build the provider and model dropdowns. Suggested models are examples; fetch the live list per provider.',
    response: z.array(
      z.object({
        id: z.enum(AI_PROVIDER_IDS),
        name: z.string(),
        description: z.string(),
        baseUrl: z.string(),
        keysUrl: z.string(),
        keyPrefix: z.string().optional(),
        hasFreeTier: z.boolean(),
        suggestedModels: z.array(
          z.object({ id: z.string(), label: z.string(), free: z.boolean().optional(), notes: z.string().optional() }),
        ),
      }),
    ),
    handler: () =>
      AI_PROVIDER_IDS.map((id) => {
        const { maxTokensParam: _m, ...rest } = AI_CATALOG[id];
        return rest;
      }),
  });

  api.route({
    method: 'get',
    path: '/platform/ai/settings',
    tags,
    auth: 'platform',
    summary: 'Current AI configuration (keys masked) and what is effectively in use',
    response: SettingsRes,
    handler: () => settingsView(),
  });

  api.route({
    method: 'put',
    path: '/platform/ai/settings/providers/:provider',
    tags,
    auth: 'platform',
    platformRoles: [...OWNER_ONLY],
    summary: "Save a provider's API key, model, base URL and prices",
    description:
      'Omit `apiKey` to keep the saved key (e.g. when only changing the model). Keys are encrypted at rest and never returned. ' +
      'Set `activate: true` to make this the active provider in the same call. Use `POST /platform/ai/test` to verify first.',
    params: ProviderParam,
    body: z.object({
      apiKey: z.string().trim().min(8).max(500).optional(),
      model: z.string().trim().min(1).max(200),
      baseUrl: z.string().trim().url().max(300).optional().or(z.literal('')),
      inputCostPerMTokUsd: z.number().min(0).max(1000).optional(),
      outputCostPerMTokUsd: z.number().min(0).max(1000).optional(),
      activate: z.boolean().optional(),
    }),
    response: SettingsRes,
    handler: async ({ ctx, params, body }) => {
      const id = params.provider;
      const existing = providerMap(await loadSettings())[id];
      if (!body.apiKey && !existing?.apiKeyEncrypted)
        throw badRequest('apiKey is required the first time', undefined, 'AI_KEY_MISSING');
      if (id === 'custom' && !body.baseUrl && !existing?.baseUrl)
        throw badRequest('The custom provider needs a baseUrl');
      const set: Record<string, unknown> = {
        [`providers.${id}.model`]: body.model,
        [`providers.${id}.updatedAt`]: new Date(),
        [`providers.${id}.updatedBy`]: (ctx as PlatformContext).adminId,
      };
      if (body.apiKey) {
        set[`providers.${id}.apiKeyEncrypted`] = encryptSecret(body.apiKey);
        set[`providers.${id}.apiKeyMasked`] = maskSecret(body.apiKey);
      }
      if (body.baseUrl !== undefined) set[`providers.${id}.baseUrl`] = body.baseUrl || undefined;
      if (body.inputCostPerMTokUsd !== undefined) set[`providers.${id}.inputCostPerMTokUsd`] = body.inputCostPerMTokUsd;
      if (body.outputCostPerMTokUsd !== undefined)
        set[`providers.${id}.outputCostPerMTokUsd`] = body.outputCostPerMTokUsd;
      if (body.activate) set.activeProvider = id;
      await AiSettings.updateOne({ key: 'global' }, { $set: set }, { upsert: true, setDefaultsOnInsert: true });
      invalidateAiProviderCache();
      await audit(ctx, {
        action: 'platform.ai.provider_saved',
        entityType: 'AiSettings',
        entityId: id,
        // Never the key itself.
        metadata: {
          provider: id,
          model: body.model,
          keyChanged: Boolean(body.apiKey),
          activated: Boolean(body.activate),
        },
      });
      return settingsView();
    },
  });

  api.route({
    method: 'delete',
    path: '/platform/ai/settings/providers/:provider',
    tags,
    auth: 'platform',
    platformRoles: [...OWNER_ONLY],
    summary: "Remove a provider's saved key and settings",
    description: 'If it was the active provider, the system falls back to the .env configuration.',
    params: ProviderParam,
    response: SettingsRes,
    handler: async ({ ctx, params }) => {
      const settings = await loadSettings();
      const unset: Record<string, 1> = { [`providers.${params.provider}`]: 1 };
      if (settings?.activeProvider === params.provider) unset.activeProvider = 1;
      await AiSettings.updateOne({ key: 'global' }, { $unset: unset });
      invalidateAiProviderCache();
      await audit(ctx, { action: 'platform.ai.provider_removed', entityType: 'AiSettings', entityId: params.provider });
      return settingsView();
    },
  });

  api.route({
    method: 'get',
    path: '/platform/ai/providers/:provider/models',
    tags,
    auth: 'platform',
    summary: 'Live model list from the provider (uses the saved key, or the .env key)',
    params: ProviderParam,
    response: z.object({
      provider: z.enum(AI_PROVIDER_IDS),
      source: z.enum(['live', 'suggested']),
      models: z.array(z.string()),
      suggested: z.array(
        z.object({ id: z.string(), label: z.string(), free: z.boolean().optional(), notes: z.string().optional() }),
      ),
      error: z.any().optional(),
    }),
    handler: async ({ params }) => {
      const suggested = AI_CATALOG[params.provider].suggestedModels;
      try {
        const provider = await providerFor(params.provider, {});
        const models = (await provider.listModels?.()) ?? [];
        return { provider: params.provider, source: 'live' as const, models, suggested };
      } catch (err) {
        if (err instanceof AppError) {
          return {
            provider: params.provider,
            source: 'suggested' as const,
            models: suggested.map((m) => m.id),
            suggested,
            error: { code: err.code, message: err.message },
          };
        }
        return {
          provider: params.provider,
          source: 'suggested' as const,
          models: suggested.map((m) => m.id),
          suggested,
          error: providerFailure(err),
        };
      }
    },
  });

  api.route({
    method: 'post',
    path: '/platform/ai/test',
    tags,
    auth: 'platform',
    summary: 'Send a test prompt to a provider/model and report the result',
    description:
      'Without a body, tests the configuration currently in use. Pass `provider` (and optionally `model`, `apiKey`, `baseUrl`) to test before saving. ' +
      'Nothing is saved and no school usage is recorded. Provider error messages are included to help diagnose keys and model names.',
    body: z.object({
      provider: z.enum(AI_PROVIDER_IDS).optional(),
      model: z.string().trim().min(1).max(200).optional(),
      apiKey: z.string().trim().min(8).max(500).optional(),
      baseUrl: z.string().trim().url().max(300).optional(),
      prompt: z.string().trim().min(1).max(500).default('Reply with exactly: OK'),
    }),
    response: z.object({
      ok: z.boolean(),
      provider: z.string(),
      model: z.string(),
      latencyMs: z.number().nullable(),
      reply: z.string().nullable(),
      usage: z.object({ promptTokens: z.number(), completionTokens: z.number(), totalTokens: z.number() }).nullable(),
      errorKind: z.string().nullable(),
      httpStatus: z.number().nullable(),
      providerMessage: z.string().nullable(),
      hint: z.string().nullable(),
    }),
    handler: async ({ ctx, body }) => {
      const provider = body.provider
        ? await providerFor(body.provider, { apiKey: body.apiKey, model: body.model, baseUrl: body.baseUrl })
        : await getAiProvider();
      if (!provider.isConfigured()) {
        return {
          ok: false,
          provider: provider.name,
          model: provider.model,
          latencyMs: null,
          reply: null,
          usage: null,
          errorKind: 'not_configured',
          httpStatus: null,
          providerMessage: null,
          hint: 'No AI provider is configured. Save a provider key and model, or set AI_API_KEY in .env.',
        };
      }
      const started = Date.now();
      await audit(ctx, {
        action: 'platform.ai.test',
        entityType: 'AiSettings',
        entityId: provider.name,
        metadata: { model: provider.model },
      });
      try {
        const res = await provider.chat({ messages: [{ role: 'user', content: body.prompt }], maxTokens: 300 });
        return {
          ok: true,
          provider: provider.name,
          model: res.model,
          latencyMs: Date.now() - started,
          reply: (res.content ?? '').slice(0, 1000),
          usage: res.usage,
          errorKind: null,
          httpStatus: null,
          providerMessage: null,
          hint: null,
        };
      } catch (err) {
        return {
          provider: provider.name,
          model: provider.model,
          latencyMs: Date.now() - started,
          reply: null,
          usage: null,
          ...providerFailure(err),
        };
      }
    },
  });

  api.route({
    method: 'put',
    path: '/platform/ai/settings',
    tags,
    auth: 'platform',
    platformRoles: [...OWNER_ONLY],
    summary: 'Switch the active provider, or turn AI on/off for the whole platform',
    description:
      'Takes effect immediately for new AI requests (other server instances within 30 seconds). ' +
      'The selected provider must already have an API key and model saved.',
    body: z.object({
      activeProvider: z.enum(AI_PROVIDER_IDS).optional(),
      enabled: z.boolean().optional(),
      timeoutMs: z.number().int().min(1000).max(120_000).optional(),
    }),
    response: SettingsRes,
    handler: async ({ ctx, body }) => {
      if (body.activeProvider) {
        const cfg = providerMap(await loadSettings())[body.activeProvider];
        if (!cfg?.apiKeyEncrypted || !cfg?.model) {
          throw new AppError(
            422,
            'AI_PROVIDER_INCOMPLETE',
            `Save an API key and model for ${AI_CATALOG[body.activeProvider].name} before activating it.`,
          );
        }
        if (body.activeProvider === 'custom' && !cfg.baseUrl) throw badRequest('The custom provider needs a baseUrl');
      }
      await AiSettings.updateOne(
        { key: 'global' },
        { $set: { ...body, updatedBy: (ctx as PlatformContext).adminId } },
        { upsert: true, setDefaultsOnInsert: true },
      );
      invalidateAiProviderCache();
      await audit(ctx, { action: 'platform.ai.settings_updated', entityType: 'AiSettings', metadata: body });
      return settingsView();
    },
  });
}
