import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useData } from "../context/data"
import { map, pipe, sortBy } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Link } from "../ui/link"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import type { IntegrationAttempt, IntegrationMethod } from "@novacode-ai/sdk/v2"
import { useToast } from "../ui/toast"
import { useBindings } from "../keymap"
import { useClipboard } from "../context/clipboard"

const PROVIDER_PRIORITY: Record<string, number> = {
  opencode: 0,
  "opencode-go": 1,
  openai: 2,
  "github-copilot": 3,
  anthropic: 4,
  google: 5,
}

const CUSTOM_PROVIDER_OPTION_VALUE = "__opencode_custom_provider__"
const CUSTOM_PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/

type ConnectMethod = Extract<IntegrationMethod, { type: "key" | "oauth" }>

type ProviderOptionBase = {
  title: string
  value: string
  description?: string
  category: string
}

type ProviderOption =
  | (ProviderOptionBase & {
      type: "provider"
      providerID: string
    })
  | (ProviderOptionBase & {
      type: "custom"
    })

export function providerOptions(list: { id: string; name: string }[]): ProviderOption[] {
  return [
    ...pipe(
      list,
      sortBy(
        (x) => PROVIDER_PRIORITY[x.id] ?? 99,
        (x) => x.name.toLowerCase(),
        (x) => x.id,
      ),
      map((provider) => ({
        type: "provider" as const,
        title: provider.name,
        value: provider.id,
        providerID: provider.id,
        description: {
          opencode: "(Recommended)",
          anthropic: "(API key)",
          openai: "(ChatGPT Plus/Pro or API key)",
          "opencode-go": "Low cost subscription for everyone",
        }[provider.id],
        category: provider.id in PROVIDER_PRIORITY ? "Popular" : "Providers",
      })),
    ),
    {
      type: "custom",
      title: "Other",
      value: CUSTOM_PROVIDER_OPTION_VALUE,
      description: "Custom provider",
      category: "Providers",
    },
  ]
}

