import { Button } from "@novacode-ai/ui/button"
import { Switch } from "@novacode-ai/ui/switch"
import { Tag } from "@novacode-ai/ui/v2/badge-v2"
import { Icon as IconV2 } from "@novacode-ai/ui/v2/icon"
import { IconButtonV2 } from "@novacode-ai/ui/v2/icon-button-v2"
import { TextInputV2 } from "@novacode-ai/ui/v2/text-input-v2"
import { useDialog } from "@novacode-ai/ui/context/dialog"
import fuzzysort from "fuzzysort"
import { type Component, For, Show, createEffect, createMemo, createResource, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { ServerRowMenu } from "@/components/server/server-row-menu"
import { ServerHealthIndicator } from "@/components/server/server-row"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { ServerConnection, serverName } from "@/context/server"
import { useServerManagementController } from "../dialog-select-server"
import { DialogServerV2 } from "./dialog-server-v2"
import { SettingsListV2 } from "./parts/list"
import { AddServerMenu, isWslServer, useFilteredWslServers, WslServerSettings } from "@/wsl/settings"
import { useCheckServerHealth } from "@/utils/server-health"
import "./settings-v2.css"

function getWebServerUrl() {
  try {
    if (location.hostname.includes("novacode.ai") || location.hostname.includes("opencode.ai"))
      return "http://localhost:4096"
    if (import.meta.env.DEV)
      return `http://${import.meta.env.VITE_NOVACODE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_NOVACODE_SERVER_PORT ?? "4096"}`
    return location.origin
  } catch {
    return location.origin
  }
}

async function fetchDesktopDiscovery(serverUrl: string): Promise<{ url: string; username: string; password: string } | null> {
  const candidates = (() => {
    const urls = new Set<string>([serverUrl])
    // LAN fallback: if we used location.hostname, also try localhost for same-machine dev
    try {
      const parsed = new URL(serverUrl)
      if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
        urls.add(`http://localhost:${parsed.port}/`)
        urls.add(`http://127.0.0.1:${parsed.port}/`)
      }
      // Also try the page origin itself (covers prod where server is same origin)
      urls.add(location.origin)
    } catch {}
    return [...urls].map((u) => u.replace(/\/+$/, ""))
  })()
  for (const base of candidates) {
    try {
      const resp = await fetch(`${base}/global/desktop-discovery`)
      if (!resp.ok) continue
      const data = (await resp.json()) as {
        available: boolean
        discovery?: { url: string; username: string; password: string }
      }
      if (data.available && data.discovery) return data.discovery
    } catch {}
  }
  return null
}

