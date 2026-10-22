import { Schema } from "effect"
import type { BrowserPermissions } from "./permissions"
import { Browser } from "./rpc"

/**
 * Server ↔ desktop tunnel for the webview browser (phase 1).
 *
 * The desktop app's main process owns real WebContentsView tabs; the server
 * owns tools, permissions, and the panel. This module is the shared wire
 * contract plus the server-side host: the HTTP layer in packages/novacode
 * exposes the host to the desktop, and the Playwright Driver forwards
 * actions through it whenever a desktop is attached. See
 * plans/desktop-webview-plan.md.
 */

/** Panel-only coordinate click; not an agent tool action. */
export const ClickAtPointAction = Schema.Struct({
  type: Schema.Literal("clickAtPoint"),
  tabID: Browser.TabID,
  x: Schema.Number,
  y: Schema.Number,
}).annotate({ identifier: "Browser.DesktopClickAtPoint" })

/** Panel-only still frame of the focused tab (freeze/inspect + web fallback). */
export const PanelStillAction = Schema.Struct({
  type: Schema.Literal("panelStill"),
  tabID: Browser.TabID,
}).annotate({ identifier: "Browser.DesktopPanelStill" })

/**
 * Wire-only file delivery for files.upload / files.drop. The shared
 * Browser.Action for those operations carries server-local paths, which
 * are meaningless on the desktop side of the tunnel, so the Driver reads
 * the files through the server file registry and forwards their bytes
 * (base64, bounded by the same 5 MiB tool limit) for the executor to
 * hand to the page.
 */
export const FilesDeliverAction = Schema.Struct({
  type: Schema.Literal("files.deliver"),
  tabID: Browser.TabID,
  ref: Browser.Ref,
  mode: Schema.Literals(["upload", "drop"]),
  files: Schema.Array(Schema.Struct({ name: Schema.String, mime: Schema.String, data: Schema.String })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
  ),
}).annotate({ identifier: "Browser.DesktopFilesDeliver" })

/** Engage the CDP Overlay live inspect mode on a desktop tab. */
export const InspectStartAction = Schema.Struct({
  type: Schema.Literal("inspect.start"),
  tabID: Browser.TabID,
}).annotate({ identifier: "Browser.DesktopInspectStart" })

/** Disengage the CDP Overlay inspect mode on a desktop tab. */
export const InspectStopAction = Schema.Struct({
  type: Schema.Literal("inspect.stop"),
  tabID: Browser.TabID,
}).annotate({ identifier: "Browser.DesktopInspectStop" })

/** Everything that may travel from the server to an attached desktop. */
export const DesktopAction = Schema.Union([
  Browser.Action,
  ClickAtPointAction,
  PanelStillAction,
  FilesDeliverAction,
  InspectStartAction,
  InspectStopAction,
]).annotate({
  identifier: "Browser.DesktopAction",
})

const inspectBox = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
})

/**
 * Events that travel from the desktop back to the server outside the
 * command/response flow: live-inspect picks and cancellations, and the
 * in-page Ctrl+Shift+C request. The server queues them per scope and the
 * Driver drains them into the panel state.
 */
export const InspectEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("picked"),
    tabID: Browser.TabID,
    ref: Schema.String,
    box: inspectBox,
  }),
  Schema.Struct({ type: Schema.Literal("canceled"), tabID: Browser.TabID }),
  Schema.Struct({ type: Schema.Literal("inspectKey"), tabID: Browser.TabID }),
]).annotate({ identifier: "Browser.DesktopInspectEvent" })
export type InspectEvent = typeof InspectEvent.Type
export type DesktopAction = typeof DesktopAction.Type

export const DesktopOutcome = Schema.Union([
  Schema.Struct({ type: Schema.Literal("success"), result: Schema.Unknown }),
  Schema.Struct({
    type: Schema.Literal("failure"),
    code: Schema.Literals(["unsupported", "error", "detached"]),
    message: Schema.String,
  }),
]).annotate({ identifier: "Browser.DesktopOutcome" })
export type DesktopOutcome = typeof DesktopOutcome.Type

export interface DesktopCommand {
  readonly requestID: string
  readonly scope: string
  readonly action: DesktopAction
}

