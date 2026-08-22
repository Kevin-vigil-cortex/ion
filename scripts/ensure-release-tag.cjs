#!/usr/bin/env node
/**
 * Validate release state, then push v$version from the committed main HEAD.
 * GitHub rejects a published release whose tag is not already on the repo.
 */
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const repo = 'Kevin-vigil-cortex/ion'
const versionFiles = [
  'package.json',
  'apps/desktop/package.json',
  'packages/agent/package.json',
  'packages/proxy/package.json',
  'packages/xai/package.json'
]
const lockfilePaths = ['', 'apps/desktop', 'packages/agent', 'packages/proxy', 'packages/xai']

const lockfile = JSON.parse(readFileSync(join(__dirname, '..', 'package-lock.json'), 'utf8'))
const versions = [
  ...versionFiles.map((file) => ({
    file,
    version: JSON.parse(readFileSync(join(__dirname, '..', file), 'utf8')).version
  })),
  ...lockfilePaths.map((path) => ({
    file: `package-lock.json#packages[${JSON.stringify(path)}]`,
    version: lockfile.packages?.[path]?.version
  }))
]
const version = versions[0].version
const tag = `v${version}`

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

const mismatched = versions.filter((entry) => entry.version !== version)
if (mismatched.length) {
  fail(
    `First-party package versions must match ${version}: ` +
      mismatched.map((entry) => `${entry.file}=${entry.version}`).join(', ')
  )
}

const dirty = git('status', '--porcelain', '--untracked-files=no')
if (dirty) {
  fail('Release worktree is dirty. Commit all tracked changes before publishing.')
}

const branch = git('branch', '--show-current')
if (branch !== 'main') {
  fail(`Releases must be created from main, not ${branch || 'a detached HEAD'}.`)
}

const origin = git('remote', 'get-url', 'origin')
if (!/github\.com(?::|\/)Kevin-vigil-cortex\/ion(?:\.git)?$/i.test(origin)) {
  fail(`origin must be the canonical ${repo} repository, not ${origin}.`)
}

const head = git('rev-parse', 'HEAD')
const remoteMain = git('ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0]
if (!remoteMain || remoteMain !== head) {
  fail('Committed HEAD must already be pushed to origin/main before release tagging.')
}

const committedVersion = JSON.parse(git('show', 'HEAD:apps/desktop/package.json')).version
if (committedVersion !== version) {
  fail(
    `Committed desktop version is ${committedVersion}, but the working version is ${version}. ` +
      'Commit the version bump before publishing.'
  )
}

let canPush = ''
try {
  canPush = execFileSync('gh', ['api', `repos/${repo}`, '--jq', '.permissions.push'], {
    encoding: 'utf8'
  }).trim()
} catch {
  fail(`Unable to verify GitHub write access for ${repo}. Check GH_TOKEN or gh auth status.`)
}
if (canPush !== 'true') {
  fail(`The active GitHub credentials do not have write access to ${repo}.`)
}

let identities = ''
try {
  identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8'
  })
} catch {
  fail('Unable to inspect macOS signing identities.')
}
if (!identities.includes('Ion Dev')) {
  fail('The Ion Dev signing identity is required before publishing a release.')
}

const remoteTagRows = git(
  'ls-remote',
  '--tags',
  'origin',
  `refs/tags/${tag}`,
  `refs/tags/${tag}^{}`
)
  .split('\n')
  .filter(Boolean)
const peeledRemote = remoteTagRows.find((row) => row.endsWith(`refs/tags/${tag}^{}`))
const remoteTag = peeledRemote || remoteTagRows[0]
if (remoteTag) {
  const remoteTagged = remoteTag.split(/\s+/)[0]
  if (remoteTagged !== head) {
    fail(
      `${tag} already exists on origin at ${remoteTagged.slice(0, 7)}, ` +
        `not HEAD ${head.slice(0, 7)}. Bump the synchronized package version.`
    )
  }
}

const existing = git('tag', '-l', tag)
if (existing) {
  const tagged = git('rev-list', '-n', '1', tag)
  if (tagged !== head) {
    fail(
      `${tag} already points at ${tagged.slice(0, 7)}, not HEAD ${head.slice(0, 7)}. ` +
        'Bump the synchronized package version.'
    )
  }
} else {
  git('tag', tag)
  console.log(`created ${tag}`)
}

execFileSync('git', ['push', 'origin', tag], { stdio: 'inherit' })
