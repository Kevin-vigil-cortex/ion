import { app, BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import { IpcEvent, type UpdateStatus } from '../shared/ipc'

const FIRST_CHECK_DELAY_MS = 10_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/**
 * Auto-updates from GitHub Releases via electron-updater. The feed URL comes
 * from app-update.yml, which electron-builder bakes into Resources when
 * packaging with the `publish` config (the `release` script) - plain
 * `npm run package` dir builds have no feed and stay `unsupported`.
 *
 * Updates download in the background; installing waits until the user clicks
 * "Restart to update" (or quits - autoInstallOnAppQuit). Squirrel.Mac only
 * accepts an update whose code signature matches the running app's, which is
 * why release builds must be signed with the stable "Ion Dev" identity
 * (scripts/eb-after-pack.cjs enforces this), never ad-hoc.
 */
export class UpdaterManager {
  private status: UpdateStatus
  private readonly enabled: boolean

  constructor() {
    this.enabled = app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'))
    this.status = this.enabled
      ? { state: 'idle' }
      : {
          state: 'unsupported',
          message: app.isPackaged
            ? 'This build was packaged without an update feed.'
            : 'Updates are disabled in dev builds.'
        }
    if (!this.enabled) return

    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('checking-for-update', () => this.setStatus({ state: 'checking' }))
    autoUpdater.on('update-available', (info) =>
      this.setStatus({ state: 'downloading', version: info.version, percent: 0 })
    )
    autoUpdater.on('update-not-available', () => this.setStatus({ state: 'none' }))
    autoUpdater.on('download-progress', (progress) =>
      this.setStatus({
        state: 'downloading',
        version: this.status.version,
        percent: Math.round(progress.percent)
      })
    )
    autoUpdater.on('update-downloaded', (info) =>
      this.setStatus({ state: 'downloaded', version: info.version })
    )
    autoUpdater.on('error', (err) =>
      this.setStatus({
        state: 'error',
        message: err instanceof Error ? err.message : String(err)
      })
    )
  }

  /** Kick off the background schedule: one check shortly after launch, then periodic. */
  start(): void {
    if (!this.enabled) return
    setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS)
    setInterval(() => void this.check(), CHECK_INTERVAL_MS)
  }

  /** Check now (manual "Check for updates"); resolves with the settled status. */
  async check(): Promise<UpdateStatus> {
    if (!this.enabled) return this.status
    try {
      await autoUpdater.checkForUpdates()
    } catch {
      // The 'error' listener already captured the failure into status.
    }
    return this.status
  }

  /** Quit and apply the downloaded update. No-op unless one is ready. */
  install(): void {
    if (this.status.state === 'downloaded') autoUpdater.quitAndInstall()
  }

  private setStatus(next: UpdateStatus): void {
    this.status = next
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IpcEvent.UpdateStatus, next)
    }
  }
}
