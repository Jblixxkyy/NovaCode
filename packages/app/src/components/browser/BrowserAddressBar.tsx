import { createEffect, createMemo, For, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { addressParts, resolveAddress } from "./api"

/** Globe mark for the address field, matching OpenCode's empty/failed state icon. */
export function GlobeIcon(props: { class?: string }) {
  return (
    <svg
      class={props.class}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="7.5" />
      <path d="M2.5 10h15M10 2.5c-4.6 4.9-4.6 10.1 0 15M10 2.5c4.6 4.9 4.6 10.1 0 15" />
    </svg>
  )
}

export function BrowserAddressBar(props: {
  url: string
  recent: string[]
  disabled: boolean
  onNavigate: (url: string) => void
  inputRef?: (element: HTMLInputElement) => void
  apiRef?: (api: { focus: () => void } | undefined) => void
}) {
  const language = useLanguage()

  const [store, setStore] = createStore({
    editing: false,
    draft: "",
    active: -1,
    dismissed: false,
    submitted: undefined as string | undefined,
  })

  // A submitted address stays in the field until the page reports its URL.
  createEffect(
    on(
      () => props.url,
      () => setStore("submitted", undefined),
    ),
  )

  const field = () => (store.editing ? store.draft : (store.submitted ?? props.url))
  const parts = createMemo(() => addressParts(field()))

  const suggestions = createMemo(() => {
    if (!store.editing || !store.draft.trim() || store.dismissed) return []
    const query = store.draft.trim().toLowerCase()
    return props.recent.filter((url) => url.toLowerCase().includes(query) && url !== store.draft.trim()).slice(0, 5)
  })
  const listed = () => suggestions().length > 0
  const chosen = () => (store.active >= 0 ? suggestions()[store.active] : undefined)

  let input: HTMLInputElement | undefined

  const startEditing = () => {
    if (props.disabled) return
    setStore({ editing: true, draft: field(), active: -1, dismissed: false })
    queueMicrotask(() => {
      input?.focus()
      input?.select()
    })
  }

  onMount(() => props.apiRef?.({ focus: startEditing }))
  onCleanup(() => props.apiRef?.(undefined))

  const stopEditing = () => setStore({ editing: false, draft: "", active: -1, dismissed: false })

  const go = (raw: string) => {
    const text = raw.trim()
    if (!text) {
      stopEditing()
      return
    }
    const url = resolveAddress(chosen() ?? text)
    setStore({ editing: false, draft: "", active: -1, dismissed: false, submitted: url })
    props.onNavigate(url)
    input?.blur()
  }

  const step = (by: number) => {
    const count = suggestions().length
    if (!count) return
    setStore("active", (active) => {
      const next = active + by
      if (next < -1) return count - 1
      if (next >= count) return -1
      return next
    })
  }

  return (
    <div data-component="browser-address" class="relative min-w-0 flex-1" dir="ltr">
      <Show
        when={store.editing}
        fallback={
          <button
            type="button"
            disabled={props.disabled}
            onClick={startEditing}
            aria-label={language.t("browser.address.label")}
            class="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-12-regular bg-v2-background-bg-subtle hover:bg-v2-background-bg-stronger disabled:opacity-50"
          >
            <GlobeIcon class="size-3.5 shrink-0 text-v2-icon-icon-muted" />
            <span class="min-w-0 flex-1 truncate">
              <Show when={field()} fallback={<span class="text-v2-text-text-subtle">{language.t("browser.address.placeholder")}</span>}>
                <span class="text-v2-text-text-muted">{parts().scheme}</span>
                <span class="font-[550] text-v2-text-text-base">{parts().host}</span>
                <span class="text-v2-text-text-muted">{parts().rest}</span>
              </Show>
            </span>
          </button>
        }
      >
        <div class="flex h-8 items-center gap-2 rounded-md px-2 bg-v2-background-bg-subtle">
          <GlobeIcon class="size-3.5 shrink-0 text-v2-icon-icon-muted" />
          <input
            ref={(element) => {
              input = element
              props.inputRef?.(element)
            }}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={listed()}
            aria-label={language.t("browser.address.label")}
            spellcheck={false}
            autocomplete="off"
            disabled={props.disabled}
            placeholder={language.t("browser.address.placeholder")}
            value={store.draft}
            onInput={(event) => setStore({ draft: event.currentTarget.value, active: -1, dismissed: false })}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                if (!listed()) return
                event.preventDefault()
                step(event.key === "ArrowDown" ? 1 : -1)
                return
              }
              if (event.key === "Escape") {
                event.preventDefault()
                if (listed()) setStore({ dismissed: true, active: -1 })
                else stopEditing()
                return
              }
              if (event.key === "Enter") {
                event.preventDefault()
                go(chosen() ?? store.draft)
              }
            }}
            onBlur={() => {
              // A suggestion click navigates first (pointerdown prevented blur stealing).
              if (store.editing) stopEditing()
            }}
            class="min-w-0 flex-1 bg-transparent text-12-regular text-v2-text-text-base outline-none placeholder:text-v2-text-text-subtle"
          />
        </div>
      </Show>
      <Show when={store.editing && listed()}>
        <div
          role="listbox"
          aria-label={language.t("browser.address.suggestions")}
          data-component="browser-suggestions"
          class="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-v2-border-border-muted bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
        >
          <For each={suggestions()}>
            {(url, index) => (
              <div
                role="option"
                aria-selected={index() === store.active}
                data-active={index() === store.active ? "" : undefined}
                class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-12-regular"
                classList={{
                  "bg-v2-background-bg-stronger": index() === store.active,
                }}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => go(url)}
                onMouseEnter={() => setStore("active", index())}
              >
                <GlobeIcon class="size-3.5 shrink-0 text-v2-icon-icon-muted" />
                <span class="min-w-0 flex-1 truncate text-v2-text-text-base" dir="ltr">
                  {url}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
