export type ComputerUseOptions = {
  /**
   * Logical display size reported to the model.
   * If omitted, auto-detected from screenshot or defaults to 1280x720.
   * Coordinates are validated against this size.
   */
  displayWidth?: number
  displayHeight?: number
  /**
   * Allow-list of actions. Empty means all allowed.
   * Example: ["screenshot","click","type","key","scroll","drag","wait","move","double_click"]
   */
  allowedActions?: string[]
  /** Deny-list — always wins over allowedActions */
  deniedActions?: string[]
  /**
   * If true, require explicit user approval via permission prompt per action.
   * Default: true (maps to permission "computer").
   */
  requireApproval?: boolean
  /** Max actions per tool call session before auto-abort (runaway guard) */
  maxActionsPerSession?: number
  /** Capture scale factor for HiDPI handling. Default 1 */
  scaleFactor?: number
}

export const DEFAULT_OPTIONS: Required<ComputerUseOptions> = {
  displayWidth: 1280,
  displayHeight: 720,
  allowedActions: [],
  deniedActions: [],
  requireApproval: true,
  maxActionsPerSession: 500,
  scaleFactor: 1,
}

export type ComputerAction =
  | { action: "screenshot" }
  | { action: "click"; x: number; y: number; button?: "left" | "right" | "middle" }
  | { action: "double_click"; x: number; y: number; button?: "left" | "right" | "middle" }
  | { action: "right_click"; x: number; y: number }
  | { action: "move"; x: number; y: number }
  | { action: "drag"; path: Array<{ x: number; y: number }>; button?: "left" | "right" | "middle" }
  | { action: "scroll"; x: number; y: number; scroll_x?: number; scroll_y?: number; delta_x?: number; delta_y?: number }
  | { action: "type"; text: string }
  | { action: "key"; keys: string[]; text?: string }
  | { action: "keypress"; keys: string[] }
  | { action: "wait"; ms?: number; duration_ms?: number }

export const ALL_ACTIONS = [
  "screenshot",
  "click",
  "double_click",
  "right_click",
  "move",
  "drag",
  "scroll",
  "type",
  "key",
  "keypress",
  "wait",
] as const
