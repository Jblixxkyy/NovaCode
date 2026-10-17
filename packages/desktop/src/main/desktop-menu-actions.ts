import { exec, spawn } from "node:child_process"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"
import { app, BrowserWindow, dialog, shell } from "electron"
import type { DesktopMenuAction } from "@novacode-ai/app/desktop-menu"
import { createMainWindow, updateTitlebar } from "./windows"
import { write as writeLog } from "./logging"
import { nativeT } from "./native-translations"

export type DesktopMenuActionHandlers = Partial<{
  checkForUpdates: () => void
  relaunch: () => void
}>

const WEB_APP_PORT = 3000
const WEB_BACKEND_PORT = 4096

let webBackendProcess: ReturnType<typeof spawn> | null = null
let webAppProcess: ReturnType<typeof spawn> | null = null

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")
}

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once("error", () => resolve(true))
    server.once("listening", () => {
      server.close(() => resolve(false))
    })
    server.listen(port, "127.0.0.1")
  })
}

function waitForPort(port: number, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now()
  return new Promise((resolve) => {
    const check = () => {
      isPortInUse(port).then((inUse) => {
        if (inUse) return resolve(true)
        if (Date.now() - start > timeoutMs) return resolve(false)
        setTimeout(check, 500)
      })
    }
    check()
  })
}

async function startWebApp(sharedSessions: boolean) {
  if (app.isPackaged) {
    writeLog("webapp", "developer webapp blocked in packaged build", { packaged: true }, "warn")
    await dialog.showMessageBox({
      type: "info",
      title: nativeT("desktop.webapp.error.packaged.title"),
      message: nativeT("desktop.webapp.error.packaged.message"),
      detail: nativeT("desktop.webapp.error.packaged.detail"),
      buttons: ["OK"],
    })
    return
  }

  const root = repoRoot()
  const opencodeCwd = join(root, "packages", "opencode")
  const appCwd = join(root, "packages", "app")
  if (!existsSync(join(opencodeCwd, "src", "index.ts")) || !existsSync(join(appCwd, "package.json"))) {
    writeLog("webapp", "developer webapp source not found", { root, opencodeCwd, appCwd }, "error")
    await dialog.showMessageBox({
      type: "error",
      title: nativeT("desktop.webapp.error.missingRoot.title"),
      message: nativeT("desktop.webapp.error.missingRoot.message"),
      detail: nativeT("desktop.webapp.error.missingRoot.detail", { root }),
      buttons: ["OK"],
    })
    return
  }

  const backendRunning = await isPortInUse(WEB_BACKEND_PORT)
  if (!backendRunning) {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      NOVACODE_CLIENT: "web",
    }
    if (sharedSessions) {
      const xdgData = join(app.getPath("home"), ".local", "share", "novacode")
      env.NOVACODE_DB = join(xdgData, "novacode-dev.db")
    }

    writeLog("webapp", "spawning web backend", { port: WEB_BACKEND_PORT, cwd: opencodeCwd, sharedSessions })
    try {
      webBackendProcess = spawn("bun", ["run", "--conditions=browser", "./src/index.ts", "serve", "--port", String(WEB_BACKEND_PORT)], {
        cwd: opencodeCwd,
        env,
        stdio: "pipe",
        detached: true,
        shell: process.platform === "win32",
      })
    } catch (error) {
      writeLog("webapp", "failed to spawn web backend", { error: String(error) }, "error")
      await dialog.showMessageBox({
        type: "error",
        title: nativeT("desktop.webapp.error.spawnFailed.title"),
        message: nativeT("desktop.webapp.error.spawnFailed.message", { target: "backend" }),
        detail: nativeT("desktop.webapp.error.spawnFailed.detail", { error: String(error) }),
        buttons: ["OK"],
      })
      return
    }
    if (webBackendProcess) {
      webBackendProcess.on("error", (error) => {
        writeLog("webapp", "web backend spawn error", { error: String(error) }, "error")
        dialog.showMessageBox({
          type: "error",
          title: nativeT("desktop.webapp.error.spawnFailed.title"),
          message: nativeT("desktop.webapp.error.spawnFailed.message", { target: "backend" }),
          detail: nativeT("desktop.webapp.error.spawnFailed.detail", { error: String(error) }),
          buttons: ["OK"],
        })
      })
      webBackendProcess.stderr?.on("data", (chunk: Buffer) => writeLog("webapp", "backend stderr", { message: chunk.toString().slice(0, 2000) }, "warn"))
      webBackendProcess.stdout?.on("data", (chunk: Buffer) => writeLog("webapp", "backend stdout", { message: chunk.toString().slice(0, 2000) }))
      webBackendProcess.unref()
    }

    const ready = await waitForPort(WEB_BACKEND_PORT)
    if (!ready) {
      writeLog("webapp", "web backend did not become ready", { port: WEB_BACKEND_PORT }, "error")
      await dialog.showMessageBox({
        type: "error",
        title: nativeT("desktop.webapp.error.timeout.title"),
        message: nativeT("desktop.webapp.error.timeout.message", { target: "backend", timeout: 15 }),
        detail: nativeT("desktop.webapp.error.timeout.detail", { port: WEB_BACKEND_PORT }),
        buttons: ["OK"],
      })
      return
    }
  } else {
    writeLog("webapp", "web backend already running", { port: WEB_BACKEND_PORT })
  }

  const appRunning = await isPortInUse(WEB_APP_PORT)
  if (!appRunning) {
    writeLog("webapp", "spawning web app", { port: WEB_APP_PORT, cwd: appCwd })
    try {
      webAppProcess = spawn("bun", ["run", "dev"], {
        cwd: appCwd,
        stdio: "pipe",
        detached: true,
        shell: process.platform === "win32",
      })
    } catch (error) {
      writeLog("webapp", "failed to spawn web app", { error: String(error) }, "error")
      await dialog.showMessageBox({
        type: "error",
        title: nativeT("desktop.webapp.error.spawnFailed.title"),
        message: nativeT("desktop.webapp.error.spawnFailed.message", { target: "web app" }),
        detail: nativeT("desktop.webapp.error.spawnFailed.detail", { error: String(error) }),
        buttons: ["OK"],
      })
      return
    }
    if (webAppProcess) {
      webAppProcess.on("error", (error) => {
        writeLog("webapp", "web app spawn error", { error: String(error) }, "error")
        dialog.showMessageBox({
          type: "error",
          title: nativeT("desktop.webapp.error.spawnFailed.title"),
          message: nativeT("desktop.webapp.error.spawnFailed.message", { target: "web app" }),
          detail: nativeT("desktop.webapp.error.spawnFailed.detail", { error: String(error) }),
          buttons: ["OK"],
        })
      })
      webAppProcess.stderr?.on("data", (chunk: Buffer) => writeLog("webapp", "app stderr", { message: chunk.toString().slice(0, 2000) }, "warn"))
      webAppProcess.stdout?.on("data", (chunk: Buffer) => writeLog("webapp", "app stdout", { message: chunk.toString().slice(0, 2000) }))
      webAppProcess.unref()
    }

    const ready = await waitForPort(WEB_APP_PORT)
    if (!ready) {
      writeLog("webapp", "web app did not become ready", { port: WEB_APP_PORT }, "error")
      await dialog.showMessageBox({
        type: "error",
        title: nativeT("desktop.webapp.error.timeout.title"),
        message: nativeT("desktop.webapp.error.timeout.message", { target: "web app", timeout: 15 }),
        detail: nativeT("desktop.webapp.error.timeout.detail", { port: WEB_APP_PORT }),
        buttons: ["OK"],
      })
      return
    }
  } else {
    writeLog("webapp", "web app already running", { port: WEB_APP_PORT })
  }

  writeLog("webapp", "opening web app", { url: `http://localhost:${WEB_APP_PORT}` })
  await shell.openExternal(`http://localhost:${WEB_APP_PORT}`)
}

