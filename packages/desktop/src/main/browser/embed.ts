import type { BrowserWindow } from "electron"
import { browserTabs, type BrowserEmbedRequest } from "./tabs"

export type BrowserEmbedInput = BrowserEmbedRequest

/**
 * Renderer → main embed contract: the browser panel reports the page
 * area's rect (CSS pixels, window-content coordinates) and whether the
 * native view may show. The panel hides/freezes the view (visible: false)
 * while overlays such as the comment editor are open, in which case the
 * panel renders the frozen still frame underneath — the same trick
 * OpenCode uses for its comment editor.
 */
export function setBrowserEmbed(window: BrowserWindow, input: BrowserEmbedInput) {
  browserTabs.setEmbed(window, input)
}

export function clearBrowserEmbed(window: BrowserWindow) {
  browserTabs.setEmbed(window, null)
}
