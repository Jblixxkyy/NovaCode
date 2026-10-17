import { useFilteredList } from "@novacode-ai/ui/hooks"
import { Icon } from "@novacode-ai/ui/icon"
import { Tag } from "@novacode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@novacode-ai/ui/v2/button-v2"
import { IconButtonV2 } from "@novacode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@novacode-ai/ui/v2/icon"
import { TextInputV2 } from "@novacode-ai/ui/v2/text-input-v2"
import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import { type Accessor, type Component, createMemo, createSignal, For, Show } from "solid-js"
import { useDialog } from "@novacode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { authTokenFromCredentials } from "@/utils/server"
import { ServerScope } from "@/utils/server-scope"
import { SettingsListV2 } from "./parts/list"
import { DialogCreateSkill } from "./dialog-create-skill"
import "./settings-v2.css"

type SkillInfo = {
  name: string
  description?: string
  location: string
  content: string
  slash?: boolean
}

export const SettingsSkillsV2: Component<{
  directory: Accessor<string | undefined>
}> = (props) => {
  const language = useLanguage()
  const server = useServer()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const dialog = useDialog()
  const queryClient = useQueryClient()

  const scope = createMemo(() => ServerScope.fromServerKey(server.key))

  const extractSkills = (result: unknown): SkillInfo[] => {
    if (!result || typeof result !== "object") return []
    if (Array.isArray(result)) return result as SkillInfo[]
    const outer = (result as { data?: unknown }).data
    if (Array.isArray(outer)) return outer as SkillInfo[]
    if (outer && typeof outer === "object") {
      const inner = (outer as { data?: unknown }).data
      if (Array.isArray(inner)) return inner as SkillInfo[]
      // handle { location, data: [] } inside outer
      if ((outer as { data?: unknown; location?: unknown }).data && Array.isArray((outer as { data: unknown[] }).data))
        return (outer as { data: SkillInfo[] }).data
    }
    const direct = (result as { data?: unknown }).data
    if (direct && typeof direct === "object" && Array.isArray((direct as { data?: unknown }).data))
      return (direct as { data: SkillInfo[] }).data as SkillInfo[]
    if (Array.isArray((result as { data?: unknown }).data)) return (result as { data: SkillInfo[] }).data
    // direct payload { location, data: [] }
    if (Array.isArray((result as { location?: unknown; data?: unknown }).data))
      return (result as { data: SkillInfo[] }).data
    return []
  }

  const projectKey = createMemo(() => serverSync().data.project.map((p) => p.worktree).join("|"))
  const query = useQuery(() => ({
    queryKey: [scope(), props.directory(), projectKey(), "skills"] as const,
    queryFn: async () => {
      const sdk = serverSDK().client as unknown as {
        v2: { skill: { list: (p?: unknown, o?: unknown) => Promise<unknown> } }
        skill: { list: (p?: unknown, o?: unknown) => Promise<unknown> }
      }
      const dir = props.directory()
      const params = dir ? { location: { directory: dir } } : undefined
      const client = (sdk.v2?.skill ?? sdk.skill) as { list: (p?: unknown, o?: unknown) => Promise<unknown> } | undefined
      if (!client?.list) return [] as SkillInfo[]
      const fetchOne = async (p: unknown) => {
        try {
          const r = await client.list(p, { throwOnError: true })
          return extractSkills(r)
        } catch {
          try {
            const r = await client.list(p)
            return extractSkills(r)
          } catch {
            return [] as SkillInfo[]
          }
        }
      }
      const primary = await fetchOne(params)
      if (primary.length > 0 || dir) return primary
      // when no directory selected and global returned empty, try each known project worktree
      const projects = serverSync().data.project ?? []
      if (projects.length === 0) return primary
      const seen = new Map<string, SkillInfo>()
      for (const s of primary) seen.set(s.name, s)
      for (const project of projects) {
        const dir2 = project.worktree
        if (!dir2) continue
        const items = await fetchOne({ location: { directory: dir2 } })
        for (const s of items) seen.set(s.name, s)
      }
      return Array.from(seen.values())
    },
    staleTime: 30_000,
  }))

  const [expanded, setExpanded] = createSignal<string | null>(null)
  const [deleting, setDeleting] = createSignal<string | null>(null)

  const openCreate = () => {
    void dialog.show(() => <DialogCreateSkill directory={props.directory()} onCreated={() => void query.refetch()} />)
  }

  const deleteMutation = useMutation(() => ({
    mutationFn: async (name: string) => {
      const dir = props.directory()
      const url = new URL(`${serverSDK().url}/api/skill`)
      url.searchParams.set("name", name)
      if (dir) url.searchParams.set("location[directory]", dir)
      const headers: Record<string, string> = {}
      const s = server.current
      if (s?.http.password) headers["Authorization"] = `Basic ${authTokenFromCredentials({ username: s.http.username, password: s.http.password })}`
      const res = await fetch(url, { method: "DELETE", headers })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        let message = text
        try {
          const j = JSON.parse(text)
          message = j.message ?? j.error ?? text
        } catch {}
        throw new Error(message || `${res.status} ${res.statusText}`)
      }
    },
    onSuccess: (_: unknown, name: string) => {
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.skills.delete.toast.success.title"),
        description: language.t("settings.skills.delete.toast.success.description", { name }),
      })
      void query.refetch()
      void queryClient.invalidateQueries({ queryKey: [scope()] })
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("settings.skills.delete.toast.failed.title"), description: message })
    },
    onSettled: () => setDeleting(null),
  }))

  const isBuiltin = (skill: SkillInfo) => skill.location.includes("/builtin/") || skill.location === "/builtin/customize-novacode.md"

  const list = useFilteredList<SkillInfo>({
    items: () => query.data ?? [],
    key: (x) => x.name,
    filterKeys: ["name", "description", "location"],
    sortBy: (a, b) => a.name.localeCompare(b.name),
  })

  const count = createMemo(() => query.data?.length ?? 0)
  const hasResults = createMemo(() => list.flat().length > 0)

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <div class="settings-v2-skills-header">
          <h2 class="settings-v2-tab-title">
            {language.t("settings.skills.title")}
            <Show when={count() > 0}>
              <span class="settings-v2-skills-count">{count()}</span>
            </Show>
          </h2>
          <p class="settings-v2-provider-description">{language.t("settings.skills.description")}</p>
        </div>
        <div class="settings-v2-skills-actions">
          <div class="settings-v2-tab-search settings-v2-skills-search">
            <span class="settings-v2-skills-search-icon">
              <IconV2 name="magnifying-glass" size="large" class="text-v2-icon-icon-muted" />
            </span>
            <TextInputV2
              type="search"
              appearance="base"
              value={list.filter()}
              onInput={(event) => list.onInput(event.currentTarget.value)}
              placeholder={language.t("settings.skills.search.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("settings.skills.search.placeholder")}
            />
            <Show when={list.filter()}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                class="settings-v2-tab-search-clear"
                icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
                onClick={() => list.clear()}
              />
            </Show>
          </div>
          <ButtonV2 size="normal" variant="neutral" icon="plus" onClick={openCreate}>
            {language.t("settings.skills.add")}
          </ButtonV2>
        </div>
      </div>

      <div class="settings-v2-tab-body settings-v2-skills">
        <Show
          when={!query.isLoading}
          fallback={
            <div class="settings-v2-models-status">
              {language.t("common.loading")}
              {language.t("common.loading.ellipsis")}
            </div>
          }
        >
          <Show
            when={!query.isError}
            fallback={
              <div class="settings-v2-models-status">
                <span>{language.t("settings.skills.loadError")}</span>
                <span class="settings-v2-models-status-filter">{String(query.error)}</span>
              </div>
            }
          >
            <Show
              when={list.flat().length > 0}
              fallback={
                <div class="settings-v2-models-status">
                  <span>
                    {list.filter()
                      ? language.t("settings.skills.empty.search")
                      : language.t("settings.skills.empty")}
                  </span>
                  <Show when={list.filter()}>
                    <span class="settings-v2-models-status-filter">&quot;{list.filter()}&quot;</span>
                  </Show>
                  <Show when={!list.filter()}>
                    <span class="settings-v2-provider-description" style={{ "margin-top": "8px", "text-align": "center", "max-width": "480px" }}>
                      {language.t("settings.skills.empty.description")}
                    </span>
                  </Show>
                </div>
              }
            >
              <SettingsListV2>
                <For each={list.flat()}>
                  {(skill) => {
                    const isExpanded = () => expanded() === skill.name
                    const shortPath = () => {
                      const p = skill.location
                      // show last 2 segments for readability, keep full in tooltip
                      const parts = p.split(/[/\\]/)
                      if (parts.length <= 3) return p
                      return `…/${parts.slice(-3).join("/")}`
                    }
                    return (
                      <div
                        class="settings-v2-skill-row"
                        classList={{ "is-expanded": isExpanded() }}
                        onClick={() => setExpanded(isExpanded() ? null : skill.name)}
                      >
                        <div class="settings-v2-skill-icon">
                          <Icon name="code" />
                        </div>
                        <div class="settings-v2-skill-main">
                          <div class="settings-v2-skill-header">
                            <span class="settings-v2-skill-name">{skill.name}</span>
                            <Show when={skill.slash}>
                              <Tag>{language.t("settings.skills.tag.slash")}</Tag>
                            </Show>
                            <span class="settings-v2-skill-spacer" />
                            <Show when={!isBuiltin(skill)}>
                              <IconButtonV2
                                size="small"
                                variant="ghost-muted"
                                aria-label={language.t("settings.skills.delete")}
                                icon={<Icon name="trash" class="text-v2-icon-icon-muted" />}
                                disabled={deleting() === skill.name}
                                onClick={(e: MouseEvent) => {
                                  e.stopPropagation()
                                  if (!confirm(language.t("settings.skills.delete.confirm.description", { name: skill.name, path: skill.location }))) return
                                  setDeleting(skill.name)
                                  deleteMutation.mutate(skill.name)
                                }}
                              />
                            </Show>
                            <ButtonV2
                              size="small"
                              variant="ghost-muted"
                              onClick={(e: MouseEvent) => {
                                e.stopPropagation()
                                setExpanded(isExpanded() ? null : skill.name)
                              }}
                            >
                              {isExpanded() ? language.t("common.close") : language.t("common.open")}
                            </ButtonV2>
                            <span class="settings-v2-skill-chevron" aria-hidden="true">
                              <Show
                                when={isExpanded()}
                                fallback={
                                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                                    <path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
                                  </svg>
                                }
                              >
                                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                                  <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
                                </svg>
                              </Show>
                            </span>
                          </div>
                          <Show when={skill.description}>
                            <p class="settings-v2-skill-desc">{skill.description}</p>
                          </Show>
                          <div class="settings-v2-skill-path" title={skill.location}>
                            <span class="settings-v2-skill-path-icon">
                              <Icon name="folder" size="small" />
                            </span>
                            <span class="settings-v2-skill-path-text">{shortPath()}</span>
                          </div>
                          <Show when={isExpanded()}>
                            <div class="settings-v2-skill-content-wrap" onClick={(e: MouseEvent) => e.stopPropagation()}>
                              <div class="settings-v2-skill-content-head">
                                <span>SKILL.md</span>
                                <button
                                  type="button"
                                  class="settings-v2-skill-copy"
                                  onClick={(e: MouseEvent) => {
                                    e.stopPropagation()
                                    void navigator.clipboard.writeText(skill.content)
                                  }}
                                >
                                  {language.t("common.copy") ?? "Copy"}
                                </button>
                              </div>
                              <pre class="settings-v2-skill-content">{skill.content}</pre>
                            </div>
                          </Show>
                        </div>
                      </div>
                    )
                  }}
                </For>
              </SettingsListV2>
            </Show>
          </Show>
        </Show>
      </div>
    </>
  )
}
