import type { Plugin } from "@novacode-ai/plugin"
import { tool } from "@novacode-ai/plugin/tool"
import { ALL_ACTIONS, DEFAULT_OPTIONS, type ComputerAction, type ComputerUseOptions } from "./types.js"
import { captureScreen } from "./screen.js"
import { executeAction } from "./input.js"

// Per-session action counter for runaway guard
const sessionCounts = new Map<string, number>()

function resolveOptions(raw?: ComputerUseOptions): Required<ComputerUseOptions> {
  return {
    displayWidth: raw?.displayWidth ?? DEFAULT_OPTIONS.displayWidth,
    displayHeight: raw?.displayHeight ?? DEFAULT_OPTIONS.displayHeight,
    allowedActions: raw?.allowedActions ?? DEFAULT_OPTIONS.allowedActions,
    deniedActions: raw?.deniedActions ?? DEFAULT_OPTIONS.deniedActions,
    requireApproval: raw?.requireApproval ?? DEFAULT_OPTIONS.requireApproval,
    maxActionsPerSession: raw?.maxActionsPerSession ?? DEFAULT_OPTIONS.maxActionsPerSession,
    scaleFactor: raw?.scaleFactor ?? DEFAULT_OPTIONS.scaleFactor,
  }
}

function isAllowed(action: string, opts: Required<ComputerUseOptions>): { allowed: boolean; reason?: string } {
  if (opts.deniedActions.includes(action)) return { allowed: false, reason: `action "${action}" is denied by deniedActions` }
  if (opts.deniedActions.includes("*")) return { allowed: false, reason: `all actions denied` }
  if (opts.allowedActions.length === 0) return { allowed: true }
  if (opts.allowedActions.includes(action) || opts.allowedActions.includes("*")) return { allowed: true }
  return { allowed: false, reason: `action "${action}" not in allowedActions [${opts.allowedActions.join(", ")}]` }
}

function validateCoords(
  x: number | undefined,
  y: number | undefined,
  opts: Required<ComputerUseOptions>,
): string | undefined {
  if (x === undefined || y === undefined) return
  if (!Number.isFinite(x) || !Number.isFinite(y)) return `x/y must be finite numbers (got x=${x} y=${y})`
  const w = opts.displayWidth
  const h = opts.displayHeight
  if (x < 0 || x > w || y < 0 || y > h) return `coordinates out of bounds: (${x},${y}) not in 0..${w} x 0..${h}`
}

