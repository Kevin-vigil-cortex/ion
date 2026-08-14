/** Error carrying the HTTP status from an xAI API call. */
export class XaiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string
  ) {
    super(message)
    this.name = 'XaiError'
  }

  /**
   * True when the failure looks like OAuth tier-gating: xAI accepts the login
   * but the account is not on the API-access allowlist (HTTP 403). Callers
   * should stop retrying and suggest the API-key path.
   */
  get isTierGated(): boolean {
    return this.status === 403
  }
}
