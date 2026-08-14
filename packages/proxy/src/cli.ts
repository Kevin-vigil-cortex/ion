#!/usr/bin/env node
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ApiKeyCredentials,
  OAuthCredentials,
  FileTokenStore,
  DEFAULT_BASE_URL,
  type Credentials
} from '@ion/xai'
import { startProxyServer } from './server'

/**
 * Headless entry point for the local proxy. Uses XAI_API_KEY when set,
 * otherwise the SuperGrok OAuth tokens saved by the desktop app.
 */
async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? process.env.ION_PROXY_PORT ?? 8787)
  const baseUrl = process.env.XAI_BASE_URL ?? DEFAULT_BASE_URL
  const authPath = join(homedir(), '.ion', 'auth.json')

  let credentials: Credentials
  if (process.env.XAI_API_KEY) {
    credentials = new ApiKeyCredentials(process.env.XAI_API_KEY)
    console.log('[ion-proxy] using XAI_API_KEY')
  } else {
    const store = new FileTokenStore(authPath)
    if (!(await store.read())) {
      console.error(
        `[ion-proxy] No credentials found.\n` +
          `  Set XAI_API_KEY, or sign in with SuperGrok in the app first (tokens: ${authPath}).`
      )
      process.exit(1)
    }
    credentials = new OAuthCredentials({ store })
    console.log(`[ion-proxy] using SuperGrok OAuth tokens from ${authPath}`)
  }

  const handle = await startProxyServer({
    port,
    baseUrl,
    getCredentials: async () => credentials
  })

  const url = `http://127.0.0.1:${handle.port}`
  console.log(`[ion-proxy] listening on ${url}  ->  ${baseUrl}`)
  console.log(`[ion-proxy] point any OpenAI-compatible client at ${url}/v1`)

  const shutdown = (): void => {
    console.log('\n[ion-proxy] shutting down')
    void handle.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('[ion-proxy] fatal:', err)
  process.exit(1)
})
