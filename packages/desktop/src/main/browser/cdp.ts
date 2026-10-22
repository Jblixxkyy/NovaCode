import type { WebContents } from "electron"

/**
 * Minimal CDP session over webContents.debugger (the same mechanism
 * OpenCode's desktop browser uses). Attachment is lazy: the debugger is
 * attached on first command and stays attached for the tab's lifetime.
 */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  isAttached(): boolean
  detach(): void
}

export function attachCdp(contents: WebContents): CdpSession {
  const dbg = contents.debugger
  return {
    send(method, params) {
      if (!dbg.isAttached()) dbg.attach("1.3")
      return dbg.sendCommand(method, params)
    },
    isAttached: () => dbg.isAttached(),
    detach: () => {
      if (dbg.isAttached()) dbg.detach()
    },
  }
}
