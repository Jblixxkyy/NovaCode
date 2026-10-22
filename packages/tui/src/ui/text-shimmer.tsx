import { createEffect, createMemo, createSignal, onCleanup, type Accessor, type JSX } from "solid-js"
import { RGBA } from "@opentui/core"

interface TextShimmerProps {
  text: string
  active?: boolean
  color?: RGBA
}

export function TextShimmer(props: TextShimmerProps): JSX.Element {
  const active = props.active ?? false
  const [displayText, setDisplayText] = createSignal(props.text)

  const SHIMMER_CHARS = "░▒▓█▓▒░"
  let shimmerIndex = 0
  let interval: ReturnType<typeof setInterval> | undefined

  createEffect(() => {
    const current = props.text
    setDisplayText(current)
    if (interval) {
      clearInterval(interval)
      interval = undefined
    }
    if (!active) return

    interval = setInterval(() => {
      setDisplayText((prev: string): string => {
        if (!active) return prev
        if (prev.length >= current.length) return current
        return prev + SHIMMER_CHARS[shimmerIndex++ % SHIMMER_CHARS.length]
      })
    }, 100)
  })

  onCleanup(() => {
    if (interval) clearInterval(interval)
  })

  return <text fg={props.color}>{displayText()}</text>
}
