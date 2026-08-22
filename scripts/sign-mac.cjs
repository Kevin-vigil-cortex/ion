#!/usr/bin/env node
/**
 * Sign the packaged mac app with a STABLE identity when one is available.
 *
 * Why: macOS TCC (file-access permission) grants are keyed to the app's
 * designated requirement. Ad-hoc signatures (`codesign --sign -`) pin that to
 * the build's content hash, so every rebuild looks like a new app and the
 * user gets re-prompted for Desktop/Documents/etc. Signing with a persistent
 * certificate anchors the requirement to the cert instead, so grants survive
 * rebuilds. See docs/packaging note in README.
 *
 * Identity resolution order:
 *   1. $ION_CODESIGN_IDENTITY (explicit override)
 *   2. "Ion Dev" self-signed cert, if present in the keychain
 *   3. ad-hoc ("-") - works everywhere, permissions reset each rebuild
 */
const { execFileSync } = require('node:child_process')

const app = process.argv[2]
if (!app) {
  console.error('usage: sign-mac.cjs <path/to/App.app>')
  process.exit(1)
}

function hasIdentity(name) {
  try {
    const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8'
    })
    return out.includes(`"${name}"`)
  } catch {
    return false
  }
}

const identity =
  process.env.ION_CODESIGN_IDENTITY ?? (hasIdentity('Ion Dev') ? 'Ion Dev' : '-')

execFileSync('codesign', ['--force', '--deep', '--sign', identity, app], { stdio: 'inherit' })
console.log(
  identity === '-'
    ? `signed ${app} ad-hoc (no stable identity found - TCC grants reset on rebuild)`
    : `signed ${app} with "${identity}" (TCC grants persist across rebuilds)`
)
