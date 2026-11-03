import { ButtonV2 } from "@novacode-ai/ui/v2/button-v2"
import { createEffect, Show } from "solid-js"
import { useTabs } from "@/context/tabs"
import { createHomeController } from "./home/home-controller"
import { createHomeProjectsController } from "./home/home-projects-controller"

// No home page anymore, by design. This route is only a fallback:
// - If tabs are open, go back to the recent tab (the existing toggleHome rule).
// - If no tabs are open, show only a New session button. Clicking it creates
//   a real draft tab, which renders NovaCode's existing draft/new-session
//   screen (prompt composer, model/project pickers) — there is no custom
//   "Build anything" chat here, and no fake input box.
export function NewHome() {
  const home = createHomeController()
  const projects = createHomeProjectsController(home)
  const tabs = useTabs()
  const language = projects.copy.language
  const hasTabs = () => tabs.ready() && tabs.store.length > 0
  createEffect(() => {
    if (!hasTabs()) return
    tabs.toggleHome({ home: true })
  })
  return (
    <div
      class={`
        m-2 min-h-0 flex-1 self-stretch overflow-hidden rounded-[10px]
        bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]
      `}
    >
      <Show when={tabs.ready() && !hasTabs()}>
        <div class="mx-auto flex h-full w-full max-w-[720px] flex-col items-center justify-center gap-4 px-6">
          <div class="text-center text-[14px] text-v2-text-text-muted [font-weight:440]">
            {language.t("home.empty.description")}
          </div>
          <ButtonV2
            data-action="no-home-new-session"
            variant="neutral"
            size="normal"
            icon="edit"
            onClick={() => home.project.openNewSession()}
          >
            {language.t("command.session.new")}
          </ButtonV2>
        </div>
      </Show>
    </div>
  )
}