function DesktopSharingToggle() {
  const language = useLanguage()
  const [enabled, setEnabled] = createSignal<boolean | undefined>(undefined)
  const [busy, setBusy] = createSignal(false)

  createEffect(() => {
    const api = (window as unknown as { api?: { getDesktopSharingEnabled?: () => Promise<boolean> } }).api
    if (!api?.getDesktopSharingEnabled) return
    void api.getDesktopSharingEnabled().then(setEnabled)
  })

  const toggle = async (next: boolean) => {
    setBusy(true)
    try {
      const api = (window as unknown as { api?: { setDesktopSharingEnabled?: (v: boolean) => Promise<void> } }).api
      if (api?.setDesktopSharingEnabled) await api.setDesktopSharingEnabled(next)
      setEnabled(next)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="settings-v2-servers-desktop-section" data-testid="desktop-sharing-toggle">
      <div class="settings-v2-servers-desktop-header">
        <div class="settings-v2-servers-desktop-info">
          <IconV2 name="monitor" size="large" class="text-v2-icon-icon" />
          <div>
            <span class="settings-v2-servers-desktop-title">{language.t("dialog.server.desktop.shareTitle") ?? "Share with web app"}</span>
            <span class="settings-v2-servers-desktop-desc">{language.t("dialog.server.desktop.shareDescription") ?? "Allow the browser web app on this machine to discover and connect to this desktop’s sessions"}</span>
          </div>
        </div>
        <Show when={enabled() !== undefined} fallback={<Tag class="text-v2-text-muted">{language.t("common.loading")}</Tag>}>
          <Switch checked={enabled()!} disabled={busy()} onChange={toggle} />
        </Show>
      </div>
      <Show when={enabled() === false}>
        <div class="settings-v2-servers-desktop-hint text-12-regular text-text-weak">
          {language.t("dialog.server.desktop.shareOffHint") ?? "Sharing is off — the web app will show “Desktop app not running”."}
        </div>
      </Show>
      <Show when={enabled() === true}>
        <div class="settings-v2-servers-desktop-hint text-12-regular text-text-weak">
          {language.t("dialog.server.desktop.shareOnHint") ?? "Sharing is on — open the web app at http://localhost:4444 or your LAN IP (e.g. http://192.168.1.25:4444) and it will show Connected."}
        </div>
      </Show>
    </div>
  )
}

function DesktopConnectionSection() {
  const language = useLanguage()
  const server = useServer()
  const platform = usePlatform()
  const navigate = useNavigate()
  const checkHealth = useCheckServerHealth()
  const isWeb = () => platform.platform === "web"
  const currentUrl = getWebServerUrl()
  const webKey = ServerConnection.Key.make(currentUrl)

  // Always fetch – on desktop this will hit the sidecar's own discovery endpoint
  // (which returns its own url), on web it hits the web server which proxies the
  // desktop file. Keeping the fetch unconditional makes the section visible in
  // both contexts and avoids the "nothing in Servers" report.
  const [discovery, { refetch }] = createResource(() => currentUrl, fetchDesktopDiscovery)

  const desktopKey = createMemo(() => {
    const d = discovery()
    return d ? ServerConnection.Key.make(d.url) : undefined
  })

  const isConnected = createMemo(() => {
    const key = desktopKey()
    return key ? server.list.some((s) => ServerConnection.key(s) === key) : false
  })

  const isActiveDesktop = createMemo(() => {
    const key = desktopKey()
    return !!key && server.key === key
  })

  const handleConnect = async () => {
    const d = discovery()
    if (!d) return
    const healthy = await checkHealth({ url: d.url, username: d.username, password: d.password }).then(
      (r) => r.healthy,
      () => false,
    )
    if (!healthy) {
      await refetch()
      return
    }
    // Deduplicate: desktop sidecar gets a new random port on each restart,
    // so old URL entries would otherwise accumulate as duplicate "Desktop App" rows.
    const newKey = ServerConnection.Key.make(d.url)
    for (const s of [...server.list]) {
      if (ServerConnection.key(s) === newKey) continue
      if (s.displayName === language.t("dialog.server.desktop")) {
        server.remove(ServerConnection.key(s))
      }
    }
    const conn: ServerConnection.Http = {
      type: "http",
      displayName: language.t("dialog.server.desktop"),
      http: { url: d.url, username: d.username, password: d.password },
    }
    server.add(conn)
    navigate("/")
  }

  // Cleanup stale duplicates when desktop restarts with a new random port.
  createEffect(() => {
    const d = discovery()
    if (!d) return
    // Track server.list so effect re-runs when list changes
    void server.list.length
    const newKey = ServerConnection.Key.make(d.url)
    for (const s of [...server.list]) {
      if (ServerConnection.key(s) === newKey) continue
      if (s.displayName === language.t("dialog.server.desktop")) {
        server.remove(ServerConnection.key(s))
      }
    }
  })

  const handleSwitchToDesktop = () => {
    const key = desktopKey()
    if (!key) return
    if (!isConnected()) {
      void handleConnect()
      return
    }
    server.setActive(key)
    navigate("/")
  }

  const handleSwitchToWeb = () => {
    // Web server is always in props.servers (injected via entry.tsx), so
    // setting active to webKey works even if it is not in persisted list.
    server.setActive(webKey)
    navigate("/")
  }

  const handleDisconnect = () => {
    const key = desktopKey()
    if (!key) return
    // If currently active on desktop, fall back to web before removing
    if (server.key === key) server.setActive(webKey)
    server.remove(key)
    navigate("/")
  }

  if (!isWeb()) {
    return <DesktopSharingToggle />
  }

  return (
    <div class="settings-v2-servers-desktop-section" data-testid="desktop-session-switch">
      <div class="settings-v2-servers-desktop-header">
        <div class="settings-v2-servers-desktop-info">
          <IconV2 name="monitor" size="large" class="text-v2-icon-icon" />
          <div>
            <span class="settings-v2-servers-desktop-title">{language.t("dialog.server.desktop")}</span>
            <span class="settings-v2-servers-desktop-desc">{language.t("dialog.server.desktop.description")}</span>
          </div>
        </div>
        <Show
          when={!discovery.loading}
          fallback={<Tag class="text-v2-text-muted">{language.t("common.loading")}</Tag>}
        >
          <Show
            when={discovery()}
            fallback={
              <div class="flex items-center gap-2">
                <Tag class="text-v2-text-muted">{language.t("dialog.server.desktop.unavailable")}</Tag>
                <Button variant="ghost" size="small" onClick={() => void refetch()} data-testid="desktop-retry">
                  {language.t("common.retry") ?? "Retry"}
                </Button>
                <Show when={isWeb() && isActiveDesktop()}>
                  <Button variant="secondary" size="small" onClick={handleSwitchToWeb}>
                    {language.t("dialog.server.desktop.switchToWeb")}
                  </Button>
                </Show>
              </div>
            }
          >
            <Show
              when={isConnected()}
              fallback={
                <Button variant="primary" size="small" onClick={handleConnect} data-testid="desktop-connect">
                  {language.t("dialog.server.desktop.connect")}
                </Button>
              }
            >
              <div class="flex items-center gap-2">
                <Show when={isActiveDesktop()}>
                  <Tag>{language.t("dialog.server.desktop.connected")}</Tag>
                  <Button variant="secondary" size="small" onClick={handleSwitchToWeb} data-testid="desktop-switch-web">
                    {language.t("dialog.server.desktop.switchToWeb")}
                  </Button>
                  <Button variant="ghost" size="small" onClick={handleDisconnect} data-testid="desktop-disconnect">
                    {language.t("dialog.server.desktop.disconnect")}
                  </Button>
                </Show>
                <Show when={!isActiveDesktop()}>
                  <Tag>{language.t("dialog.server.desktop.connected")}</Tag>
                  <Button variant="primary" size="small" onClick={handleSwitchToDesktop} data-testid="desktop-switch-desktop">
                    {language.t("dialog.server.desktop.switchToDesktop")}
                  </Button>
                  <Button variant="ghost" size="small" onClick={handleDisconnect} data-testid="desktop-disconnect">
                    {language.t("dialog.server.desktop.disconnect")}
                  </Button>
                </Show>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
      <Show when={isConnected() && isActiveDesktop()}>
        <div class="settings-v2-servers-desktop-hint text-12-regular text-text-weak">
          {language.t("dialog.server.desktop.activeHint")}
        </div>
      </Show>
      <Show when={isConnected() && !isActiveDesktop()}>
        <div class="settings-v2-servers-desktop-hint text-12-regular text-text-weak">
          {language.t("dialog.server.desktop.webActiveHint")}
        </div>
      </Show>
    </div>
  )
}

export const SettingsServersV2: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const controller = useServerManagementController()
  const [store, setStore] = createStore({ filter: "" })
  const wslServers = useFilteredWslServers(() => store.filter)

  const showSearch = createMemo(
    () => controller.sortedItems().filter((item) => !isWslServer(item)).length + wslServers().length > 1,
  )

  const filtered = createMemo(() => {
    const items = controller.sortedItems().filter((item) => !isWslServer(item))
    const query = store.filter.trim()
    if (!query) return items
    return fuzzysort
      .go(query, items, {
        keys: [(item) => serverName(item), (item) => item.http.url],
      })
      .map((result) => result.obj)
  })

  const openAdd = () => {
    dialog.push(() => <DialogServerV2 mode="add" />)
  }

  const openEdit = (server: ServerConnection.Http) => {
    dialog.push(() => <DialogServerV2 mode="edit" server={server} />)
  }

  return (
    <>
      <div
        class="settings-v2-tab-header settings-v2-servers-header"
        classList={{ "settings-v2-tab-header--stacked": showSearch() }}
      >
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("status.popover.tab.servers")}</h2>
          <AddServerMenu onAddServer={openAdd} />
        </div>
        <Show when={showSearch()}>
          <div class="settings-v2-tab-search">
            <TextInputV2
              type="search"
              appearance="base"
              value={store.filter}
              onInput={(event) => setStore("filter", event.currentTarget.value)}
              placeholder={language.t("dialog.server.search.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("dialog.server.search.placeholder")}
            />
            <Show when={store.filter}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                class="settings-v2-tab-search-clear"
                icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
                onClick={() => setStore("filter", "")}
              />
            </Show>
          </div>
        </Show>
      </div>

      <div class="settings-v2-tab-body settings-v2-servers">
        <DesktopConnectionSection />

        <Show
          when={filtered().length > 0 || wslServers().length > 0}
          fallback={
            <div class="settings-v2-servers-status">
              <span>{store.filter ? language.t("palette.empty") : language.t("dialog.server.empty")}</span>
              <Show when={store.filter}>
                <span class="settings-v2-servers-status-filter">&quot;{store.filter}&quot;</span>
              </Show>
            </div>
          }
        >
          <SettingsListV2>
            <WslServerSettings controller={controller} servers={wslServers} />
            <For each={filtered()}>
              {(item) => {
                const key = ServerConnection.key(item)
                const health = () => controller.status()[key]
                const isDefault = () => controller.defaultKey() === key
                return (
                  <div class="settings-v2-servers-row">
                    <div class="settings-v2-servers-lead">
                      <ServerHealthIndicator health={health()} />
                      <div class="settings-v2-servers-copy">
                        <span class="settings-v2-servers-name">{serverName(item)}</span>
                        <span class="settings-v2-servers-meta">
                          <Show when={health()?.version}>v{health()?.version}</Show>
                          <Show when={health()?.version && item.type === "http"}> • </Show>
                          <Show
                            when={item.type === "http" && item.http.username}
                            fallback={<Show when={item.type === "http"}>{language.t("server.row.noUsername")}</Show>}
                          >
                            {item.http.username}
                          </Show>
                        </span>
                      </div>
                    </div>
                    <div class="settings-v2-servers-actions">
                      <Show when={controller.canDefault() && isDefault()}>
                        <Tag>{language.t("dialog.server.status.default")}</Tag>
                      </Show>
                      <ServerRowMenu server={item} controller={controller} onEdit={openEdit} />
                    </div>
                  </div>
                )
              }}
            </For>
          </SettingsListV2>
        </Show>
      </div>
    </>
  )
}
