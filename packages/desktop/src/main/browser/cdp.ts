import type { WebContents } from "electron"

/**
 * Minimal CDP session over webContents.debugger (the same mechanism
 * OpenCode's desktop browser uses). Attachment is lazy: the debugger is
 * attached on first command and stays attached for the tab's lifetime.
 */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  /** Subscribe to a CDP domain event (e.g. "Network.requestWillBeSent"). */
  on(method: string, listener: (params: Record<string, unknown>) => void): void
  off(method: string, listener: (params: Record<string, unknown>) => void): void
  isAttached(): boolean
  detach(): void
}

export function attachCdp(contents: WebContents): CdpSession {
  const dbg = contents.debugger
  const listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()
  let dispatching = false
  const ensureDispatch = () => {
    if (dispatching) return
    dispatching = true
    dbg.on("message", (_event, method, params) => {
      const set = listeners.get(method)
      if (!set) return
      for (const listener of [...set]) listener((params ?? {}) as Record<string, unknown>)
    })
  }
  return {
    send(method, params) {
      if (!dbg.isAttached()) dbg.attach("1.3")
      return dbg.sendCommand(method, params)
    },
    on(method, listener) {
      ensureDispatch()
      const set = listeners.get(method) ?? new Set()
      set.add(listener)
      listeners.set(method, set)
    },
    off(method, listener) {
      listeners.get(method)?.delete(listener)
    },
    isAttached: () => dbg.isAttached(),
    detach: () => {
      if (dbg.isAttached()) dbg.detach()
    },
  }
}
