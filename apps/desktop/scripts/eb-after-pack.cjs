// electron-builder resolves afterPack from the workspace package dir when
// invoked via `npm run -w @ion/desktop`. The real hook lives at the repo root
// (also used when electron-builder is launched from there).
module.exports = require('../../../scripts/eb-after-pack.cjs')
