import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-logo-mark-shadow" d="M0 0H4L16 20H12L0 0Z" fill="var(--icon-weak-base)" />
      <path data-slot="logo-logo-mark-n" d="M4 20H0V0H4V20ZM16 20H12V0H16V20Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M0 0H20L80 100H60L0 0Z" fill="var(--icon-base)" />
      <path d="M20 100H0V0H20V100ZM80 100H60V0H80V100Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 340 48"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <text
        x="0"
        y="36"
        font-family="JetBrainsMono Nerd Font Mono, JetBrains Mono, monospace"
        font-size="40"
        font-weight="700"
        letter-spacing="-1"
        fill="var(--icon-base)"
      >
        NovaCode
      </text>
    </svg>
  )
}
