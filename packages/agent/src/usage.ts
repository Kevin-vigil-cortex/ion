import type { ConversationItem, ModelPricing } from './types'

/**
 * Token estimation and cost math for context/usage reporting. Estimates use
 * the common ~4 chars/token heuristic — good enough for a fullness gauge;
 * real billing numbers come from the provider's usage reports.
 */

/** Rough token estimate for a chunk of text (~4 chars per token). */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

/** Rough token estimate for one conversation item as sent to the model. */
export function estimateItemTokens(item: ConversationItem): number {
  switch (item.kind) {
    case 'message': {
      let n = estimateTokens(item.content)
      for (const a of item.attachments ?? []) {
        n += a.kind === 'image' ? 800 : 200
      }
      return n
    }
    case 'tool_call':
      return estimateTokens(item.name) + estimateTokens(item.arguments)
    case 'tool_result':
      return estimateTokens(item.output)
    case 'reasoning':
      return estimateTokens(item.encryptedContent)
    case 'checkpoint':
      return 0
  }
}

/**
 * Estimated USD cost of one model call. Applies the provider's long-context
 * tier (all tokens billed at the higher rate) when the prompt reaches its
 * threshold, mirroring xAI's published billing rules.
 */
export function estimateCostUsd(
  pricing: ModelPricing,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0
): number {
  const cached = Math.min(Math.max(cachedInputTokens, 0), inputTokens)
  const fresh = inputTokens - cached
  const tier =
    pricing.longContext && inputTokens >= pricing.longContext.thresholdTokens
      ? pricing.longContext
      : pricing
  const cachedRate = pricing.cachedInputPerMTok ?? tier.inputPerMTok
  return (fresh * tier.inputPerMTok + cached * cachedRate + outputTokens * tier.outputPerMTok) / 1_000_000
}
