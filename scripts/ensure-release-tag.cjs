#!/usr/bin/env node
/**
 * GitHub rejects a published release whose tag is not already on the repo
 * ("Published releases must have a valid tag"). Push v$version from HEAD
 * before electron-builder publishes.
 */
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const version = JSON.parse(
  readFileSync(join(__dirname, '../apps/desktop/package.json'), 'utf8')
).version
const tag = `v${version}`

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

const existing = git('tag', '-l', tag)
if (existing) {
  const tagged = git('rev-list', '-n', '1', tag)
  const head = git('rev-parse', 'HEAD')
  if (tagged !== head) {
    console.error(
      `${tag} already points at ${tagged.slice(0, 7)}, not HEAD ${head.slice(0, 7)}. ` +
        'Bump apps/desktop/package.json or move the tag.'
    )
    process.exit(1)
  }
} else {
  git('tag', tag)
  console.log(`created ${tag}`)
}

execFileSync('git', ['push', 'origin', tag], { stdio: 'inherit' })
