import type { ModelInfo, ModelPricing } from '@ion/agent'

export const DEFAULT_BASE_URL = 'https://api.x.ai/v1'
export const DEFAULT_MODEL = 'grok-4.6'

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

/** Every effort value the API recognizes, in ascending depth order. */
export const REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh']

/**
 * Efforts each offered family truly supports (docs.x.ai/reasoning): xhigh is
 * grok-4.6+ only - grok-4.5 silently coerces it to high, so we don't offer it
 * there. The API-side default is high for both.
 */
export const FAMILY_EFFORTS: Record<string, ReasoningEffort[]> = {
  'grok-4.6': ['low', 'medium', 'high', 'xhigh'],
  'grok-4.5': ['low', 'medium', 'high']
}

/**
 * The app deliberately offers only the two reasoning flagships (grok-4.6,
 * grok-4.5, both 500k context with reasoning depth control). This doubles as
 * the fallback when the live `/v1/models` call is unavailable.
 */
export const FALLBACK_MODELS: ModelInfo[] = [
  { id: 'grok-4.6', label: 'Grok 4.6', efforts: FAMILY_EFFORTS['grok-4.6'] },
  { id: 'grok-4.5', label: 'Grok 4.5', efforts: FAMILY_EFFORTS['grok-4.5'] }
]

/**
 * Whether a model accepts the Responses API `reasoning.effort` parameter.
 * Per docs.x.ai only grok-4.5 and grok-4.6 (and their variants) take the
 * depth-control form; other models either reject it or interpret it
 * differently (e.g. grok-4.20-multi-agent uses it for agent count), so we
 * stay conservative and let the API default apply elsewhere.
 */
export function supportsReasoningEffort(model: string): boolean {
  return model.startsWith('grok-4.5') || model.startsWith('grok-4.6')
}

/**
 * Reduce a live `/v1/models` listing to what the app offers: exactly one
 * entry per reasoning-flagship family (grok-4.6 first, then grok-4.5),
 * preferring the shortest slug when the API lists dated/alias variants.
 * Falls back to {@link FALLBACK_MODELS} when the listing has neither family,
 * and always attaches the effort levels.
 */
export function selectableModels(models: ModelInfo[]): ModelInfo[] {
  const families = ['grok-4.6', 'grok-4.5']
  const picked: ModelInfo[] = []
  for (const family of families) {
    const candidates = models
      .filter((m) => m.id === family || m.id.startsWith(`${family}-`))
      .sort((a, b) => a.id.length - b.id.length)
    const model = candidates[0]
    if (model) picked.push({ ...model, efforts: FAMILY_EFFORTS[family] })
  }
  return picked.length > 0 ? picked : FALLBACK_MODELS
}

/** Context window + pricing for one model. */
export interface ModelMetadata {
  contextWindow: number
  pricing: ModelPricing
}

/**
 * Per-model context windows and USD-per-million-token pricing, from
 * docs.x.ai/developers/models and /developers/pricing (checked Aug 2026).
 * xAI bills long-context requests (prompt >= 200k tokens) at a higher rate
 * for ALL tokens in the request - captured as `longContext`.
 *
 * | model        | ctx  | in    | cached | out   | >=200k in/out |
 * | grok-4.6     | 500k | $2.00 | $0.50  | $6.00 | $4.00/$12.00  |
 * | grok-4.5     | 500k | $2.00 | $0.30  | $6.00 | $4.00/$12.00  |
 * | grok-4.3     | 1M   | $1.25 | $0.20  | $2.50 | $2.50/$5.00   |
 * | grok-4.20-*  | 1M   | $1.25 | $0.20  | $2.50 | $2.50/$5.00   |
 * | grok-build-* | 256k | $1.00 | $0.20  | $2.00 | $2.00/$4.00   |
 *
 * Retired slugs (grok-4, grok-3, grok-code-fast-1) redirect since May 15 2026
 * and bill at their redirect target's rates, so they map to those numbers.
 */
const LONG_CONTEXT_THRESHOLD = 200_000

const GROK_43_PRICING: ModelPricing = {
  inputPerMTok: 1.25,
  outputPerMTok: 2.5,
  cachedInputPerMTok: 0.2,
  longContext: { thresholdTokens: LONG_CONTEXT_THRESHOLD, inputPerMTok: 2.5, outputPerMTok: 5 }
}

const GROK_BUILD_PRICING: ModelPricing = {
  inputPerMTok: 1,
  outputPerMTok: 2,
  cachedInputPerMTok: 0.2,
  longContext: { thresholdTokens: LONG_CONTEXT_THRESHOLD, inputPerMTok: 2, outputPerMTok: 4 }
}

export const MODEL_METADATA: Record<string, ModelMetadata> = {
  'grok-4.6': {
    contextWindow: 500_000,
    pricing: {
      inputPerMTok: 2,
      outputPerMTok: 6,
      cachedInputPerMTok: 0.5,
      longContext: { thresholdTokens: LONG_CONTEXT_THRESHOLD, inputPerMTok: 4, outputPerMTok: 12 }
    }
  },
  'grok-4.5': {
    contextWindow: 500_000,
    pricing: {
      inputPerMTok: 2,
      outputPerMTok: 6,
      cachedInputPerMTok: 0.3,
      longContext: { thresholdTokens: LONG_CONTEXT_THRESHOLD, inputPerMTok: 4, outputPerMTok: 12 }
    }
  },
  'grok-4.3': { contextWindow: 1_000_000, pricing: GROK_43_PRICING },
  'grok-4.20': { contextWindow: 1_000_000, pricing: GROK_43_PRICING },
  'grok-build': { contextWindow: 256_000, pricing: GROK_BUILD_PRICING },
  'grok-code-fast': { contextWindow: 256_000, pricing: GROK_BUILD_PRICING },
  'grok-4': { contextWindow: 1_000_000, pricing: GROK_43_PRICING },
  'grok-3': { contextWindow: 1_000_000, pricing: GROK_43_PRICING }
}

/** Conservative numbers for models we do not recognize. */
export const DEFAULT_MODEL_METADATA: ModelMetadata = {
  contextWindow: 256_000,
  pricing: {
    inputPerMTok: 2,
    outputPerMTok: 6,
    longContext: { thresholdTokens: LONG_CONTEXT_THRESHOLD, inputPerMTok: 4, outputPerMTok: 12 }
  }
}

/**
 * Look up metadata for a model id: exact match, then longest matching prefix
 * (covers dated/alias slugs like `grok-4.5-latest`), then a safe default.
 */
export function getModelMetadata(modelId: string): ModelMetadata {
  const exact = MODEL_METADATA[modelId]
  if (exact) return exact
  let best: ModelMetadata | null = null
  let bestLen = 0
  for (const [key, meta] of Object.entries(MODEL_METADATA)) {
    if (modelId.startsWith(key) && key.length > bestLen) {
      best = meta
      bestLen = key.length
    }
  }
  return best ?? DEFAULT_MODEL_METADATA
}

/** Decorate a model list with context-window/pricing metadata (non-destructive). */
export function withModelMetadata(models: ModelInfo[]): ModelInfo[] {
  return models.map((m) => {
    const meta = getModelMetadata(m.id)
    return {
      ...m,
      contextWindow: m.contextWindow ?? meta.contextWindow,
      pricing: m.pricing ?? meta.pricing
    }
  })
}
