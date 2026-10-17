import { Show, createMemo } from "solid-js"
import { DateTime } from "luxon"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { Icon } from "@novacode-ai/ui/icon"
import { Mark } from "@novacode-ai/ui/logo"
import { getDirectory, getFilename } from "@novacode-ai/core/util/path"
import { useDialog } from "@novacode-ai/ui/context/dialog"
import { MemorySolarSystemDialog } from "./memory-solar-system"

const MAIN_WORKTREE = "main"
const CREATE_WORKTREE = "create"
const ROOT_CLASS = "size-full flex flex-col"

interface NewSessionViewProps {
  worktree: string
}

export function NewSessionView(props: NewSessionViewProps) {
  const sync = useSync()
  const sdk = useSDK()
  const language = useLanguage()
  const dialog = useDialog()

  const sandboxes = createMemo(() => sync().project?.sandboxes ?? [])
  const options = createMemo(() => [MAIN_WORKTREE, ...sandboxes(), CREATE_WORKTREE])
  const current = createMemo(() => {
    const selection = props.worktree
    if (options().includes(selection)) return selection
    return MAIN_WORKTREE
  })
  const projectRoot = createMemo(() => sync().project?.worktree ?? sdk().directory)
  const isWorktree = createMemo(() => {
    const project = sync().project
    if (!project) return false
    return sdk().directory !== project.worktree
  })

  const label = (value: string) => {
    if (value === MAIN_WORKTREE) {
      if (isWorktree()) return language.t("session.new.worktree.main")
      const branch = sync().data.vcs?.branch
      if (branch) return language.t("session.new.worktree.mainWithBranch", { branch })
      return language.t("session.new.worktree.main")
    }

    if (value === CREATE_WORKTREE) return language.t("session.new.worktree.create")

    return getFilename(value)
  }

  return (
    <div class={ROOT_CLASS}>
      <div class="h-12 shrink-0" aria-hidden />
      <div class="flex-1 px-6 pb-30 flex items-center justify-center text-center">
        <div class="w-full max-w-200 flex flex-col items-center text-center gap-4">
          <div class="flex flex-col items-center gap-6">
            <Mark class="w-10" />
            <div class="text-20-medium text-text-strong">{language.t("session.new.title")}</div>
            <button
              type="button"
              aria-label={language.t("session.memory.open")}
              onClick={() => dialog.push(() => <MemorySolarSystemDialog onClose={() => dialog.close()} />)}
              class="group relative flex size-[160px] items-center justify-center rounded-full border border-border-weak-base bg-[radial-gradient(ellipse_at_center,_rgba(252,213,58,0.12),transparent_70%)] shadow-[0_8px_40px_rgba(0,0,0,0.08)] hover:shadow-[0_12px_50px_rgba(252,213,58,0.15)] transition-all overflow-hidden"
            >
              <div class="absolute inset-0 rounded-full border border-dashed border-border-weak-base opacity-60 group-hover:border-[#fcd53a]/30 transition-colors" style={{ margin: "22px" }} />
              <div class="absolute inset-0 rounded-full border border-dashed border-border-weak-base opacity-40 group-hover:border-[#38bdf8]/30 transition-colors" style={{ margin: "42px" }} />
              <div class="relative flex size-12 items-center justify-center rounded-full bg-[radial-gradient(circle_at_30%_30%,_#ffe78a,_#fcd53a_50%,_#eab308_80%)] shadow-[0_0_20px_rgba(252,213,58,0.5)] ring-1 ring-black/10">
                <span class="text-[10px] font-bold tracking-widest text-black/70">MEM</span>
              </div>
              <div class="absolute size-2 rounded-full bg-[#fcd53a] top-[28px] left-1/2 -translate-x-1/2 shadow-[0_0_8px_#fcd53a]" />
              <div class="absolute size-1.5 rounded-full bg-[#38bdf8] bottom-[36px] right-[38px] shadow-[0_0_6px_#38bdf8]" />
              <div class="absolute size-1.5 rounded-full bg-[#a78bfa] top-[52px] right-[30px] shadow-[0_0_6px_#a78bfa]" />
            </button>
            <button
              type="button"
              class="text-12-medium text-text-weak hover:text-text-strong underline-offset-4 hover:underline transition-colors"
              onClick={() => dialog.push(() => <MemorySolarSystemDialog onClose={() => dialog.close()} />)}
            >
              {language.t("session.memory.open")} →
            </button>
          </div>
          <div class="w-full flex flex-col gap-4 items-center">
            <div class="flex items-start justify-center gap-3 min-h-5">
              <div class="text-12-medium text-text-weak select-text leading-5 min-w-0 max-w-160 break-words text-center">
                {getDirectory(projectRoot())}
                <span class="text-text-strong">{getFilename(projectRoot())}</span>
              </div>
            </div>
            <div class="flex items-start justify-center gap-1.5 min-h-5">
              <Icon name="branch" size="small" class="mt-0.5 shrink-0" />
              <div class="text-12-medium text-text-weak select-text leading-5 min-w-0 max-w-160 break-words text-center">
                {label(current())}
              </div>
            </div>
            <Show when={sync().project}>
              {(project) => (
                <div class="flex items-start justify-center gap-3 min-h-5">
                  <div class="text-12-medium text-text-weak leading-5 min-w-0 max-w-160 break-words text-center">
                    {language.t("session.new.lastModified")}&nbsp;
                    <span class="text-text-strong">
                      {DateTime.fromMillis(project().time.updated ?? project().time.created)
                        .setLocale(language.intl())
                        .toRelative()}
                    </span>
                  </div>
                </div>
              )}
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}
