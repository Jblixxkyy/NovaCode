import { createStore } from "solid-js/store"

// Shared sidebar state, so the titlebar Home button and the sidebar itself
// use the same toggle. The sidebar only opens and closes with that button:
// there is no backdrop click, no header close button, and no floating button.
const [state, setState] = createStore({ open: true })

export const workspaceSidebar = {
  open: () => state.open,
  toggle: () => setState("open", (value) => !value),
  setOpen: (value: boolean) => setState("open", value),
}
