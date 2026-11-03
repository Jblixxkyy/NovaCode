import { ScrollView } from "@novacode-ai/ui/scroll-view"
import { ButtonV2 } from "@novacode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@novacode-ai/ui/v2/icon"
import { IconButtonV2 } from "@novacode-ai/ui/v2/icon-button-v2"
import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { displayName } from "@/pages/layout/helpers"
import { sessionTitle } from "@/utils/session-title"
import { createHomeController } from "@/pages/home/home-controller"
import { createHomeProjectsController } from "@/pages/home/home-projects-controller"
import { HomeUtilityNav } from "@/pages/home/home-projects-view"
import { createHomeSessionsController, type HomeSessionRecord } from "@/pages/home/home-sessions-controller"

// Standalone slide-out sidebar. It is not a home page: it lives in the global
// layout and can be pulled out from any route (home, session, draft).
export function WorkspaceSidebar(props: { open: boolean; onClose: () => void }) {
  const home = createHomeController()
  const projects = createHomeProjectsController(home)
  const sessions = createHomeSessionsController(home)
  const [sidebar, setSidebar] = createStore({
    filter: "",
    expanded: {} as Record<string, boolean>,
  })
  const language = projects.copy.language
  const groupedSessions = createMemo(() => {
    const byProject = new Map<string, HomeSessionRecord[]>()
    const filter = sidebar.filter.trim().toLowerCase()
    for (const record of sessions.data.records()) {
      const title = (sessionTitle(record.session.title) || record.session.id).toLowerCase()
      if (filter && !title.includes(filter) && !record.projectName.toLowerCase().includes(filter)) continue
      const key = record.project.worktree
      const list = byProject.get(key) ?? []
      list.push(record)
      byProject.set(key, list)
    }
    return byProject
  })
  const visibleProjects = createMemo(() => {
    const filter = sidebar.filter.trim().toLowerCase()
    if (!filter) return home.project.list()
    return home.project.list().filter((project) => {
      if (displayName(project).toLowerCase().includes(filter)) return true
      return (groupedSessions().get(project.worktree) ?? []).length > 0
    })
  })
  const isExpanded = (worktree: string) =>
    sidebar.expanded[worktree] ?? home.selection.value().directory === worktree
  return (
    <>
      <Show when={props.open}>
        <div
          data-component="workspace-sidebar-backdrop"
          class="fixed bottom-0 left-0 right-0 top-9 z-40 bg-black/30"
          onClick={() => props.onClose()}
        />
      </Show>
      <aside
        data-component="workspace-sidebar"
        class="fixed bottom-0 left-0 top-9 z-50 flex w-[280px] flex-col overflow-hidden border-r border-v2-border-border-base bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] transition-transform duration-200 ease-in-out"
        style={{ transform: props.open ? "translateX(0)" : "translateX(-100%)" }}
        aria-label={language.t("sidebar.nav.projectsAndSessions")}
        aria-hidden={!props.open}
      >
        <div class="flex shrink-0 flex-col gap-2 px-3 pb-2 pt-3">
          <ButtonV2
            data-action="workspace-sidebar-new-session"
            variant="neutral"
            size="normal"
            icon="edit"
            class="h-9 w-full justify-start px-3 [font-weight:530]"
            onClick={() => sessions.session.create()}
          >
            {language.t("command.session.new")}
          </ButtonV2>
          <div class="flex h-7 items-center justify-between pl-1.5 pr-1">
            <div class="text-v2-text-text-muted [font-weight:530]">{language.t("home.workspaces")}</div>
            <div class="flex items-center gap-1">
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                icon={<IconV2 name="folder-add-left" size="small" />}
                aria-label={language.t("home.project.add")}
                onClick={() => {
                  const conn = home.server.focused()
                  if (conn) projects.project.choose(conn)
                }}
              />
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                icon={<IconV2 name="menu" size="small" />}
                aria-label={language.t("command.sidebar.toggle")}
                onClick={() => props.onClose()}
              />
            </div>
          </div>
          <label class="flex h-9 w-full items-center gap-2 rounded-[6px] bg-v2-background-bg-layer-02/60 px-3 text-v2-icon-icon-muted">
            <IconV2 name="magnifying-glass" />
            <input
              class="min-w-0 flex-1 border-0 bg-transparent outline-0 text-v2-text-text-base [font-weight:440] placeholder:text-v2-text-text-faint"
              value={sidebar.filter}
              placeholder={language.t("home.sessions.search.placeholder")}
              aria-label={language.t("home.sessions.search.placeholder")}
              onInput={(event) => setSidebar("filter", event.currentTarget.value)}
            />
          </label>
        </div>
        <ScrollView class="min-h-0 flex-1 px-3">
          <div class="flex min-w-0 flex-col gap-1 pb-4">
            <For each={visibleProjects()}>
              {(project) => {
                const worktreeSessions = () => groupedSessions().get(project.worktree) ?? []
                return (
                  <div class="flex min-w-0 flex-col">
                    <button
                      type="button"
                      data-component="workspace-sidebar-workspace"
                      class={`
                        flex h-7 min-w-0 w-full items-center gap-2 rounded-[6px] px-1.5 text-left
                        text-v2-text-text-muted [font-weight:440]
                        hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base
                      `}
                      aria-expanded={isExpanded(project.worktree)}
                      onClick={() => {
                        const conn = home.server.focused()
                        if (conn) home.project.select(conn, project.worktree)
                        setSidebar("expanded", project.worktree, !isExpanded(project.worktree))
                      }}
                    >
                      <IconV2
                        name="chevron-down"
                        size="small"
                        class="shrink-0 transition-transform duration-150 ease-in-out"
                        style={{ transform: `rotate(${isExpanded(project.worktree) ? 0 : -90}deg)` }}
                      />
                      <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                        {displayName(project)}
                      </span>
                      <span class="shrink-0 text-[11px] text-v2-text-text-faint">
                        {worktreeSessions().length > 0 ? worktreeSessions().length : ""}
                      </span>
                    </button>
                    <Show when={isExpanded(project.worktree)}>
                      <div class="flex min-w-0 flex-col gap-px pb-2 pl-6">
                        <For each={worktreeSessions().slice(0, 8)}>
                          {(record) => (
                            <button
                              type="button"
                              data-component="workspace-sidebar-session"
                              class={`
                                flex h-7 min-w-0 w-full items-center gap-2 rounded-[6px] px-1.5 text-left
                                text-v2-text-text-muted [font-weight:440]
                                hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base
                              `}
                              onClick={() => sessions.session.open(record.session)}
                            >
                              <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                                {sessionTitle(record.session.title) || record.session.id}
                              </span>
                              <span class="shrink-0 text-[11px] text-v2-text-text-faint">
                                {sessionAge(record.session.time.updated ?? record.session.time.created, language)}
                              </span>
                            </button>
                          )}
                        </For>
                        <Show when={worktreeSessions().length === 0}>
                          <div class="px-1.5 py-1 text-[12px] text-v2-text-text-faint">
                            {language.t("home.sessions.empty")}
                          </div>
                        </Show>
                      </div>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </ScrollView>
        <HomeUtilityNav
          class="flex shrink-0 px-3 pb-4"
          onOpenSettings={projects.utility.settings}
          onOpenHelp={projects.utility.help}
          language={language}
        />
      </aside>
    </>
  )
}

function sessionAge(time: number, language: ReturnType<typeof import("@/context/language").useLanguage>) {
  const diff = Date.now() - time
  const minutes = Math.floor(diff / 60000)
  if (minutes < 60) return language.t("common.time.minutesAgo.short", { count: Math.max(minutes, 0) })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return language.t("common.time.hoursAgo.short", { count: hours })
  const days = Math.floor(hours / 24)
  return language.t("common.time.daysAgo.short", { count: days })
}
