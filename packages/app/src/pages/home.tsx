import { ScrollView } from "@novacode-ai/ui/scroll-view"
import { createHomeController } from "./home/home-controller"
import { createHomeProjectsController } from "./home/home-projects-controller"
import { HomeUtilityNav } from "./home/home-projects-view"
import { HomeProjects } from "./home/home-projects"
import { createHomeScrollController } from "./home/home-scroll-controller"
import { createHomeSessionSearchController } from "./home/home-session-search-controller"
import { createHomeSessionsController } from "./home/home-sessions-controller"
import { HomeSessions } from "./home/home-sessions"
import { useNavigate } from "@solidjs/router"

export function NewHome() {
  const home = createHomeController()
  const projects = createHomeProjectsController(home)
  const sessions = createHomeSessionsController(home)
  const search = createHomeSessionSearchController(home, sessions)
  const scroll = createHomeScrollController(sessions.data.groups)
  const navigate = useNavigate()
  return (
    <div
      class={`
        m-2 min-h-0 flex-1 self-stretch overflow-hidden rounded-[10px]
        bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]
      `}
    >
      <ScrollView
        class="h-full [container-type:size]"
        thumbContainer={scroll.viewport.thumbTrack}
        thumbHoverTarget={scroll.viewport.hoverTarget}
        viewportRef={scroll.viewport.setViewport}
        onScroll={(event) => scroll.viewport.update(event.currentTarget.scrollTop)}
        onWheel={scroll.viewport.containOuterWheel}
      >
        <div
          class={`
            mx-auto grid min-h-full w-full max-w-[1080px] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 px-3
            lg:grid-cols-[280px_minmax(0,720px)] lg:grid-rows-1 lg:gap-8 lg:px-6
          `}
        >
          <HomeProjects projects={projects} scroll={scroll} />
          <div class="flex flex-col gap-4 min-w-0">
            <button
              type="button"
              onClick={() => navigate("/playground")}
              class="flex items-center justify-between rounded-[10px] border border-v2-border-border-base bg-v2-background-bg-layer-02 px-3 py-2.5 text-left hover:bg-v2-background-bg-layer-03 transition-colors"
            >
              <span class="flex items-center gap-2 text-[13px] font-[600]">
                <span class="text-[16px]">🕹️</span> Agent Playground
                <span class="rounded-full bg-v2-background-bg-base px-1.5 py-0.5 text-[10px] font-[600] text-v2-text-text-muted">2D • NEW</span>
              </span>
              <span class="text-[11px] text-v2-text-text-muted">View little humans →</span>
            </button>
            <HomeSessions sessions={sessions} search={search} scroll={scroll} />
          </div>
          <HomeUtilityNav
            class="flex lg:hidden"
            onOpenSettings={projects.utility.settings}
            onOpenHelp={projects.utility.help}
            language={projects.copy.language}
          />
        </div>
      </ScrollView>
    </div>
  )
}
