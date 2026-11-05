import { ScrollView } from "@novacode-ai/ui/scroll-view"
import { ButtonV2 } from "@novacode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@novacode-ai/ui/v2/icon"
import { IconButtonV2 } from "@novacode-ai/ui/v2/icon-button-v2"
import { MenuV2 } from "@novacode-ai/ui/v2/menu-v2"
import { createMediaQuery } from "@solid-primitives/media"
import { createEffect, createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { fileManagerApp } from "@/utils/file-manager"
import { pathKey } from "@/utils/path-key"
import { displayName } from "@/pages/layout/helpers"
import { sessionTitle } from "@/utils/session-title"
import { createHomeController } from "@/pages/home/home-controller"
import { createHomeProjectsController } from "@/pages/home/home-projects-controller"
import { HomeUtilityNav } from "@/pages/home/home-projects-view"
import { createHomeSessionsController, type HomeSessionRecord } from "@/pages/home/home-sessions-controller"
import { workspaceSidebar } from "./workspace-sidebar-state"

// Push sidebar, like the right-side review panel: it lives in the global
// layout row next to the chat, so opening it narrows / moves the chat view
// instead of overlaying it. It only opens and closes with the titlebar
// Home button — no backdrop click and no close button inside itself.
export function WorkspaceSidebar() {
  const home = createHomeController()
  const projects = createHomeProjectsController(home)
  const sessions = createHomeSessionsController(home)
  const settings = useSettings()
  const platform = usePlatform()
  const [sidebar, setSidebar] = createStore({
    filter: "",
    expanded: {} as Record<string, boolean>,
    // Which workspace's 3-dot menu is open, by worktree. Only one at a time.
    menuOpen: undefined as string | undefined,
    // Which session's 3-dot menu is open, by session id. Only one at a time.
    sessionMenuOpen: undefined as string | undefined,
  })
  const language = projects.copy.language
  // When the auto-collapse setting changes, reset manual expansions so
  // the new default takes effect right away, not just on a remount.
  createEffect(() => {
    settings.general.autoCollapseSidebarSessions()
    setSidebar("expanded", {})
  })
  const groupedSessions = createMemo(() => {
    const byProject = new Map<string, HomeSessionRecord[]>()
    const filter = sidebar.filter.trim().toLowerCase()
    // All sessions in all workspaces, not just the selected project.
    for (const record of sessions.data.allProjectRecords()) {
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
  // Default: all workspaces start expanded, so all of their sessions are
  // visible on open. With auto-collapse on, workspaces start collapsed,
  // and opening a session collapses every other workspace. Clicking a
  // workspace header still toggles it manually either way.
  const isExpanded = (worktree: string) =>
    sidebar.expanded[worktree] ?? !settings.general.autoCollapseSidebarSessions()
  const open = workspaceSidebar.open
  // Same 767px breakpoint the titlebar and settings use for "mobile".
  const isMobile = createMediaQuery("(max-width: 767px)")
  // On a phone the sidebar is an overlay, so opening anything from it
  // should get out of the way and hand the full screen back to the chat.
  const closeOnMobile = () => {
    if (isMobile()) workspaceSidebar.setOpen(false)
  }
  // Auto-pickup: whenever the sidebar opens, and whenever the project list
  // changes (a workspace is added or removed), re-fetch the saved-session
  // index so sessions saved elsewhere show up right away instead of only
  // after a restart or a 30s stale refetch.
  createEffect(() => {
    if (!open()) return
    void home.project.list().length
    sessions.data.refresh()
  })
  // Auto-discover workspaces: on load, add a workspace for every saved
  // session whose folder isn't already listed — so loading the app picks
  // up workspaces that have sessions, without adding each folder by hand.
  // Skips the global "/" project and workspaces the user closed on
  // purpose, so Close actually sticks. A session folder inside another
  // workspace is still its own workspace when its git root differs —
  // layout.projects.open() collapses it to that git root, so true
  // duplicates (same root) are never added twice.
  createEffect(() => {
    const conn = home.server.focused()
    if (!conn) return
    const ctx = home.server.focusedContext()
    if (!ctx) return
    const directories = sessions.data.allSessionDirectories()
    if (directories.length === 0) return
    const existing = new Set(
      home.project
        .list()
        .flatMap((project) => [
          pathKey(project.worktree),
          ...(project.sandboxes ?? []).map((sandbox) => pathKey(sandbox)),
        ]),
    )
    const closed = new Set(home.project.recentlyClosed().map((project) => pathKey(project.worktree)))
    for (const directory of directories) {
      if (!directory || directory === "/") continue
      const key = pathKey(directory)
      if (existing.has(key) || closed.has(key)) continue
      ctx.projects.open(directory)
    }
  })
  return (
    <>
      <Show when={isMobile() && open()}>
        <div
          class="fixed inset-x-0 top-10 bottom-0 z-40 bg-black/50"
          onClick={() => workspaceSidebar.setOpen(false)}
        />
      </Show>
      {/* Floating card, like the review panel and the session frame: rounded
          corners + raised shadow and no hard border, with the same 8px gap
          the panels get from the session row's p-2 / gap-2. Old design keeps
          the flat bordered panel. Margins collapse with the width so a closed
          sidebar takes up no space. */}
      <aside
        data-component="workspace-sidebar"
        class="flex shrink-0 flex-col overflow-hidden bg-v2-background-bg-base transition-[width,margin] duration-200 ease-in-out max-md:fixed max-md:bottom-0 max-md:left-0 max-md:top-10 max-md:z-50"
        classList={{
          "rounded-[10px] shadow-[var(--v2-elevation-raised)]": settings.general.newLayoutDesigns(),
          "border-r border-v2-border-border-base": !settings.general.newLayoutDesigns(),
        }}
        style={{
          width: open() ? "280px" : "0px",
          "margin-top": settings.general.newLayoutDesigns() && open() ? "8px" : "0px",
          "margin-bottom": settings.general.newLayoutDesigns() && open() ? "8px" : "0px",
          "margin-left": settings.general.newLayoutDesigns() && open() ? "8px" : "0px",
          "border-right-width": !settings.general.newLayoutDesigns() && open() ? "1px" : "0px",
        }}
        aria-label={language.t("sidebar.nav.projectsAndSessions")}
        aria-hidden={!open()}
      >
        <div class="flex h-full w-[280px] shrink-0 flex-col">
        <div class="flex shrink-0 flex-col gap-3 px-3 pb-2 pt-4">
          <ButtonV2
            data-action="workspace-sidebar-new-session"
            variant="neutral"
            size="normal"
            icon="edit"
            class="h-9 w-full justify-start px-3 [font-weight:530]"
            onClick={() => {
              sessions.session.create()
              closeOnMobile()
            }}
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
                  <div
                    class="group/project relative flex min-w-0 flex-col"
                    onContextMenu={(event) => {
                      event.preventDefault()
                      setSidebar("menuOpen", project.worktree)
                    }}
                  >
                    <div class="relative flex h-7 min-w-0 items-center rounded-[6px] text-v2-text-text-muted [font-weight:440] hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base">
                      <button
                        type="button"
                        data-component="workspace-sidebar-workspace"
                        class="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-[6px] pl-1.5 pr-8 text-left"
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
                      <div
                        class="hover-reveal absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 group-hover/project:opacity-100 focus-within:opacity-100 data-[menu=true]:opacity-100"
                        data-menu={sidebar.menuOpen === project.worktree}
                      >
                        <MenuV2
                          gutter={6}
                          modal={false}
                          placement="bottom-end"
                          open={sidebar.menuOpen === project.worktree}
                          onOpenChange={(menuOpen) =>
                            setSidebar("menuOpen", menuOpen ? project.worktree : undefined)
                          }
                        >
                          <MenuV2.Trigger
                            as={IconButtonV2}
                            data-action="workspace-sidebar-workspace-menu"
                            variant="ghost-muted"
                            size="small"
                            icon={<IconV2 name="outline-dots" />}
                            aria-label={language.t("common.moreOptions")}
                          />
                          <MenuV2.Portal>
                            <MenuV2.Content>
                              <MenuV2.Item
                                onSelect={() => {
                                  const conn = home.server.focused()
                                  if (conn) projects.project.openNewSession(conn, project.worktree)
                                  closeOnMobile()
                                }}
                              >
                                {language.t("command.session.new")}
                              </MenuV2.Item>
                              <MenuV2.Item
                                onSelect={() => {
                                  const conn = home.server.focused()
                                  if (conn) projects.project.edit(conn, project)
                                }}
                              >
                                {language.t("dialog.project.edit.title")}
                              </MenuV2.Item>
                              <MenuV2.Item
                                onSelect={() => {
                                  const conn = home.server.focused()
                                  if (conn) projects.project.relocate(conn, project)
                                }}
                              >
                                {language.t("command.project.relocate")}
                              </MenuV2.Item>
                              <Show when={(() => {
                                const conn = home.server.focused()
                                return conn ? projects.project.canReveal(conn) : false
                              })()}>
                                <MenuV2.Item
                                  onSelect={() => {
                                    const conn = home.server.focused()
                                    if (conn) projects.project.reveal(conn, project)
                                  }}
                                >
                                  {language.t(
                                    fileManagerApp(
                                      platform.platform === "desktop" ? (platform.os ?? "unknown") : "unknown",
                                    ).actionLabel,
                                  )}
                                </MenuV2.Item>
                              </Show>
                              <MenuV2.Item
                                disabled={(() => {
                                  const conn = home.server.focused()
                                  return conn ? projects.project.unseenCount(conn, project) === 0 : true
                                })()}
                                onSelect={() => {
                                  const conn = home.server.focused()
                                  if (conn) projects.project.clearNotifications(conn, project)
                                }}
                              >
                                {language.t("sidebar.project.clearNotifications")}
                              </MenuV2.Item>
                              <MenuV2.Separator />
                              <MenuV2.Item
                                onSelect={() => {
                                  const conn = home.server.focused()
                                  if (conn) projects.project.close(conn, project.worktree)
                                }}
                              >
                                {language.t("common.close")}
                              </MenuV2.Item>
                            </MenuV2.Content>
                          </MenuV2.Portal>
                        </MenuV2>
                      </div>
                    </div>
                    <Show when={isExpanded(project.worktree)}>
                      <div class="flex min-w-0 flex-col gap-px pb-2 pl-6">
                        <For each={worktreeSessions()}>
                          {(record) => (
                            <div
                              class="group/session relative flex min-w-0 flex-col"
                              onContextMenu={(event) => {
                                event.preventDefault()
                                setSidebar("sessionMenuOpen", record.session.id)
                              }}
                            >
                              <div class="relative flex h-7 min-w-0 items-center rounded-[6px] text-v2-text-text-muted [font-weight:440] hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base">
                                <button
                                  type="button"
                                  data-component="workspace-sidebar-session"
                                  class="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-[6px] pl-1.5 pr-8 text-left"
                                  onClick={() => {
                                    if (settings.general.autoCollapseSidebarSessions()) {
                                      const next: Record<string, boolean> = {}
                                      for (const project of home.project.list()) {
                                        next[project.worktree] = project.worktree === record.project.worktree
                                      }
                                      setSidebar("expanded", next)
                                    }
                                    sessions.session.open(record.session)
                                    closeOnMobile()
                                  }}
                                >
                                  <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                                    {sessionTitle(record.session.title) || record.session.id}
                                  </span>
                                  <span class="shrink-0 text-[11px] text-v2-text-text-faint">
                                    {sessionAge(record.session.time.updated ?? record.session.time.created, language)}
                                  </span>
                                </button>
                                <div
                                  class="hover-reveal absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 group-hover/session:opacity-100 focus-within:opacity-100 data-[menu=true]:opacity-100"
                                  data-menu={sidebar.sessionMenuOpen === record.session.id}
                                >
                                  <MenuV2
                                    gutter={6}
                                    modal={false}
                                    placement="bottom-end"
                                    open={sidebar.sessionMenuOpen === record.session.id}
                                    onOpenChange={(menuOpen) =>
                                      setSidebar("sessionMenuOpen", menuOpen ? record.session.id : undefined)
                                    }
                                  >
                                    <MenuV2.Trigger
                                      as={IconButtonV2}
                                      data-action="workspace-sidebar-session-menu"
                                      variant="ghost-muted"
                                      size="small"
                                      icon={<IconV2 name="outline-dots" />}
                                      aria-label={language.t("common.moreOptions")}
                                    />
                                    <MenuV2.Portal>
                                      <MenuV2.Content>
                                        <MenuV2.Item
                                          onSelect={() => sessions.session.open(record.session)}
                                        >
                                          {language.t("common.open")}
                                        </MenuV2.Item>
                                        <MenuV2.Item
                                          onSelect={() =>
                                            sessions.session.open(record.session, { background: true })
                                          }
                                        >
                                          {language.t("sidebar.session.openBackground")}
                                        </MenuV2.Item>
                                        <MenuV2.Separator />
                                        <MenuV2.Item onSelect={() => sessions.session.delete(record.session)}>
                                          {language.t("common.delete")}
                                        </MenuV2.Item>
                                      </MenuV2.Content>
                                    </MenuV2.Portal>
                                  </MenuV2>
                                </div>
                              </div>
                            </div>
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
        </div>
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