export const ComputerUsePlugin: Plugin = async (_ctx, rawOptions) => {
  const opts = resolveOptions(rawOptions as ComputerUseOptions | undefined)

  return {
    tool: {
      computer: tool({
        description: [
          "Computer-use tool — observe the desktop via screenshots and control it with mouse/keyboard.",
          "Actions: screenshot | click | double_click | right_click | move | drag | scroll | type | key | keypress | wait.",
          "Coordinates are in CSS pixels relative to the primary display (0,0 top-left).",
          `Display size: ${opts.displayWidth}x${opts.displayHeight}. Call screenshot first to see the screen.`,
          "Iterative loop: screenshot → decide action → call computer → receive new screenshot → repeat until task done.",
          "Always verify results with a follow-up screenshot.",
        ].join(" "),
        args: {
          action: tool.schema
            .enum(ALL_ACTIONS as unknown as [string, ...string[]])
            .describe("Action to perform. Use screenshot to capture screen, click/move/drag/scroll for mouse, type/key for keyboard, wait to pause."),
          // coordinates
          x: tool.schema.number().int().optional().describe("X coordinate (CSS pixels, 0..displayWidth)"),
          y: tool.schema.number().int().optional().describe("Y coordinate (CSS pixels, 0..displayHeight)"),
          button: tool.schema.enum(["left", "right", "middle"]).optional().describe("Mouse button"),
          // drag
          path: tool.schema
            .array(tool.schema.object({ x: tool.schema.number().int(), y: tool.schema.number().int() }))
            .optional()
            .describe("Drag path as array of {x,y} points (at least 2)"),
          // scroll
          scroll_x: tool.schema.number().int().optional().describe("Horizontal scroll amount (+right, -left)"),
          scroll_y: tool.schema.number().int().optional().describe("Vertical scroll amount (+down, -up)"),
          delta_x: tool.schema.number().int().optional().describe("Alias for scroll_x"),
          delta_y: tool.schema.number().int().optional().describe("Alias for scroll_y"),
          // typing
          text: tool.schema.string().optional().describe("Text to type (for type/key actions)"),
          keys: tool.schema.array(tool.schema.string()).optional().describe("Keys to press, e.g. [\"ctrl\",\"c\"] or [\"Enter\"] or [\"alt\",\"Tab\"]"),
          // timing
          ms: tool.schema.number().int().optional().describe("Wait duration in ms (for wait)"),
          duration_ms: tool.schema.number().int().optional().describe("Alias for ms"),
        },
        async execute(args, context) {
          const action = args.action as ComputerAction["action"]

          // Validate allow/deny
          const gate = isAllowed(action, opts)
          if (!gate.allowed) {
            return `Denied: ${gate.reason}. Check plugin options allowedActions/deniedActions.`
          }

          // Validate coordinates for actions that need them
          const needsCoords = ["click", "double_click", "right_click", "move", "scroll"].includes(action)
          if (needsCoords) {
            const err = validateCoords(args.x as number | undefined, args.y as number | undefined, opts)
            if (err) return `Invalid coordinates: ${err}`
            if (args.x === undefined || args.y === undefined) return `Invalid arguments: ${action} requires x and y`
          }
          if (action === "drag") {
            if (!args.path || args.path.length < 2) return `Invalid arguments: drag requires path with at least 2 points`
            for (const p of args.path) {
              const err = validateCoords(p.x, p.y, opts)
              if (err) return `Invalid drag path: ${err}`
            }
          }
          if ((action === "type" && !args.text) || ((action === "key" || action === "keypress") && !args.keys?.length)) {
            // key without keys is invalid; type without text is invalid
            if (action === "type" && !args.text) return `Invalid arguments: type requires text`
            if ((action === "key" || action === "keypress") && !args.keys?.length) return `Invalid arguments: ${action} requires keys[]`
          }

          // Runaway guard
          const count = (sessionCounts.get(context.sessionID) ?? 0) + 1
          sessionCounts.set(context.sessionID, count)
          if (count > opts.maxActionsPerSession) {
            return `Aborted: exceeded maxActionsPerSession=${opts.maxActionsPerSession}. Session ${context.sessionID} has used ${count} actions. Reset or increase limit in plugin options.`
          }

          // Permission prompt (maps to permission "computer" — user can allow/deny with wildcard patterns)
          if (opts.requireApproval) {
            const pattern = action === "screenshot" ? "screenshot" : `${action}:${args.x ?? ""},${args.y ?? ""}`
            await context.ask({
              permission: "computer",
              patterns: [action, pattern, "computer"],
              always: [action, "computer"],
              metadata: { action, x: args.x, y: args.y, button: (args as any).button, text: args.text, keys: args.keys },
            })
          }

          context.metadata({ title: `computer:${action}`, metadata: { action, x: args.x, y: args.y } })

          // Fail-safe corner: abort if target is (0,0) and require explicit opt-in? Just log.
          // Execute input synthesis (except screenshot)
          if (action !== "screenshot" && !context.abort.aborted) {
            const computerAction = normalizeToComputerAction(args as any)
            try {
              await executeAction(computerAction)
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              // Still capture screenshot so model can see error context
              try {
                const shot = await captureScreenWithTimeout(5000)
                return formatResult(action, `Action failed: ${msg}`, shot, count, opts)
              } catch {
                return `Action "${action}" failed: ${msg} (also failed to capture screenshot)`
              }
            }
            // Small settle delay so UI updates before screenshot
            if (action !== "wait") await sleep(150)
          }

          // Always return a screenshot observation (like ChatGPT/Anthropic computer-use loop)
          // This closes the loop: model sees the result of its action.
          let shot: Awaited<ReturnType<typeof captureScreen>> | null = null
          try {
            shot = await captureScreenWithTimeout(8000)
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return `Action "${action}" executed but screenshot failed: ${msg}. Count ${count}/${opts.maxActionsPerSession}.`
          }

          const hint = action === "screenshot" ? "Screenshot captured." : `Executed ${action}.`
          return formatResult(action, hint, shot, count, opts)
        },
      }),
    },
    "permission.ask": async (input, output) => {
      // Optional: demote computer permission to "allow" if requireApproval is false — already handled via ask skip.
      // Here we could auto-allow computer actions if plugin is configured to never ask, but we already skip ask.
      void input
      void output
    },
  }
}

