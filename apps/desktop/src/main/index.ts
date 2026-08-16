import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { applyUserPath } from '@ion/agent'
import icon from '../../resources/icon.png?asset'
import { ConfigStore } from './config'
import { AuthManager } from './auth'
import { AgentRuntime } from './runtime'
import { ProxyManager } from './proxy'
import { OAuthManager } from './oauth'
import { BoardStore } from './board'
import { UpdaterManager } from './updater'
import { registerIpc } from './ipc'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 600,
    show: false,
    title: 'Ion',
    // Cursor-style frameless chrome on macOS with inset traffic lights
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    // Click an inactive window and the control under the cursor fires (native).
    acceptFirstMouse: true,
    // Real liquid glass: on macOS the window itself is transparent and native
    // vibrancy shows the desktop (blurred) through the sidebar region, which
    // the renderer leaves transparent. Other platforms keep a solid dark window.
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#0a0d16',
    ...(process.platform === 'darwin'
      ? {
          transparent: true,
          vibrancy: 'sidebar' as const,
          visualEffectState: 'active' as const
        }
      : {}),
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Pin the security-relevant flags rather than relying on defaults.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The agent's embedded browser panel renders through a <webview> guest.
      webviewTag: true
    }
  })

  win.on('ready-to-show', () => win.show())

  // Defense-in-depth for the <webview> guest: whatever the page asks for,
  // guests never get node, and never load a preload script.
  win.webContents.on('will-attach-webview', (_event, webPreferences) => {
    delete webPreferences.preload
    delete (webPreferences as { preloadURL?: string }).preloadURL
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
  })

  // The top-level window only ever shows our own UI; block stray navigations.
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith('file://')
    if (!allowed) event.preventDefault()
  })

  // Open external links in the system browser, never inside the app.
  // Web-ish schemes only: a crafted link in rendered output must not be able
  // to launch arbitrary protocol handlers (file:, app schemes, …).
  win.webContents.setWindowOpenHandler(({ url }) => {
    let scheme: string
    try {
      scheme = new URL(url).protocol
    } catch {
      return { action: 'deny' }
    }
    if (scheme === 'http:' || scheme === 'https:' || scheme === 'mailto:') {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

async function bootstrap(): Promise<void> {
  // Finder/Dock launches get a stub PATH. Do this before any spawn.
  applyUserPath()

  const config = new ConfigStore()
  await config.load()

  const auth = new AuthManager(config)
  const oauth = new OAuthManager()
  await oauth.init()
  oauth.attach(auth)

  const runtime = new AgentRuntime(config, auth)
  const proxy = new ProxyManager(config, auth)
  const board = new BoardStore()
  const updater = new UpdaterManager()

  registerIpc({
    config,
    auth,
    runtime,
    proxy,
    board,
    updater,
    oauth: {
      start: () => oauth.start().then(() => runtime.invalidateAgents()),
      signOut: () => oauth.signOut()
    }
  })

  // Dev runs unpackaged, so macOS shows Electron's default dock icon unless set here.
  if (process.platform === 'darwin') {
    app.dock?.setIcon(icon)
  }

  createWindow()
  updater.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('before-quit', () => {
    void runtime.closeMcp()
  })
}

app.whenReady().then(bootstrap)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
