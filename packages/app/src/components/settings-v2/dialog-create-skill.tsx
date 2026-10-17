import { Button } from "@novacode-ai/ui/button"
import { Dialog } from "@novacode-ai/ui/dialog"
import { TextField } from "@novacode-ai/ui/text-field"
import { useDialog } from "@novacode-ai/ui/context/dialog"
import { useMutation, useQueryClient } from "@tanstack/solid-query"
import { createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { authTokenFromCredentials } from "@/utils/server"
import { ServerScope } from "@/utils/server-scope"

type Props = {
  directory?: string
  onCreated?: () => void
}

function buildAuthHeader(server: ReturnType<typeof useServer>["current"]) {
  if (!server || !server.http.password) return undefined
  return `Basic ${authTokenFromCredentials({ username: server.http.username, password: server.http.password })}`
}

function isSafeName(name: string) {
  return /^[a-z0-9][a-z0-9-_]*$/.test(name)
}

export function DialogCreateSkill(props: Props) {
  const language = useLanguage()
  const server = useServer()
  const serverSDK = useServerSDK()
  const dialog = useDialog()
  const queryClient = useQueryClient()

  const [name, setName] = createSignal("")
  const [description, setDescription] = createSignal("")
  const [content, setContent] = createSignal("")
  const [errName, setErrName] = createSignal<string | undefined>(undefined)
  const [errContent, setErrContent] = createSignal<string | undefined>(undefined)

  const scope = ServerScope.fromServerKey(server.key)

  const createMutation = useMutation(() => ({
    mutationFn: async () => {
      const n = name().trim()
      const d = description().trim()
      const c = content().trim()
      if (!n) throw new Error(language.t("settings.skills.create.error.name.required"))
      if (!isSafeName(n)) throw new Error(language.t("settings.skills.create.error.name.format"))
      if (!c) throw new Error(language.t("settings.skills.create.error.content.required"))

      const dir = props.directory
      const url = new URL(`${serverSDK().url}/api/skill`)
      if (dir) url.searchParams.set("location[directory]", dir)

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      }
      const auth = buildAuthHeader(server.current)
      if (auth) headers["Authorization"] = auth

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: n, description: d || undefined, content: c }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        let message = text
        try {
          const json = JSON.parse(text)
          message = json.message ?? json.error ?? text
        } catch {}
        throw new Error(message || `${res.status} ${res.statusText}`)
      }
      return n
    },
    onSuccess: (createdName) => {
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.skills.create.toast.success.title"),
        description: language.t("settings.skills.create.toast.success.description", { name: createdName }),
      })
      void queryClient.invalidateQueries({ queryKey: [scope] })
      props.onCreated?.()
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err)
      if (message.toLowerCase().includes("already exists") || message.toLowerCase().includes("exists")) {
        setErrName(language.t("settings.skills.create.error.name.exists"))
      } else if (message.toLowerCase().includes("name")) {
        setErrName(message)
      } else if (message.toLowerCase().includes("content")) {
        setErrContent(message)
      }
      showToast({ title: language.t("settings.skills.create.toast.failed.title"), description: message })
    },
  }))

  const onSubmit = (e: SubmitEvent) => {
    e.preventDefault()
    if (createMutation.isPending) return
    setErrName(undefined)
    setErrContent(undefined)
    const n = name().trim()
    const c = content().trim()
    let valid = true
    if (!n) {
      setErrName(language.t("settings.skills.create.error.name.required"))
      valid = false
    } else if (!isSafeName(n)) {
      setErrName(language.t("settings.skills.create.error.name.format"))
      valid = false
    }
    if (!c) {
      setErrContent(language.t("settings.skills.create.error.content.required"))
      valid = false
    }
    if (!valid) return
    createMutation.mutate(undefined as never)
  }

  return (
    <Dialog
      title={language.t("settings.skills.create.title")}
      class="max-w-[520px] w-full"
      transition
    >
      <form onSubmit={onSubmit} class="flex flex-col gap-4 px-4 pb-4">
        <TextField
          autofocus
          label={language.t("settings.skills.create.name.label")}
          placeholder={language.t("settings.skills.create.name.placeholder")}
          description={language.t("settings.skills.create.name.description")}
          value={name()}
          onChange={(v) => {
            setName(v)
            setErrName(undefined)
          }}
          validationState={errName() ? "invalid" : undefined}
          error={errName()}
        />
        <TextField
          label={language.t("settings.skills.create.description.label")}
          placeholder={language.t("settings.skills.create.description.placeholder")}
          value={description()}
          onChange={setDescription}
        />
        <TextField
          multiline
          label={language.t("settings.skills.create.content.label")}
          placeholder={language.t("settings.skills.create.content.placeholder")}
          value={content()}
          onChange={(v) => {
            setContent(v)
            setErrContent(undefined)
          }}
          validationState={errContent() ? "invalid" : undefined}
          error={errContent()}
          class="min-h-[160px] font-mono"
        />
        <div class="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={createMutation.isPending}>
            {createMutation.isPending ? language.t("common.saving") : language.t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
