import { createStore } from "solid-js/store"

// Shared sidebar state, so the titlebar Home button and the sidebar itself
// use the same toggle. The sidebar only opens and closes with that button:
// there is no backdrop click, no header close button, and no floating button.
// On phones it starts closed: a 280px in-flow column would leave the chat
// ~100px wide, so mobile opens it as an overlay instead (see the sidebar).
const [state, setState] = createStore({
  open: typeof window === "undefined" ? true : !window.matchMedia("(max-width: 767px)").matches,
})

export const workspaceSidebar = {
  open: () => state.open,
  toggle: () => setState("open", (value) => !value),
  setOpen: (value: boolean) => setState("open", value),
}
