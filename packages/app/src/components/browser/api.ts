import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

export interface BrowserTabState {
  id: string
  url: string
  title: string
  loading: boolean
  loadError?: string
  canGoBack: boolean
  canGoForward: boolean
  generation: number
}

export interface BrowserPanelState {
  tabs: BrowserTabState[]
  focusedTabID: string | null
  recent: string[]
  screenshot?: { mime: string; data: string }
}

export interface BrowserApi {
  state: () => Promise<BrowserPanelState>
  open: (url?: string) => Promise<BrowserPanelState>
  navigate: (tabID: string, url: string) => Promise<BrowserPanelState>
  back: (tabID: string) => Promise<BrowserPanelState>
  forward: (tabID: string) => Promise<BrowserPanelState>
  reload: (tabID: string) => Promise<BrowserPanelState>
  stop: (tabID: string) => Promise<BrowserPanelState>
  focus: (tabID: string) => Promise<BrowserPanelState>
  close: (tabID: string) => Promise<BrowserPanelState>
  pick: (tabID: string, x: number, y: number) => Promise<{ ref?: string }>
  clearHistory: () => Promise<BrowserPanelState>
}

const readError = async (response: Response) => {
  const text = await response.text().catch(() => "")
  return text || `Request failed with status ${response.status}`
}

export function createBrowserApi(input: {
  url: string
  server: ServerConnection.Any
  directory: string
}): BrowserApi {
  const headers = () => {
    const out: Record<string, string> = { "Content-Type": "application/json" }
    // Every connection type carries credentials on `http` (sidecar and ssh
    // included), and the desktop sidecar always runs with a password — so
    // send the header whenever a password exists, not just for web "http"
    // connections, or every panel call is rejected as unauthorized.
    if (input.server.http.password) {
      out["Authorization"] = `Basic ${authTokenFromCredentials({
        username: input.server.http.username,
        password: input.server.http.password,
      })}`
    }
    // The workspace-routing middleware reads the directory from this header
    // (the generated SDK's fetch interceptor does the same for its calls).
    out["x-opencode-directory"] = encodeURIComponent(input.directory)
    return out
  }

  const call = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${input.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) throw new Error(await readError(response))
    return (await response.json()) as T
  }

  const tabAction = (path: string) => (tabID: string) => call<BrowserPanelState>(path, { tabID })

  return {
    state: () => call<BrowserPanelState>("/browser/state"),
    open: (url?: string) => call<BrowserPanelState>("/browser/open", { url }),
    navigate: (tabID: string, url: string) => call<BrowserPanelState>("/browser/navigate", { tabID, url }),
    back: tabAction("/browser/back"),
    forward: tabAction("/browser/forward"),
    reload: tabAction("/browser/reload"),
    stop: tabAction("/browser/stop"),
    focus: tabAction("/browser/focus"),
    close: tabAction("/browser/close"),
    pick: (tabID: string, x: number, y: number) =>
      call<{ ref?: string }>("/browser/pick", { tabID, x, y }),
    clearHistory: () => call<BrowserPanelState>("/browser/clear-history", {}),
  }
}

/** Normalize what the user typed into a navigable URL. */
export function resolveAddress(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return trimmed
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

/** Split a URL into scheme/host/rest for the emphasized-host display. */
export function addressParts(url: string): { scheme: string; host: string; rest: string } {
  try {
    const parsed = new URL(url)
    const scheme = `${parsed.protocol}//`
    const rest = url.slice(scheme.length + parsed.host.length)
    return { scheme, host: parsed.host, rest }
  } catch {
    return { scheme: "", host: "", rest: url }
  }
}
