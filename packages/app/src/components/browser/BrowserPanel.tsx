import { createEffect, createMemo, For, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { IconButton } from "@novacode-ai/ui/icon-button"
import { Tooltip } from "@novacode-ai/ui/tooltip"
import { DropdownMenu } from "@novacode-ai/ui/dropdown-menu"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { BrowserTabs } from "./BrowserTabs"
import { BrowserAddressBar, GlobeIcon } from "./BrowserAddressBar"
import { BrowserCommentEditor } from "./BrowserCommentEditor"
import { createBrowserApi, type BrowserApi, type BrowserPanelState } from "./api"

const POLL_MS = 2000
// Fallback page viewport (the Playwright driver's fixed size); the panel
// state reports the real one, which differs on desktop webview tabs.
const VIEWPORT_WIDTH = 1280
const VIEWPORT_HEIGHT = 800

const isBlank = (url: string | undefined) => !url || url === "about:blank"

export function BrowserPanel() {
  const language = useLanguage()
  const platform = usePlatform()
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
    comment: undefined as
      | { x: number; y: number; ref: string; box?: { x: number; y: number; width: number; height: number } }
      | undefined,
  })

  let container: HTMLDivElement | undefined
  let img: HTMLImageElement | undefined
  let embedEl: HTMLDivElement | undefined
  let addressApi: { focus: () => void } | undefined

  const focusedTab = createMemo(() => {
    const panel = store.panel
    if (!panel) return undefined
    return panel.tabs.find((tab) => tab.id === panel.focusedTabID)
  })
  const failed = () => !!focusedTab()?.loadError
  const empty = () => !store.loading && !failed() && isBlank(focusedTab()?.url)
  const viewport = createMemo(() => store.panel?.viewport ?? { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT })
  // Desktop embed mode: a desktop is attached, this platform can host the
  // native view, and the focused tab has a real page. The native webview
  // is then the live page; the screenshot flow only renders while frozen.
  const embedActive = createMemo(
    () =>
      !!platform.browserEmbed &&
      store.panel?.desktop === true &&
      !!focusedTab() &&
      !isBlank(focusedTab()?.url) &&
      !failed(),
  )
  // Frozen = native view hidden, still frame shown: while inspecting or
  // while the comment editor is open (the OpenCode freeze-to-still trick).
  const frozen = () => store.inspecting || !!store.comment
  const embedVisible = () => embedActive() && !frozen()
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

  // Auto-create a single blank tab whenever the panel has none, so the
  // address bar is usable without pressing the tab strip's "+" first.
  // Guarded so a create already in flight (or a failing create) cannot loop.
  let creatingTab = false
  const ensureTab = async () => {
    if (creatingTab) return
    creatingTab = true
    try {
      await act((api) => api.open())
    } finally {
      creatingTab = false
    }
  }
  createEffect(
    on(
      () => store.panel?.tabs.length,
      (count) => {
        if (count === 0) void ensureTab()
      },
    ),
  )

  onMount(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), POLL_MS)
    onCleanup(() => window.clearInterval(timer))
    const stop = makeEventListener(window, "keydown", (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      // Escape dismisses an open comment editor first, then inspect mode,
      // regardless of where focus currently is.
      if (store.comment) setStore("comment", undefined)
      else if (store.inspecting) setStore("inspecting", false)
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

  // Switching the focused tab ends picking and closes any open comment:
  // both belong to the tab they were started on. (Hiding the panel
  // unmounts it, which drops this state the same way.)
  createEffect(
    on(
      () => focusedTab()?.id,
      (id, previous) => {
        if (previous && id !== previous) setStore({ comment: undefined, inspecting: false })
      },
    ),
  )

  // Report the page area's rect to the desktop main process so it can
  // place the native webview there. Reads the reactive inputs (panel
  // desktop flag, focused tab, freeze state) so the effect re-reports on
  // every change; the ResizeObserver covers pure layout changes.
  const reportEmbed = () => {
    const embed = platform.browserEmbed
    if (!embed) return
    if (!embedActive() || !embedEl) {
      embed.clear()
      return
    }
    const rect = embedEl.getBoundingClientRect()
    embed.set({
      scope: sdk().directory,
      tabID: store.panel?.focusedTabID ?? null,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      visible: embedVisible(),
    })
  }
  createEffect(() => {
    void store.panel?.desktop
    void store.panel?.focusedTabID
    void store.inspecting
    void store.comment
    reportEmbed()
  })
  onMount(() => {
    if (!container || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => reportEmbed())
    observer.observe(container)
    onCleanup(() => observer.disconnect())
  })
  onCleanup(() => platform.browserEmbed?.clear())

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

  // Whether the open comment editor's draft is empty; a backdrop click
  // dismisses the editor only when it would not discard a typed draft.
  let commentDraftEmpty = true
  // Sequence number for pick requests: only the newest click may open the
  // comment editor, so a slow earlier pick cannot re-open it after Cancel.
  let pickSeq = 0
  const onScreenshotClick = async (event: MouseEvent) => {
    const tab = focusedTab()
    if (!tab || !img || !container) return
    // Coordinates are measured against the rendered <img> rect (which is the
    // letterboxed page image), then scaled into the serving viewport.
    const rect = img.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const x = Math.round(((event.clientX - rect.left) / rect.width) * viewport().width)
    const y = Math.round(((event.clientY - rect.top) / rect.height) * viewport().height)
    if (!store.inspecting) {
      // Normal click: forward it to the page so links/buttons work.
      await act((api) => api.click(tab.id, x, y))
      return
    }
    const seq = ++pickSeq
    try {
      const picked = await api().pick(tab.id, x, y)
      // Drop stale results: inspect mode was exited, a newer pick superseded
      // this one, or an editor is already open.
      if (seq !== pickSeq || !store.inspecting || store.comment) return
      if (!picked.ref) {
        showToast({ title: language.t("browser.error.pick") })
        return
      }
      const box = container.getBoundingClientRect()
      // The picked element's box, converted from driver viewport pixels
      // into the same container coordinates the editor is positioned in,
      // so the overlay can outline the actual element.
      const outline = picked.box
        ? {
            x: rect.left - box.left + (picked.box.x / viewport().width) * rect.width,
            y: rect.top - box.top + (picked.box.y / viewport().height) * rect.height,
            width: (picked.box.width / viewport().width) * rect.width,
            height: (picked.box.height / viewport().height) * rect.height,
          }
        : undefined
      commentDraftEmpty = true
      setStore({
        inspecting: false,
        comment: { x: event.clientX - box.left, y: event.clientY - box.top, ref: picked.ref, box: outline },
      })
    } catch {
      if (seq === pickSeq) showToast({ title: language.t("browser.error.pick") })
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
        onFocus={(tabID) => void act((api) => api.focus(tabID))}
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
              disabled={!focusedTab()?.canGoBack}
              onClick={() => void withTab((api, id) => api.back(id))}
              aria-label={language.t("common.goBack")}
            />
          </Tooltip>
          <Tooltip value={language.t("common.goForward")} placement="top">
            <IconButton
              icon="arrow-right"
              variant="ghost"
              class="h-7 w-7"
              disabled={!focusedTab()?.canGoForward}
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
          disabled={false}
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
                const entering = !store.inspecting
                setStore({ inspecting: entering, comment: undefined })
                // Entering inspect freezes the desktop view onto a still:
                // fetch it now instead of waiting for the next poll.
                if (entering) void refresh()
              }}
              classList={{ "text-v2-icon-icon-accent": store.inspecting }}
            />
          </Tooltip>
          <DropdownMenu
            onOpenChange={(open: boolean) => {
              // The menu and the comment editor are mutually exclusive: the
              // menu never opens over an open editor.
              if (open) setStore("comment", undefined)
            }}
          >
            <DropdownMenu.Trigger
              as={IconButton}
              icon="menu"
              variant="ghost"
              class="h-7 w-7"
              disabled={!focusedTab() || !!store.comment}
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
        <Show when={embedActive()}>
          <div ref={embedEl} data-component="browser-embed" class="absolute inset-0" />
        </Show>
        <Show when={(!embedActive() || frozen()) && !empty() && !failed() && screenshotSrc()}>
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
                // Click-away dismisses only an empty draft; a typed draft
                // survives until Cancel/submit or Escape.
                if (event.target === event.currentTarget && commentDraftEmpty) setStore("comment", undefined)
              }}
            >
              <Show when={comment().box}>
                {(box) => (
                  <div
                    class="pointer-events-none absolute rounded-sm border-2 border-v2-icon-icon-accent"
                    style={{
                      left: `${box().x}px`,
                      top: `${box().y}px`,
                      width: `${box().width}px`,
                      height: `${box().height}px`,
                    }}
                  />
                )}
              </Show>
              <BrowserCommentEditor
                x={comment().x}
                y={comment().y}
                containerWidth={container?.clientWidth ?? 0}
                containerHeight={container?.clientHeight ?? 0}
                onSubmit={submitComment}
                onCancel={() => setStore("comment", undefined)}
                onDraftChange={(empty) => (commentDraftEmpty = empty)}
              />
            </div>
          )}
        </Show>
      </div>
    </aside>
  )
}