function killByPid(pid: number) {
  if (!pid) return
  if (process.platform === "win32") {
    exec(`taskkill /F /T /PID ${pid}`)
  } else {
    exec(`kill -9 -${pid}`)
  }
}

function stopWebApp() {
  const backendPid = webBackendProcess?.pid
  const appPid = webAppProcess?.pid
  // Kill via taskkill first (kills the full process tree), before clearing refs
  if (backendPid) {
    writeLog("webapp", "stopping web backend", { pid: backendPid })
    killByPid(backendPid)
  }
  if (appPid) {
    writeLog("webapp", "stopping web app", { pid: appPid })
    killByPid(appPid)
  }
  if (!backendPid && !appPid) writeLog("webapp", "stop webapp: no tracked processes", {}, "warn")
  webBackendProcess = null
  webAppProcess = null
}

export function cleanupWebAppProcesses() {
  stopWebApp()
}

export function runDesktopMenuAction(
  win: BrowserWindow | null,
  action: DesktopMenuAction,
  handlers: DesktopMenuActionHandlers = {},
) {
  switch (action) {
    case "app.checkForUpdates":
      handlers.checkForUpdates?.()
      return
    case "app.relaunch":
      handlers.relaunch?.()
      return
    case "window.new":
      createMainWindow()
      return
    case "window.close":
      win?.close()
      return
    case "window.minimize":
      win?.minimize()
      return
    case "window.toggleMaximize":
      if (win?.isMaximized()) {
        win.unmaximize()
        return
      }
      win?.maximize()
      return
    case "view.reload":
      win?.reload()
      return
    case "view.toggleDevTools":
      win?.webContents.toggleDevTools()
      return
    case "view.resetZoom":
      setZoom(win, 1)
      return
    case "view.zoomIn":
      setZoom(win, (win?.webContents.getZoomFactor() ?? 1) + 0.2)
      return
    case "view.zoomOut":
      setZoom(win, (win?.webContents.getZoomFactor() ?? 1) - 0.2)
      return
    case "view.toggleFullscreen":
      win?.setFullScreen(!win.isFullScreen())
      return
    case "edit.undo":
      win?.webContents.undo()
      return
    case "edit.redo":
      win?.webContents.redo()
      return
    case "edit.cut":
      win?.webContents.cut()
      return
    case "edit.copy":
      win?.webContents.copy()
      return
    case "edit.paste":
      win?.webContents.paste()
      return
    case "edit.delete":
      win?.webContents.delete()
      return
    case "edit.selectAll":
      win?.webContents.selectAll()
      return
    case "dev.webapp.shared":
      void startWebApp(true)
      return
    case "dev.webapp.standalone":
      void startWebApp(false)
      return
    case "dev.webapp.stop":
      stopWebApp()
      return
  }
}

function setZoom(win: BrowserWindow | null, value: number) {
  if (!win) return
  win.webContents.setZoomFactor(Math.min(Math.max(value, 0.2), 10))
  updateTitlebar(win)
}
