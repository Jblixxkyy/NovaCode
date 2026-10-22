import { For, Show } from "solid-js"
import { Icon } from "@novacode-ai/ui/icon"
import { IconButton } from "@novacode-ai/ui/icon-button"
import { Tooltip } from "@novacode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import type { BrowserTabState } from "./api"

const titleOf = (tab: BrowserTabState) => {
  if (tab.title && tab.title !== tab.url) return tab.title
  try {
    const parsed = new URL(tab.url)
    return parsed.host + (parsed.pathname === "/" ? "" : parsed.pathname)
  } catch {
    return tab.url || "New tab"
  }
}

export function BrowserTabs(props: {
  tabs: BrowserTabState[]
  focusedTabID: string | null
  onFocus: (tabID: string) => void
  onClose: (tabID: string) => void
  onNew: () => void
}) {
  const language = useLanguage()

  return (
    <div
      data-component="browser-tabs"
      class="shrink-0 flex items-end gap-1 overflow-x-auto px-2 pt-1.5 border-b border-v2-border-border-muted bg-v2-background-bg-base"
      role="tablist"
      aria-label={language.t("session.tab.browser")}
    >
      <For each={props.tabs}>
        {(tab) => {
          const focused = () => tab.id === props.focusedTabID
          return (
            <div
              role="tab"
              aria-selected={focused()}
              data-component="browser-tab"
              data-focused={focused() ? "" : undefined}
              class="group shrink-0 max-w-48 min-w-0 flex items-center gap-1 rounded-t-md px-2 py-1.5 text-12-regular cursor-pointer"
              classList={{
                "bg-v2-background-bg-stronger text-v2-text-text-base": focused(),
                "text-v2-text-text-muted hover:bg-v2-background-bg-subtle hover:text-v2-text-text-base": !focused(),
              }}
              onClick={() => props.onFocus(tab.id)}
              onAuxClick={(event) => {
                if (event.button === 1) props.onClose(tab.id)
              }}
              title={tab.title || tab.url}
            >
              <Show when={tab.loading}>
                <span class="size-3 shrink-0 animate-spin rounded-full border border-v2-border-border-strong border-t-transparent" />
              </Show>
              <Show when={!tab.loading && tab.favicon}>
                <img
                  src={tab.favicon}
                  alt=""
                  class="size-3.5 shrink-0 rounded-[3px]"
                  onError={(event) => {
                    event.currentTarget.style.display = "none"
                  }}
                />
              </Show>
              <span class="min-w-0 flex-1 truncate">{titleOf(tab)}</span>
              <button
                type="button"
                aria-label={language.t("common.closeTab")}
                class="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-v2-background-bg-strong"
                classList={{ "opacity-100": focused() }}
                onClick={(event) => {
                  event.stopPropagation()
                  props.onClose(tab.id)
                }}
              >
                <Icon name="close-small" size="small" />
              </button>
            </div>
          )
        }}
      </For>
      <div class="shrink-0 pb-0.5">
        <Tooltip value={language.t("browser.action.newTab")} placement="top">
          <IconButton
            icon="plus-small"
            variant="ghost"
            class="h-6 w-6"
            onClick={() => props.onNew()}
            aria-label={language.t("browser.action.newTab")}
          />
        </Tooltip>
      </div>
    </div>
  )
}
