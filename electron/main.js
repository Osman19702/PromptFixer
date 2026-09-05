/**
 * Electron main process.
 *
 * The Express server from `server/` runs in this process on a random free
 * port, and the window loads it like any web page. Inference runs here too
 * (node-llama-cpp is a Node-API module, so it works inside Electron).
 */

import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadDesktopEnv } from './env.js'
import { installQuitHandler, willNavigateGuard } from './handlers.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Must be set before the server module is imported — it reads these at load.
// These two are deliberate overrides, not defaults, so they go before `.env`.
process.env.PROMPTFIXER_DESKTOP = '1'
process.env.PROMPTFIXER_DATA_DIR = path.join(app.getPath('userData'), 'data')
// Installed app: %APPDATA%/PromptFixer/.env. Dev: the project .env wins.
loadDesktopEnv({ userDataDir: app.getPath('userData'), packaged: app.isPackaged })

let mainWindow = null

async function createWindow() {
  const { start } = await import('../server/index.js')
  const { port } = await start({ port: 0 })
  const origin = `http://127.0.0.1:${port}`

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: 'PromptFixer',
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // Nothing may open a second window or navigate this one away from our
  // server (window.open, target=_blank, or a file/URL dropped on the page).
  // http(s) links go to the system browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', willNavigateGuard(origin, shell))

  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  await mainWindow.loadURL(origin)
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// Release VRAM/RAM held by the model before the process goes away.
installQuitHandler(app, () => import('../server/local-llm.js'))

export { __dirname }