export function normalizeCustomProviderID(value: string) {
  const providerID = value.trim().replace(/^@ai-sdk\//, "")
  if (!CUSTOM_PROVIDER_ID.test(providerID)) return
  return providerID
}

function connectMethods(methods: readonly IntegrationMethod[] | undefined): ConnectMethod[] {
  return (methods ?? []).filter(
    (method): method is ConnectMethod => method.type === "key" || method.type === "oauth",
  )
}

function methodLabel(method: ConnectMethod) {
  return method.type === "key" ? (method.label ?? "API key") : method.label
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return JSON.stringify(error)
}

async function finishConnection(input: {
  data: ReturnType<typeof useData>
  dialog: ReturnType<typeof useDialog>
  toast: ReturnType<typeof useToast>
  name: string
}) {
  await Promise.allSettled([
    input.data.location.integration.refresh(),
    input.data.location.provider.refresh(),
    input.data.location.model.refresh(),
  ])
  input.dialog.clear()
  input.toast.show({ variant: "success", message: `Connected ${input.name}` })
}

export function createDialogProviderOptions() {
  const data = useData()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()

  const location = () => {
    const ref = data.location.default()
    return { directory: ref.directory, workspace: ref.workspaceID }
  }

  async function promptCustomProviderID(): Promise<string | undefined> {
    const value = await DialogPrompt.show(dialog, "Other", {
      placeholder: "Provider id",
      description: () => (
        <text fg={theme.textMuted}>
          This only stores a credential. Configure the provider in novacode.json to use it.
        </text>
      ),
    })
    if (value === null) return

    const providerID = normalizeCustomProviderID(value)
    if (providerID) return providerID

    toast.show({
      variant: "error",
      message:
        "Provider ids must start with a lowercase letter or number and only use lowercase letters, numbers, hyphens, and underscores",
    })
    return promptCustomProviderID()
  }

  const options = createMemo(() => {
    const integrations = data.location.integration.list() ?? []
    const connected = new Set(
      integrations.filter((integration) => integration.connections.length > 0).map((integration) => integration.id),
    )
    return pipe(
      providerOptions(integrations.map((integration) => ({ id: integration.id, name: integration.name }))),
      map((provider) => {
        if (provider.type === "custom") {
          return {
            title: provider.title,
            value: provider.value,
            description: provider.description,
            category: provider.category,
            async onSelect() {
              const providerID = await promptCustomProviderID()
              if (!providerID) return
              toast.show({
                variant: "info",
                message: `Configure ${providerID} in novacode.json to use it.`,
              })
              dialog.clear()
            },
          }
        }

        const providerID = provider.providerID
        const methodList = connectMethods(
          integrations.find((integration) => integration.id === providerID)?.methods,
        )
        return {
          title: provider.title,
          value: provider.value,
          description: provider.description,
          category: provider.category,
          gutter: connected.has(providerID) ? () => <text fg={theme.success}>✓</text> : undefined,
          async onSelect() {
            const methods: ConnectMethod[] = methodList.length ? methodList : [{ type: "key", label: "API key" }]
            let index = 0
            if (methods.length > 1) {
              const selected = await new Promise<number | null>((resolve) => {
                dialog.replace(
                  () => (
                    <DialogSelect
                      title="Select auth method"
                      options={methods.map((method, index) => ({ title: methodLabel(method), value: index }))}
                      onSelect={(option) => resolve(option.value)}
                    />
                  ),
                  () => resolve(null),
                )
              })
              if (selected == null) return
              index = selected
            }
            const method = methods[index]
            if (method.type === "oauth") {
              let inputs: Record<string, string> | undefined
              if (method.prompts?.length) {
                const value = await PromptsMethod({ dialog, prompts: method.prompts })
                if (!value) return
                inputs = value
              }

              const result = await sdk.client.v2.integration.connect
                .oauth(
                  {
                    integrationID: providerID,
                    methodID: method.id,
                    inputs: inputs ?? {},
                    location: location(),
                  },
                  { throwOnError: true },
                )
                .then((response) => response.data.data)
                .catch((error) => {
                  toast.show({ variant: "error", message: errorMessage(error) })
                  dialog.clear()
                  return undefined
                })
              if (!result) return
              if (result.mode === "code") {
                dialog.replace(() => (
                  <CodeMethod providerID={providerID} name={provider.title} title={method.label} attempt={result} />
                ))
              }
              if (result.mode === "auto") {
                dialog.replace(() => (
                  <AutoMethod providerID={providerID} name={provider.title} title={method.label} attempt={result} />
                ))
              }
            }
            if (method.type === "key") {
              dialog.replace(() => (
                <ApiMethod providerID={providerID} name={provider.title} title={method.label ?? "API key"} />
              ))
            }
          },
        }
      }),
    )
  })
  return options
}

export function DialogProvider() {
  const options = createDialogProviderOptions()
  return <DialogSelect title="Connect a provider" options={options()} />
}

interface AutoMethodProps {
  providerID: string
  name: string
  title: string
  attempt: IntegrationAttempt
}
function AutoMethod(props: AutoMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const dialog = useDialog()
  const data = useData()
  const toast = useToast()
  const clipboard = useClipboard()

  const location = () => {
    const ref = data.location.default()
    return { directory: ref.directory, workspace: ref.workspaceID }
  }

  useBindings(() => ({
    bindings: [
      {
        key: "c",
        desc: "Copy provider code",
        group: "Dialog",
        cmd: () => {
          const code = props.attempt.instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0] ?? props.attempt.url
          clipboard
            .write?.(code)
            .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
            .catch(toast.error)
        },
      },
    ],
  }))

  onMount(() => {
    let alive = true
    onCleanup(() => {
      alive = false
    })

    const poll = async () => {
      const result = await sdk.client.v2.integration.attempt
        .status({ attemptID: props.attempt.attemptID, location: location() }, { throwOnError: true })
        .then((response) => ({ ok: true as const, status: response.data.data }))
        .catch((error) => ({ ok: false as const, error }))
      if (!alive) return
      if (!result.ok) {
        toast.show({ variant: "error", message: errorMessage(result.error) })
        dialog.clear()
        return
      }
      if (result.status.status === "complete") {
        await finishConnection({ data, dialog, toast, name: props.name })
        return
      }
      if (result.status.status === "failed") {
        toast.show({ variant: "error", message: result.status.message })
        dialog.clear()
        return
      }
      if (result.status.status === "expired") {
        toast.show({ variant: "error", message: "OAuth authorization expired. Try again." })
        dialog.clear()
        return
      }
      setTimeout(poll, 1_000)
    }

    void poll()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        <Link href={props.attempt.url} fg={theme.primary} />
        <text fg={theme.textMuted}>{props.attempt.instructions}</text>
      </box>
      <text fg={theme.textMuted}>Waiting for authorization...</text>
      <text fg={theme.text}>
        c <span style={{ fg: theme.textMuted }}>copy</span>
      </text>
    </box>
  )
}

interface CodeMethodProps {
  providerID: string
  name: string
  title: string
  attempt: IntegrationAttempt
}
function CodeMethod(props: CodeMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const data = useData()
  const dialog = useDialog()
  const toast = useToast()
  const [error, setError] = createSignal(false)

  const location = () => {
    const ref = data.location.default()
    return { directory: ref.directory, workspace: ref.workspaceID }
  }

  return (
    <DialogPrompt
      title={props.title}
      placeholder="Authorization code"
      onConfirm={async (value) => {
        const ok = await sdk.client.v2.integration.attempt
          .complete({ attemptID: props.attempt.attemptID, code: value, location: location() }, { throwOnError: true })
          .then(() => true)
          .catch(() => false)
        if (ok) {
          await finishConnection({ data, dialog, toast, name: props.name })
          return
        }
        setError(true)
      }}
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>{props.attempt.instructions}</text>
          <Link href={props.attempt.url} fg={theme.primary} />
          <Show when={error()}>
            <text fg={theme.error}>Invalid code</text>
          </Show>
        </box>
      )}
    />
  )
}