export default ComputerUsePlugin

function normalizeToComputerAction(args: {
  action: string
  x?: number
  y?: number
  button?: string
  path?: Array<{ x: number; y: number }>
  scroll_x?: number
  scroll_y?: number
  delta_x?: number
  delta_y?: number
  text?: string
  keys?: string[]
  ms?: number
  duration_ms?: number
}): ComputerAction {
  switch (args.action) {
    case "screenshot":
      return { action: "screenshot" }
    case "click":
      return { action: "click", x: args.x!, y: args.y!, button: (args.button as any) ?? "left" }
    case "double_click":
      return { action: "double_click", x: args.x!, y: args.y!, button: (args.button as any) ?? "left" }
    case "right_click":
      return { action: "right_click", x: args.x!, y: args.y! }
    case "move":
      return { action: "move", x: args.x!, y: args.y! }
    case "drag":
      return { action: "drag", path: args.path!, button: (args.button as any) ?? "left" }
    case "scroll":
      return {
        action: "scroll",
        x: args.x!,
        y: args.y!,
        scroll_x: args.scroll_x ?? args.delta_x,
        scroll_y: args.scroll_y ?? args.delta_y,
      }
    case "type":
      return { action: "type", text: args.text! }
    case "key":
      return { action: "key", keys: args.keys!, text: args.text }
    case "keypress":
      return { action: "keypress", keys: args.keys! }
    case "wait":
      return { action: "wait", ms: args.ms ?? args.duration_ms }
    default:
      return { action: args.action as any }
  }
}

async function captureScreenWithTimeout(ms: number): Promise<Awaited<ReturnType<typeof captureScreen>>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Screenshot timed out after ${ms}ms`)), ms)
  })
  try {
    const result = await Promise.race([captureScreen(), timeout])
    return result as Awaited<ReturnType<typeof captureScreen>>
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function formatResult(
  action: string,
  hint: string,
  shot: { data: string; mime: string; width: number; height: number },
  count: number,
  opts: Required<ComputerUseOptions>,
): { title: string; output: string; metadata: Record<string, unknown>; attachments: Array<{ type: "file"; mime: string; url: string; filename?: string }> } {
  const output = [
    hint,
    `Display: ${shot.width}x${shot.height} (configured ${opts.displayWidth}x${opts.displayHeight}, scale ${opts.scaleFactor})`,
    `Action count: ${count}/${opts.maxActionsPerSession}`,
    `Next: call computer with the next action, or stop when task is complete.`,
  ].join("\n")
  return {
    title: `computer:${action} ${shot.width}x${shot.height}`,
    output,
    metadata: { action, width: shot.width, height: shot.height, count },
    attachments: [
      {
        type: "file" as const,
        mime: shot.mime,
        url: `data:${shot.mime};base64,${shot.data}`,
        filename: `screenshot-${Date.now()}.png`,
      },
    ],
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
