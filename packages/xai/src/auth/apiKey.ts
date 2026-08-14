import type { Credentials } from './types'

/** Static bearer-token credentials backed by a pay-per-token xAI API key. */
export class ApiKeyCredentials implements Credentials {
  readonly kind = 'api_key' as const

  constructor(private readonly apiKey: string) {
    if (!apiKey || !apiKey.trim()) {
      throw new Error('An xAI API key is required.')
    }
  }

  async authorizationHeader(): Promise<string> {
    return `Bearer ${this.apiKey}`
  }
}