interface ApiMethodProps {
  providerID: string
  name: string
  title: string
}
function ApiMethod(props: ApiMethodProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const data = useData()
  const toast = useToast()
  const { theme } = useTheme()

  const location = () => {
    const ref = data.location.default()
    return { directory: ref.directory, workspace: ref.workspaceID }
  }

  return (
    <DialogPrompt
      title={props.title}
      placeholder="API key"
      description={() =>
        ({
          opencode: (
            <box gap={1}>
              <text fg={theme.textMuted}>
                NovaCode Zen gives you access to all the best coding models at the cheapest prices with a single API
                key.
              </text>
              <text fg={theme.text}>
                Go to <span style={{ fg: theme.primary }}>https://novacode.ai/zen</span> to get a key
              </text>
            </box>
          ),
          "opencode-go": (
            <box gap={1}>
              <text fg={theme.textMuted}>
                NovaCode Go is a $10 per month subscription that provides reliable access to popular open coding models
                with generous usage limits.
              </text>
              <text fg={theme.text}>
                Go to <span style={{ fg: theme.primary }}>https://novacode.ai/go</span> and enable NovaCode Go
              </text>
            </box>
          ),
        })[props.providerID] ?? undefined
      }
      onConfirm={async (value) => {
        if (!value) return
        const ok = await sdk.client.v2.integration.connect
          .key({ integrationID: props.providerID, key: value, location: location() }, { throwOnError: true })
          .then(() => true)
          .catch((error) => {
            toast.show({ variant: "error", message: errorMessage(error) })
            return false
          })
        if (!ok) return
        await finishConnection({ data, dialog, toast, name: props.name })
      }}
    />
  )
}

interface PromptsMethodProps {
  dialog: ReturnType<typeof useDialog>
  prompts: NonNullable<Extract<IntegrationMethod, { type: "oauth" }>["prompts"]>
}
async function PromptsMethod(props: PromptsMethodProps) {
  const inputs: Record<string, string> = {}
  for (const prompt of props.prompts) {
    if (prompt.when) {
      const value = inputs[prompt.when.key]
      if (value === undefined) continue
      const matches = prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value
      if (!matches) continue
    }

    if (prompt.type === "select") {
      const value = await new Promise<string | null>((resolve) => {
        props.dialog.replace(
          () => (
            <DialogSelect
              title={prompt.message}
              options={prompt.options.map((x) => ({
                title: x.label,
                value: x.value,
                description: x.hint,
              }))}
              onSelect={(option) => resolve(option.value)}
            />
          ),
          () => resolve(null),
        )
      })
      if (value === null) return null
      inputs[prompt.key] = value
      continue
    }

    const value = await new Promise<string | null>((resolve) => {
      props.dialog.replace(
        () => (
          <DialogPrompt title={prompt.message} placeholder={prompt.placeholder} onConfirm={(value) => resolve(value)} />
        ),
        () => resolve(null),
      )
    })
    if (value === null) return null
    inputs[prompt.key] = value
  }
  return inputs
}
