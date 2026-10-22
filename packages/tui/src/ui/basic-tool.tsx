import { createEffect, createMemo, createSignal, For, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import { RGBA, TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { TextShimmer } from "./text-shimmer"
import { SplitBorder } from "./border"

export interface ToolTrigger {
  title: string
  subtitle?: string
  args?: string[]
}

export interface BasicToolProps {
  icon: string
  trigger: ToolTrigger | JSX.Element | ((open: Accessor<boolean>) => JSX.Element)
  children?: JSX.Element
  status?: string
  hideDetails?: boolean
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  allowOpenWhilePending?: boolean
  defer?: boolean
  onTriggerClick?: () => void
  awaitingPermission?: boolean
  error?: string
  iconColor?: RGBA
  borderColor?: RGBA
}

function isToolTrigger(value: unknown): value is ToolTrigger {
  return typeof value === "object" && value !== null && "title" in value
}

export function BasicTool(props: BasicToolProps) {
  const { theme } = useTheme()
  const [localOpen, setLocalOpen] = createSignal(props.defaultOpen ?? false)
  const [ready, setReady] = createSignal(!props.defer)

  const open = () => props.open ?? localOpen()
  const pending = () => props.status === "pending" || props.status === "running"
  const hasChildren = () => !!props.children

  const failed = createMemo(() => props.status === "error")
  const denied = createMemo(() => failed() && /QuestionRejectedError|rejected permission|specified a rule|user dismissed/.test(props.error ?? ""))

  const titleColor = createMemo(() => {
    if (props.awaitingPermission) return theme.warning
    if (failed()) return theme.error
    return theme.text
  })

  const setOpen = (value: boolean) => {
    if (pending() && !props.allowOpenWhilePending) return
    if (props.open === undefined) setLocalOpen(value)
    props.onOpenChange?.(value)
  }

  let cancelReady: (() => void) | undefined
  const scheduleReady = () => {
    cancelReady?.()
    const timeout = setTimeout(() => {
      cancelReady = undefined
      if (open()) setReady(true)
    }, 0)
    cancelReady = () => clearTimeout(timeout)
  }

  onCleanup(() => cancelReady?.())

  createEffect(() => {
    if (!props.defer) return
    if (open()) {
      scheduleReady()
      return
    }
    cancelReady?.()
    cancelReady = undefined
    setReady(false)
  })

  const trigger = () => {
    if (typeof props.trigger === "function") return props.trigger(open)
    if (isToolTrigger(props.trigger)) {
      const value = props.trigger
      return (
        <box flexDirection="row" gap={1} alignItems="center">
          <TextShimmer
            text={value.title}
            active={pending()}
            color={titleColor()}
          />
          <Show when={value.subtitle}>
            <text fg={theme.textMuted} attributes={denied() ? TextAttributes.STRIKETHROUGH : undefined}>
              {value.subtitle}
            </text>
          </Show>
          <For each={value.args}>
            {(arg) => <text fg={theme.textMuted}>{arg}</text>}
          </For>
        </box>
      )
    }
    return props.trigger as JSX.Element
  }

  return (
    <box
      border={["left"]}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={props.borderColor ?? theme.border}
      backgroundColor={theme.backgroundPanel}
      marginTop={1}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      gap={1}
    >
      <box
        flexDirection="row"
        gap={1}
        alignItems="center"
        onMouseUp={() => {
          if (props.onTriggerClick) {
            props.onTriggerClick()
            return
          }
          setOpen(!open())
        }}
      >
        <text width={2} fg={props.iconColor ?? titleColor()} attributes={denied() ? TextAttributes.STRIKETHROUGH : undefined}>
          {props.icon}
        </text>
        <box flexGrow={1} flexDirection="row" gap={1} alignItems="center">
          {trigger()}
        </box>
        <Show when={hasChildren() && !props.hideDetails && (!pending() || props.allowOpenWhilePending)}>
          <text fg={theme.textMuted}>{open() ? "▼" : "▶"}</text>
        </Show>
      </box>
      <Show when={open() && hasChildren() && !props.hideDetails}>
        <box paddingLeft={3} gap={1}>
          <Show when={!props.defer || ready()}>{props.children}</Show>
        </box>
      </Show>
      <Show when={failed()}>
        <box paddingLeft={3}>
          <text fg={theme.error}>{props.error}</text>
        </box>
      </Show>
    </box>
  )
}
