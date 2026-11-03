import { ButtonV2 } from "@novacode-ai/ui/v2/button-v2"
import { createEffect, Show } from "solid-js"
import { useTabs } from "@/context/tabs"
import { createHomeController } from "./home/home-controller"
import { createHomeProjectsController } from "./home/home-projects-controller"

// The draft/new-session screen IS the home screen, by design.
// This route is only a redirector, not a page of its own:
// - If a draft tab already exists, go to it.
// - Otherwise, if a project is available, create a draft tab — that lands
//   on the real draft/new-session screen (NovaCode watermark, prompt
//   composer, model/agent/project pickers), with no extra click.
// - Only if no project is available at all (e.g. a fresh install) does
//   it show the "Get started" fallback with a New session button.
export function NewHome() {
  const home = createHomeController()
  const projects = createHomeProjectsController(home)
  const tabs = useTabs()
  const language = projects.copy.language
  const draftTab = () => tabs.store.find((tab) => tab.type === "draft")
  const canCreateDraft = () => !!home.project.newSession()
  createEffect(() => {
    if (!tabs.ready()) return
    const draft = draftTab()
    if (draft) {
      tabs.select(draft)
      return
    }
    if (canCreateDraft()) home.project.openNewSession()
  })
  return (
    <div
      class={`
        m-2 min-h-0 flex-1 self-stretch overflow-hidden rounded-[10px]
        bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]
      `}
    >
      <Show when={tabs.ready() && !draftTab() && !canCreateDraft()}>
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
