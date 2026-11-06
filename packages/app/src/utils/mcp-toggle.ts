import type { McpServer } from "@novacode-ai/client/promise"

/** The per-server MCP statuses for one directory, as the sync store holds them. */
export type McpStatusMap = Record<string, McpServer["status"] | undefined>

/**
 * Names of the servers that are currently connected. These are the ones the
 * global MCP switch turns off — toggling any other status would do the wrong
 * thing (a failed server would reconnect, a needs-auth server would start an
 * auth flow), so only connected servers are ever disconnected.
 */
export function connectedMcpServerNames(statuses: McpStatusMap): string[] {
  return Object.entries(statuses)
    .filter(([, status]) => status?.status === "connected")
    .map(([name]) => name)
}

/**
 * Of the servers the global switch turned off, the ones it can turn back on:
 * currently disabled or failed. A connected one is already back, and pending
 * or needs-auth ones must not be touched.
 */
export function reconnectableMcpServerNames(disabledByToggle: string[], statuses: McpStatusMap): string[] {
  return disabledByToggle.filter((name) => {
    const status = statuses[name]?.status
    return status === "disabled" || status === "failed"
  })
}

/** Of the servers the global switch turned off, the ones already back on. */
export function reconnectedMcpServerNames(disabledByToggle: string[], statuses: McpStatusMap): string[] {
  return disabledByToggle.filter((name) => statuses[name]?.status === "connected")
}
