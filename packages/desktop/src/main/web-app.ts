import { shell } from "electron"
import type { ServerReadyData } from "../preload/types"
import { write as writeLog } from "./logging"

/**
 * Open the desktop's own sessions in the user's browser.
 *
 * This replaces the old developer web-app launcher, which spawned a repo
 * dev server with bun and was blocked in packaged builds. The desktop
 * already runs a sidecar server that serves the web UI itself (embedded
 * UI, or the upstream UI as fallback), so there is nothing else to start:
 * just open the sidecar URL, with the sidecar credentials passed as the
 * ?auth_token= query the web UI already understands (see app entry.tsx,
 * which reads auth_token, stores it as the local server, and clears it
 * from the address bar). The password never leaves the main process.
 */
export async function openWebApp(server: ServerReadyData): Promise<boolean> {
  try {
    const base = server.url.replace(/\/+$/, "")
    const url =
      server.username && server.password
        ? `${base}/?auth_token=${Buffer.from(`${server.username}:${server.password}`).toString("base64")}`
        : `${base}/`
    writeLog("webapp", "opening web app", { url: base })
    await shell.openExternal(url)
    return true
  } catch (error) {
    writeLog("webapp", "failed to open web app", { error: String(error) }, "error")
    return false
  }
}
