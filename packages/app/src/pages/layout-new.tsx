import { createEffect, Show, Suspense, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { DebugBar } from "@/components/debug-bar"
import { TabsInfoPopup } from "@/components/help-button"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { WorkspaceSidebar } from "@/components/workspace-sidebar"
import { Icon as IconV2 } from "@novacode-ai/ui/v2/icon"
import { IconButtonV2 } from "@novacode-ai/ui/v2/icon-button-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { setV2Toast, ToastRegion } from "@/utils/toast"

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const language = useLanguage()
  const [state, setState] = createStore({ debugTools: true, sidebarOpen: true })

  createEffect(() => setV2Toast(true))

  const update: TitlebarUpdate = {
    version: () => {
      const state = platform.updater?.state()
      if (state?.status !== "ready") return
      return state.version
    },
    installing: () => platform.updater?.state().status === "installing",
    install: () => void platform.updater?.install(),
  }

  return (
    <div
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <Titlebar
        update={update}
        debugTools={
          import.meta.env.DEV
            ? { visible: state.debugTools, toggle: () => setState("debugTools", (value) => !value) }
            : undefined
        }
      />
      <WorkspaceSidebar open={state.sidebarOpen} onClose={() => setState("sidebarOpen", false)} />
      <Show when={!state.sidebarOpen}>
        <div class="fixed left-3 top-12 z-40">
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="large"
            icon={<IconV2 name="menu" />}
            aria-label={language.t("command.sidebar.toggle")}
            onClick={() => setState("sidebarOpen", true)}
          />
        </div>
      </Show>
      <main class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict">
        <Suspense>{props.children}</Suspense>
      </main>
      {import.meta.env.DEV && state.debugTools && <DebugBar inline />}
      <TabsInfoPopup />
      <ToastRegion v2 />
    </div>
  )
}
