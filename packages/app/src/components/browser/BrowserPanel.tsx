import { createEffect, createMemo, For, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { IconButton } from "@novacode-ai/ui/icon-button"
import { Tooltip } from "@novacode-ai/ui/tooltip"
import { DropdownMenu } from "@novacode-ai/ui/dropdown-menu"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { BrowserTabs } from "./BrowserTabs"
import { BrowserAddressBar, GlobeIcon } from "./BrowserAddressBar"
import { BrowserCommentEditor } from "./BrowserCommentEditor"
import { createBrowserApi, type BrowserApi, type BrowserPanelState } from "./api"

const POLL_MS = 2000
// The driver's fixed headless viewport; screenshot clicks scale into it.
const VIEWPORT_WIDTH = 1280
const VIEWPORT_HEIGHT = 800

const isBlank = (url: string | undefined) => !url || url === "about:blank"

export function BrowserPanel() {
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()

  const api: () => BrowserApi = createMemo(() => {
    const connection = serverSDK()
    return createBrowserApi({ url: sdk().url, server: connection.server, directory: sdk().directory })
  })

  const [store, setStore] = createStore({
    panel: undefined as BrowserPanelState | undefined,
    loading: true,
    error: undefined as string | undefined,
    inspecting: false,
    comment: undefined as { x: number; y: number; ref: string } | undefined,
  })

  let container: HTMLDivElement | undefined
  let img: HTMLImageElement | undefined
  let addressApi: { focus: () => void } | undefined

  const focusedTab = createMemo(() => {
    const panel = store.panel
    if (!panel) return undefined
    return panel.tabs.find((tab) => tab.id === panel.focusedTabID)
  })
  const failed = () => !!focusedTab()?.loadError
  const empty = () => !store.loading && !failed() && isBlank(focusedTab()?.url)
  const screenshotSrc = createMemo(() => {
    const shot = store.panel?.screenshot
    return shot ? `data:${shot.mime};base64,${shot.data}` : undefined
  })

  const refresh = async () => {
    try {
      const panel = await api().state()
      setStore({ panel, error: undefined, loading: false })
    } catch (error) {
      setStore({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  }

  const act = async (run: (api: BrowserApi) => Promise<BrowserPanelState>) => {
    try {
      const panel = await run(api())
      setStore({ panel, error: undefined, loading: false })
    } catch (error) {
      showToast({ title: language.t("common.requestFailed") })
      setStore({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  }

  onMount(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), POLL_MS)
    onCleanup(() => window.clearInterval(timer))
    const stop = makeEventListener(window, "keydown", (event: KeyboardEvent) => {
      if (event.key === "Escape" && store.inspecting) setStore("inspecting", false)
    })
    onCleanup(stop)
  })

  // A freshly opened blank tab starts in its address field.
  createEffect(
    on(
      () => focusedTab()?.id,
      (id, previous) => {
        if (id && id !== previous && isBlank(focusedTab()?.url)) addressApi?.focus()
      },
    ),
  )

  const go = (url: string) => {
    const tab = focusedTab()
    if (!tab) return act((api) => api.open(url))
    return act((api) => api.navigate(tab.id, url))
  }

  const withTab = (run: (api: BrowserApi, tabID: string) => Promise<BrowserPanelState>) => {
    const tab = focusedTab()
    if (!tab) return Promise.resolve()
    return act((api) => run(api, tab.id))
  }

  const onScreenshotClick = async (event: MouseEvent) => {
    if (!store.inspecting) return
    const tab = focusedTab()
    if (!tab || !img || !container) return
    const rect = img.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const x = Math.round(((event.clientX - rect.left) / rect.width) * VIEWPORT_WIDTH)
    const y = Math.round(((event.clientY - rect.top) / rect.height) * VIEWPORT_HEIGHT)
    try {
      const { ref } = await api().pick(tab.id, x, y)
      if (!ref) {
        showToast({ title: language.t("browser.error.pick") })
        return
      }
      const box = container.getBoundingClientRect()
      setStore({
        inspecting: false,
        comment: { x: event.clientX - box.left, y: event.clientY - box.top, ref },
      })
    } catch {
      showToast({ title: language.t("browser.error.pick") })
    }
  }

  const insertIntoComposer = (text: string) => {
    const editable = document.querySelector('[data-component="prompt-input"][contenteditable="true"]')
    if (editable instanceof HTMLElement) {
      editable.focus()
      // Chromium turns this into beforeinput/input events the editor handles.
      if (document.execCommand("insertText", false, text)) {
        showToast({ title: language.t("browser.comment.inserted") })
        return
      }
    }
    void navigator.clipboard.writeText(text).then(
      () => showToast({ title: language.t("browser.comment.copied") }),
      () => showToast({ title: language.t("common.requestFailed") }),
    )
  }

  const submitComment = (draft: string) => {
    const comment = store.comment
    const tab = focusedTab()
    setStore("comment", undefined)
    if (!comment || !tab) return
    insertIntoComposer(`[browser] ${tab.title || tab.url} (element ${comment.ref}): ${draft}`)
  }

  const copyLink = () => {
    const url = focusedTab()?.url
    if (!url) return
    void navigator.clipboard.writeText(url).then(
      () => showToast({ title: language.t("common.copied") }),
      () => showToast({ title: language.t("common.requestFailed") }),
    )
  }

  return (
    <aside id="browser-panel" class="relative size-full min-w-0 overflow-hidden bg-v2-background-bg-base flex flex-col">
      <BrowserTabs
        tabs={store.panel?.tabs ?? []}
        focusedTabID={store.panel?.focusedTabID ?? null}
        onFocus={(tabID) => void withTab((api, id) => api.focus(tabID))}
        onClose={(tabID) => void act((api) => api.close(tabID))}
        onNew={() => void act((api) => api.open())}
      />
      <div
        data-component="browser-bar"
        class="h-11 shrink-0 flex items-center gap-1.5 px-2 border-b border-v2-border-border-muted"
      >
        <div class="flex shrink-0 items-center">
          <Tooltip value={language.t("common.goBack")} placement="top">
            <IconButton
              icon="arrow-left"
              variant="ghost"
              class="h-7 w-7"
              disabled={!focusedTab()}
              onClick={() => void withTab((api, id) => api.back(id))}
              aria-label={language.t("common.goBack")}
            />
          </Tooltip>
          <Tooltip value={language.t("common.goForward")} placement="top">
            <IconButton
              icon="arrow-right"
              variant="ghost"
              class="h-7 w-7"
              disabled={!focusedTab()}
              onClick={() => void withTab((api, id) => api.forward(id))}
              aria-label={language.t("common.goForward")}
            />
          </Tooltip>
          <Tooltip
            value={language.t(focusedTab()?.loading ? "browser.action.stop" : "browser.action.reload")}
            placement="top"
          >
            <IconButton
              icon={focusedTab()?.loading ? "stop" : "reset"}
              variant="ghost"
              class="h-7 w-7"
              disabled={!focusedTab()}
              onClick={() => void withTab((api, id) => (focusedTab()?.loading ? api.stop(id) : api.reload(id)))}
              aria-label={language.t(focusedTab()?.loading ? "browser.action.stop" : "browser.action.reload")}
            />
          </Tooltip>
        </div>
        <BrowserAddressBar
          url={focusedTab()?.url ?? ""}
          recent={store.panel?.recent ?? []}
          disabled={!focusedTab()}
          onNavigate={(url) => void go(url)}
          apiRef={(exposed) => (addressApi = exposed ?? undefined)}
        />
        <div class="flex shrink-0 items-center">
          <Tooltip
            value={language.t(store.inspecting ? "browser.action.inspect.active" : "browser.action.inspect")}
            placement="top"
          >
            <IconButton
              icon="window-cursor"
              variant="ghost"
              class="h-7 w-7"
              data-action="browser-inspect"
              disabled={!focusedTab() || isBlank(focusedTab()?.url) || failed()}
              aria-pressed={store.inspecting}
              aria-label={language.t("browser.action.inspect")}
              onClick={() => {
                setStore({ inspecting: !store.inspecting, comment: undefined })
              }}
              classList={{ "text-v2-icon-icon-accent": store.inspecting }}
            />
          </Tooltip>
          <DropdownMenu>
            <DropdownMenu.Trigger
              as={IconButton}
              icon="menu"
              variant="ghost"
              class="h-7 w-7"
              disabled={!focusedTab()}
              aria-label={language.t("browser.menu.options")}
            />
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="mt-1 min-w-52">
                <DropdownMenu.Item
                  disabled={!focusedTab()?.url || isBlank(focusedTab()?.url)}
                  onSelect={copyLink}
                >
                  <DropdownMenu.ItemLabel>{language.t("browser.menu.copyLink")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  disabled={!focusedTab()?.url || isBlank(focusedTab()?.url)}
                  onSelect={() => {
                    const url = focusedTab()?.url
                    if (url) window.open(url, "_blank", "noopener")
                  }}
                >
                  <DropdownMenu.ItemLabel>{language.t("browser.menu.openExternal")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
                <DropdownMenu.Separator />
                <DropdownMenu.Item
                  disabled={(store.panel?.recent.length ?? 0) === 0}
                  onSelect={() => void act((api) => api.clearHistory())}
                >
                  <DropdownMenu.ItemLabel>{language.t("browser.menu.clearHistory")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        </div>
      </div>
      <div
        ref={container}
        data-component="browser-content"
        class="relative min-h-0 flex-1 bg-v2-background-bg-base flex items-center justify-center overflow-hidden"
      >
        <Show when={store.loading && !store.panel}>
          <div class="flex items-center gap-2 text-13-regular text-v2-text-text-muted" role="status">
            <span class="size-4 animate-spin rounded-full border-2 border-v2-border-border-strong border-t-transparent" />
            {language.t("common.loading")}
          </div>
        </Show>
        <Show when={store.error && !store.panel && !store.loading}>
          <div class="flex max-w-72 flex-col items-center gap-2 px-6 text-center">
            <GlobeIcon class="size-10 text-v2-icon-icon-muted" />
            <div class="text-13-regular font-[550] text-v2-text-text-base">{language.t("browser.error.load")}</div>
            <div class="text-12-regular text-v2-text-text-muted">{store.error}</div>
          </div>
        </Show>
        <Show when={empty()}>
          <div dir="auto" class="size-full overflow-y-auto">
            <div class="relative flex min-h-full flex-col items-center px-6 pb-16 pt-20 text-center">
              <GlobeIcon class="size-10 text-v2-icon-icon-muted" />
              <div class="mt-4 flex flex-col gap-1.5">
                <div class="text-13-regular font-[550] text-v2-text-text-base">
                  {language.t("browser.home.title")}
                </div>
                <div class="max-w-72 text-13-regular text-v2-text-text-muted">
                  {language.t("browser.home.description")}
                </div>
              </div>
              <Show when={(store.panel?.recent.length ?? 0) > 0}>
                <div class="mt-8 flex w-full max-w-96 flex-col gap-1.5 text-left">
                  <div class="px-1 text-12-regular text-v2-text-text-muted">
                    {language.t("browser.home.recent")}
                  </div>
                  <For each={store.panel?.recent ?? []}>
                    {(url) => (
                      <button
                        type="button"
                        onClick={() => void go(url)}
                        class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-12-regular text-v2-text-text-base hover:bg-v2-background-bg-subtle"
                      >
                        <GlobeIcon class="size-3.5 shrink-0 text-v2-icon-icon-muted" />
                        <span class="min-w-0 flex-1 truncate" dir="ltr">
                          {url}
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </div>
        </Show>
        <Show when={failed()}>
          <div class="flex max-w-72 flex-col items-center gap-2 px-6 text-center">
            <GlobeIcon class="size-10 text-v2-icon-icon-muted" />
            <div class="text-13-regular font-[550] text-v2-text-text-base">
              {language.t("browser.failed.title")}
            </div>
            <div class="text-13-regular text-v2-text-text-muted">{language.t("browser.failed.description")}</div>
          </div>
        </Show>
        <Show when={!empty() && !failed() && screenshotSrc()}>
          {(src) => (
            <img
              ref={img}
              src={src()}
              alt=""
              draggable={false}
              onClick={onScreenshotClick}
              class="max-h-full max-w-full object-contain select-none"
              classList={{ "cursor-crosshair": store.inspecting }}
            />
          )}
        </Show>
        <Show when={focusedTab()?.loading}>
          <div
            class="absolute end-3 top-3 flex items-center gap-1.5 rounded-full border border-v2-border-border-muted bg-v2-background-bg-base px-2 py-1 text-11-regular text-v2-text-text-muted shadow-sm"
            role="status"
          >
            <span class="size-3 animate-spin rounded-full border border-v2-border-border-strong border-t-transparent" />
            {language.t("common.loading")}
          </div>
        </Show>
        <Show when={store.inspecting}>
          <p class="sr-only" role="status">
            {language.t("browser.action.inspect")}
          </p>
        </Show>
        <Show when={store.comment}>
          {(comment) => (
            <div
              class="absolute inset-0 z-10"
              onClick={(event) => {
                if (event.target === event.currentTarget) setStore("comment", undefined)
              }}
            >
              <BrowserCommentEditor
                x={comment().x}
                y={comment().y}
                containerWidth={container?.clientWidth ?? 0}
                containerHeight={container?.clientHeight ?? 0}
                onSubmit={submitComment}
                onCancel={() => setStore("comment", undefined)}
              />
            </div>
          )}
        </Show>
      </div>
    </aside>
  )
}
