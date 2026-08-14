/**
 * Auth abstraction shared by the API-key and OAuth paths. The model client and
 * proxy depend only on this interface, so they never branch on how the token
 * was obtained.
 */
export interface Credentials {
  readonly kind: 'api_key' | 'oauth'
  /** A valid `Authorization` header value, refreshing proactively if needed. */
  authorizationHeader(): Promise<string>
  /**
   * Invoked after the server returns 401. Implementations may force a refresh
   * and return `true` to signal the caller should retry the request once.
   */
  handleUnauthorized?(): Promise<boolean>
}
