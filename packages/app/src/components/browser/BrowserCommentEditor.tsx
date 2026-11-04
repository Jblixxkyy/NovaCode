import { createEffect, createSignal, onMount } from "solid-js"
import { Button } from "@novacode-ai/ui/button"
import { useLanguage } from "@/context/language"

const WIDTH = 320
const GAP = 12

export function BrowserCommentEditor(props: {
  /** Click point in content-area CSS pixels. */
  x: number
  y: number
  containerWidth: number
  containerHeight: number
  onSubmit: (draft: string) => void
  onCancel: () => void
  onDraftChange?: (empty: boolean) => void
}) {
  const language = useLanguage()
  const [draft, setDraft] = createSignal("")

  let textarea: HTMLTextAreaElement | undefined
  onMount(() => textarea?.focus())
  createEffect(() => props.onDraftChange?.(draft().trim().length === 0))

  const left = () => Math.min(Math.max(GAP, props.x - WIDTH / 2), Math.max(GAP, props.containerWidth - WIDTH - GAP))
  const top = () => {
    const below = props.y + GAP
    // Rough editor height; the box scrolls rather than growing past the surface.
    const height = 168
    if (below + height <= props.containerHeight - GAP) return below
    return Math.max(GAP, props.y - GAP - height)
  }

  const submit = () => {
    const value = draft().trim()
    if (!value) return
    props.onSubmit(value)
  }

  return (
    <div
      data-component="browser-comment-editor"
      class="absolute z-10 overflow-hidden rounded-md border border-v2-border-border-muted bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
      style={{ left: `${left()}px`, top: `${top()}px`, width: `${WIDTH}px` }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div class="flex items-center gap-1.5 border-b border-v2-border-border-muted px-2.5 py-1.5 text-12-regular text-v2-text-text-muted">
        <span class="font-[550] text-v2-text-text-base">{language.t("browser.comment.add")}</span>
      </div>
      <textarea
        ref={textarea}
        value={draft()}
        onInput={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            props.onCancel()
            return
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            submit()
          }
        }}
        placeholder={language.t("browser.comment.placeholder")}
        rows={3}
        class="w-full resize-none bg-transparent px-2.5 py-2 text-13-regular text-v2-text-text-base outline-none placeholder:text-v2-text-text-subtle"
      />
      <div class="flex items-center justify-end gap-1.5 px-2.5 pb-2">
        <Button size="small" variant="ghost" onClick={() => props.onCancel()}>
          {language.t("browser.comment.cancel")}
        </Button>
        <Button size="small" variant="primary" onClick={submit} disabled={!draft().trim()}>
          {language.t("browser.comment.submit")}
        </Button>
      </div>
    </div>
  )
}
