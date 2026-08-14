export * from './auth/types'
export { ApiKeyCredentials } from './auth/apiKey'
export { OAuthCredentials, loginWithDeviceFlow } from './auth/oauth'
export type { OAuthCredentialsOptions, LoginCallbacks } from './auth/oauth'
export { FileTokenStore, MemoryTokenStore } from './auth/tokenStore'
export type { StoredTokens, TokenStore } from './auth/tokenStore'
export type { DeviceCodeResponse } from './auth/deviceFlow'
export {
  XAI_OAUTH_ISSUER,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_SCOPE,
  discoverOidc,
  validateXaiEndpoint
} from './auth/oidc'
export { accountFromToken, decodeJwtPayload, jwtExpiryMs } from './auth/jwt'
export { XaiModelClient } from './client'
export type { XaiClientConfig } from './client'
export { XaiError } from './errors'
export {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  FALLBACK_MODELS,
  REASONING_EFFORTS,
  FAMILY_EFFORTS
} from './models'
export {
  MODEL_METADATA,
  DEFAULT_MODEL_METADATA,
  getModelMetadata,
  withModelMetadata,
  supportsReasoningEffort,
  selectableModels
} from './models'
export type { ModelMetadata, ReasoningEffort } from './models'
export { parseSse } from './sse'
export type { SseEvent } from './sse'
export type {
  ResponsesInputItem,
  ResponsesFunctionTool,
  ResponsesRequest
} from './types'