export interface DesktopViewport {
  readonly width: number
  readonly height: number
}

export interface PublishedState {
  readonly state: Browser.State
  readonly viewport?: DesktopViewport
}

/** Snapshot results cross the tunnel with their element boxes attached when requested. */
export interface DesktopSnapshotResult {
  readonly tab: Browser.Tab
  readonly content: string
  readonly truncated: boolean
  readonly boxes?: Readonly<Record<string, { x: number; y: number; width: number; height: number }>>
}

/** Screenshot results cross the tunnel as base64; the server materializes the file. */
export interface DesktopScreenshotResult {
  readonly tab: Browser.Tab
  readonly mime: string
  readonly data: string
}

export interface DesktopStillResult {
  readonly mime: string
  readonly data: string
}

/** A diagnostics capture produced on the desktop; the server materializes it like a screenshot. */
export interface DesktopFileData {
  readonly name: string
  readonly mime: string
  readonly data: string
}

export interface DesktopCaptureResult {
  readonly tab: Browser.Tab
  readonly file: DesktopFileData
}

export interface DesktopLighthouseResult {
  readonly tab: Browser.Tab
  readonly scores: Array<{ id: string; title: string; score: number | null }>
  readonly failures: Array<{ id: string; title: string; description: string }>
  readonly files: DesktopFileData[]
}

export class DesktopError extends Error {
  readonly code: "unsupported" | "error" | "detached" | "timeout" | "unavailable"
  constructor(code: DesktopError["code"], message: string) {
    super(message)
    this.name = "Browser.DesktopError"
    this.code = code
  }
}

const ATTACHMENT_TTL_MS = 30_000
const DEFAULT_EXECUTE_TIMEOUT_MS = 120_000

interface Pending {
  readonly resolve: (result: unknown) => void
  readonly reject: (error: DesktopError) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export type PollResult =
  | { readonly status: "command"; readonly command: DesktopCommand }
  | { readonly status: "timeout" }
  | { readonly status: "detached" }

/**
 * Process-wide tunnel host. One live attachment at a time (a new attach
 * replaces the previous one, like OpenCode); commands are scoped by the
 * Location directory of the Driver that issued them, and the desktop
 * publishes one authoritative tab inventory per scope.
 */
export class DesktopHost {
  constructor(private readonly ttlMs = ATTACHMENT_TTL_MS) {}

  private attachment: { id: string; client: string; lastSeen: number } | undefined
  private queue: DesktopCommand[] = []
  private pollers: Array<{ attachment: string; resolve: (result: PollResult) => void; timer: ReturnType<typeof setTimeout> }> =
    []
  private pending = new Map<string, Pending>()
  private published = new Map<string, PublishedState>()
  private inspectEvents = new Map<string, InspectEvent[]>()
  /**
   * The server's effective domain ACL (browser-acl.json), handed to each
   * attaching desktop so webview navigation enforces the same allow/deny
   * rules as the Playwright driver. Refreshed on every attach.
   */
  private acl: BrowserPermissions.DomainACL = { allow: [], deny: [] }

  attach(
    client: string,
    acl?: BrowserPermissions.DomainACL,
  ): { attachment: string; replaced: boolean; acl: BrowserPermissions.DomainACL } {
    if (acl) this.acl = acl
    const replaced = this.attachment !== undefined && this.live()
    if (this.attachment) this.drop("The desktop browser attachment was replaced by a newer desktop window.")
    const attachment = `attach_${crypto.randomUUID()}`
    this.attachment = { id: attachment, client, lastSeen: Date.now() }
    return { attachment, replaced, acl: this.acl }
  }

  detach(attachment: string): boolean {
    if (this.attachment?.id !== attachment) return false
    this.drop("The desktop browser detached.")
    this.attachment = undefined
    return true
  }

  /** Whether any desktop is currently attached (within the liveness TTL). */
  attached(): boolean {
    return this.attachment !== undefined && this.live()
  }

  /** Validate an attachment id and count the call as a heartbeat. */
  touch(attachment: string): boolean {
    if (this.attachment?.id !== attachment || !this.live()) return false
    this.attachment.lastSeen = Date.now()
    return true
  }

