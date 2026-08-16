#!/usr/bin/env node
/**
 * electron-builder afterPack hook: sign the packed .app BEFORE the zip/dmg
 * artifacts are created, so the bits inside published updates carry the same
 * stable signature the installed app has (see scripts/sign-mac.cjs).
 *
 * Squirrel.Mac refuses updates whose signature doesn't satisfy the running
 * app's designated requirement, and ad-hoc signatures change every build —
 * so distributable builds hard-fail when the stable identity is missing
 * instead of silently shipping a non-updatable artifact.
 */
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const distributing = context.targets.some((t) => t.name !== 'dir')
  if (distributing) {
    const identity = process.env.ION_CODESIGN_IDENTITY ?? 'Ion Dev'
    const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8'
    })
    if (!identities.includes(`"${identity}"`)) {
      throw new Error(
        `Release builds must be signed with the stable "${identity}" identity, ` +
          'but it is not in the keychain. Ad-hoc-signed updates would be rejected ' +
          'by the auto-updater on every install.'
      )
    }
  }

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('node', [path.join(__dirname, 'sign-mac.cjs'), appPath], { stdio: 'inherit' })
}