  /** Long-poll for the next command. Resolves "detached" when the attachment is gone. */
  poll(attachment: string, timeoutMs: number): Promise<PollResult> {
    if (!this.touch(attachment)) return Promise.resolve({ status: "detached" })
    const next = this.queue.shift()
    if (next) return Promise.resolve({ status: "command", command: next })
    return new Promise((resolve) => {
      const entry = {
        attachment,
        resolve,
        timer: setTimeout(() => {
          this.pollers = this.pollers.filter((poller) => poller !== entry)
          resolve({ status: "timeout" })
        }, timeoutMs),
      }
      this.pollers.push(entry)
    })
  }

  /** Record a command outcome from the desktop. Returns false for unknown requests. */
  complete(attachment: string, requestID: string, outcome: DesktopOutcome): boolean {
    if (!this.touch(attachment)) return false
    const pending = this.pending.get(requestID)
    if (!pending) return false
    this.pending.delete(requestID)
    clearTimeout(pending.timer)
    if (outcome.type === "success") pending.resolve(outcome.result)
    else pending.reject(new DesktopError(outcome.code, outcome.message))
    return true
  }

  /** Store the desktop's authoritative inventory for a scope. */
  publish(attachment: string, scope: string, state: Browser.State, viewport?: DesktopViewport): boolean {
    if (!this.touch(attachment)) return false
    this.published.set(scope, { state, viewport })
    return true
  }

  /** Queue a live-inspect event from the desktop for the panel to drain. Bounded; picks are user-paced. */
  publishInspect(attachment: string, scope: string, event: InspectEvent): boolean {
    if (!this.touch(attachment)) return false
    const queue = this.inspectEvents.get(scope) ?? []
    queue.push(event)
    if (queue.length > 20) queue.splice(0, queue.length - 20)
    this.inspectEvents.set(scope, queue)
    return true
  }

  /** Drain a scope's queued inspect events (each event is delivered exactly once). */
  takeInspectEvents(scope: string): InspectEvent[] {
    const queue = this.inspectEvents.get(scope)
    if (!queue || queue.length === 0) return []
    this.inspectEvents.delete(scope)
    return queue
  }

  stateFor(scope: string): PublishedState | undefined {
    if (!this.attached()) return undefined
    return this.published.get(scope)
  }

  /**
   * Send an action to the attached desktop and await its result.
   * Rejects with DesktopError: "unavailable" when nothing is attached,
   * "detached" if the attachment drops mid-flight, "timeout" past the bound.
   */
  execute(scope: string, action: DesktopAction, timeoutMs = DEFAULT_EXECUTE_TIMEOUT_MS): Promise<unknown> {
    if (!this.attached())
      return Promise.reject(
        new DesktopError("unavailable", "No desktop browser is attached. The desktop app may have closed."),
      )
    const requestID = `req_${crypto.randomUUID()}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestID)
        reject(
          new DesktopError(
            "timeout",
            `The desktop browser did not answer ${action.type} within ${Math.round(timeoutMs / 1000)} seconds.`,
          ),
        )
      }, timeoutMs)
      this.pending.set(requestID, { resolve, reject, timer })
      this.dispatch({ requestID, scope, action })
    })
  }

  private live(): boolean {
    return this.attachment !== undefined && Date.now() - this.attachment.lastSeen < this.ttlMs
  }

  private dispatch(command: DesktopCommand) {
    const poller = this.pollers.find((candidate) => candidate.attachment === this.attachment?.id)
    if (!poller) {
      this.queue.push(command)
      return
    }
    this.pollers = this.pollers.filter((candidate) => candidate !== poller)
    clearTimeout(poller.timer)
    poller.resolve({ status: "command", command })
  }

  /** Fail everything in flight; used on replace/detach. State publishes survive a replace only until the new desktop republishes. */
  private drop(message: string) {
    const error = new DesktopError("detached", message)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.queue = []
    for (const poller of this.pollers) {
      clearTimeout(poller.timer)
      poller.resolve({ status: "detached" })
    }
    this.pollers = []
    this.published.clear()
    this.inspectEvents.clear()
  }
}

/** The server process's one tunnel host, shared by the HTTP layer and every Driver. */
export const host = new DesktopHost()

export * as BrowserDesktop from "./desktop"
