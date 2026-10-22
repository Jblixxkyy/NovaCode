
import { Schema } from "effect"
import { Browser } from "./rpc"
import { BrowserFiles } from "./files"
import { BrowserPermissions } from "./permissions"
import { BrowserSession } from "./session"

export interface RunContext {
  /** Server working directory for resolving relative upload and preview paths. */
  readonly directory: string
}

export interface Attachment {
  readonly mime: string
  readonly data: Uint8Array
  readonly name: string
}

export interface RunResult {
  readonly output: unknown
  readonly attachments: ReadonlyArray<Attachment>
}

type AnyCodec = Schema.Codec<any, any, never, never>

export interface Definition {
  readonly name: string
  readonly description: string
  readonly input: AnyCodec
  readonly output: AnyCodec
  readonly sensitive: boolean
  /** Permission resources for this call: the target URL, tab ID, or file path. */
  readonly resources: (input: any) => ReadonlyArray<string>
  readonly run: (driver: BrowserSession.Driver, input: any, context: RunContext) => Promise<RunResult>
}

const operations = new Map<Browser.Method, Browser.Operation>(
  Browser.Operations.map((operation) => [operation.name, operation]),
)

const tabResources = (input: { tabID: string }): ReadonlyArray<string> => [input.tabID]
const noResources = (): ReadonlyArray<string> => []
const done = (output: unknown): RunResult => ({ output, attachments: [] })

function define(
  method: Browser.Method,
  init: {
    readonly resources: (input: any) => ReadonlyArray<string>
    readonly run: (driver: BrowserSession.Driver, input: any, context: RunContext) => Promise<RunResult>
  },
): Definition {
  const operation = operations.get(method)
  if (!operation) throw new Error(`Unknown browser operation: ${method}`)
  return {
    name: `browser.${method}`,
    description: operation.description,
    input: operation.input,
    output: operation.output,
    sensitive: BrowserPermissions.isSensitive(method),
    resources: init.resources,
    run: init.run,
  }
}

function resolvePath(directory: string, path: string): string {
  return path.startsWith("/") ? path : `${directory}/${path}`
}

export const definitions: ReadonlyArray<Definition> = [
  define("tabs.list", {
    resources: noResources,
    run: (driver) => driver.fetchState().then(done),
  }),
  define("tabs.open", {
    resources: (input) => (input.url ? [input.url] : []),
    run: (driver, input) => driver.openTab(input.url, input.focus).then(done),
  }),
  define("tabs.focus", {
    resources: tabResources,
    run: (driver, input) => driver.focusTab(input.tabID).then(done),
  }),
  define("tabs.close", {
    resources: tabResources,
    run: (driver, input) => driver.closeTab(input.tabID).then(done),
  }),
  define("preview", {
    resources: (input) => [input.path],
    run: (driver, input, context) => driver.preview(resolvePath(context.directory, input.path)).then(done),
  }),
  define("navigate", {
    resources: (input) => [input.url],
    run: (driver, input) => driver.navigate(input.tabID, input.url).then(done),
  }),
  define("back", {
    resources: tabResources,
    run: (driver, input) => driver.back(input.tabID).then(done),
  }),
  define("forward", {
    resources: tabResources,
    run: (driver, input) => driver.forward(input.tabID).then(done),
  }),
  define("reload", {
    resources: tabResources,
    run: (driver, input) => driver.reload(input.tabID).then(done),
  }),
  define("stop", {
    resources: tabResources,
    run: (driver, input) => driver.stop(input.tabID).then(done),
  }),
  define("frames", {
    resources: tabResources,
    run: (driver, input) => driver.frames(input.tabID).then(done),
  }),
  define("snapshot", {
    resources: tabResources,
    run: (driver, input) =>
      driver
        .snapshot(input.tabID, { frameID: input.frameID, ref: input.ref, depth: input.depth, boxes: input.boxes })
        .then(done),
  }),
  define("find", {
    resources: tabResources,
    run: (driver, input) => driver.find(input.tabID, { frameID: input.frameID, text: input.text }).then(done),
  }),
  define("evaluate", {
    resources: tabResources,
    run: (driver, input) =>
      driver.evaluate(input.tabID, { frameID: input.frameID, ref: input.ref, script: input.script }).then(done),
  }),
  define("click", {
    resources: tabResources,
    run: (driver, input) =>
      driver.click(input.tabID, { ref: input.ref, button: input.button, count: input.count, modifiers: input.modifiers }).then(done),
  }),
  define("hover", {
    resources: tabResources,
    run: (driver, input) => driver.hover(input.tabID, { ref: input.ref }).then(done),
  }),
  define("drag", {
    resources: tabResources,
    run: (driver, input) => driver.drag(input.tabID, { from: input.from, to: input.to }).then(done),
  }),
  define("fill", {
    resources: tabResources,
    run: (driver, input) => driver.fill(input.tabID, { ref: input.ref, text: input.text }).then(done),
  }),
  define("fill_form", {
    resources: tabResources,
    run: (driver, input) => driver.fillForm(input.tabID, { fields: input.fields }).then(done),
  }),
  define("select", {
    resources: tabResources,
    run: (driver, input) => driver.select(input.tabID, { ref: input.ref, values: input.values }).then(done),
  }),
  define("check", {
    resources: tabResources,
    run: (driver, input) => driver.check(input.tabID, { ref: input.ref, checked: input.checked }).then(done),
  }),
  define("press", {
    resources: tabResources,
    run: (driver, input) => driver.press(input.tabID, { key: input.key }).then(done),
  }),
  define("scroll", {
    resources: tabResources,
    run: (driver, input) => driver.scroll(input.tabID, { deltaX: input.deltaX, deltaY: input.deltaY }).then(done),
  }),
  define("wait", {
    resources: tabResources,
    run: (driver, input) =>
      driver
        .wait(input.tabID, { frameID: input.frameID, condition: input.condition, text: input.text, timeoutMs: input.timeoutMs })
        .then(done),
  }),
  define("screenshot", {
    resources: tabResources,
    run: (driver, input) =>
      driver
        .screenshot(input.tabID, {
          ref: input.ref,
          fullPage: input.fullPage,
          format: input.format,
          quality: input.quality,
          maxWidth: input.maxWidth,
        })
        .then(({ tab, files, mime, data }) => ({
          output: { tab, files },
          attachments: [{ mime, data, name: `screenshot.${input.format ?? "png"}` }],
        })),
  }),
  define("dialog", {
    resources: tabResources,
    run: (driver, input) => driver.dialog(input.tabID, { action: input.action, promptText: input.promptText }).then(done),
  }),
  define("files.upload", {
    resources: tabResources,
    run: (driver, input, context) =>
      BrowserFiles.read(input.paths, context.directory).then((files) =>
        driver.filesUpload(input.tabID, { ref: input.ref, files }),
      ).then(done),
  }),
  define("files.drop", {
    resources: tabResources,
    run: (driver, input, context) =>
      BrowserFiles.read(input.paths, context.directory).then((files) =>
        driver.filesDrop(input.tabID, { ref: input.ref, files }),
      ).then(done),
  }),
  define("files.list", {
    resources: tabResources,
    run: (driver, input) => Promise.resolve(done(driver.filesList(input.tabID))),
  }),
  define("files.get", {
    resources: tabResources,
    run: (driver, input) => driver.filesGet(input.tabID, input.fileID).then(done),
  }),
  define("console", {
    resources: tabResources,
    run: (driver, input) => Promise.resolve(done(driver.console(input.tabID, { level: input.level, limit: input.limit }))),
  }),
  define("network.list", {
    resources: tabResources,
    run: (driver, input) =>
      Promise.resolve(
        done(driver.networkList(input.tabID, { urlContains: input.urlContains, resourceType: input.resourceType, limit: input.limit })),
      ),
  }),
  define("network.get", {
    resources: tabResources,
    run: (driver, input) =>
      driver.networkGet(input.tabID, { id: input.id, includeBody: input.includeBody, maxBodyChars: input.maxBodyChars }).then(done),
  }),
  define("trace.start", {
    resources: tabResources,
    run: (driver, input) => driver.traceStart(input.tabID, input.durationMs).then(done),
  }),
  define("trace.stop", {
    resources: tabResources,
    run: (driver, input) => driver.traceStop(input.tabID).then(done),
  }),
  define("trace.analyze", {
    resources: tabResources,
    run: (driver, input) => driver.traceAnalyze(input.tabID, { fileID: input.fileID, limit: input.limit }).then(done),
  }),
  define("cpu.start", {
    resources: tabResources,
    run: (driver, input) => driver.cpuStart(input.tabID).then(done),
  }),
  define("cpu.stop", {
    resources: tabResources,
    run: (driver, input) => driver.cpuStop(input.tabID).then(done),
  }),
  define("cpu.analyze", {
    resources: tabResources,
    run: (driver, input) => driver.cpuAnalyze(input.tabID, { fileID: input.fileID, limit: input.limit }).then(done),
  }),
  define("heap.snapshot", {
    resources: tabResources,
    run: (driver, input) => driver.heapSnapshot(input.tabID).then(done),
  }),
  define("heap.summary", {
    resources: tabResources,
    run: (driver, input) => driver.heapSummary(input.tabID, { fileID: input.fileID, limit: input.limit }).then(done),
  }),
  define("heap.query", {
    resources: tabResources,
    run: (driver, input) => driver.heapQuery(input.tabID, { fileID: input.fileID, name: input.name, limit: input.limit }).then(done),
  }),
  define("heap.object", {
    resources: tabResources,
    run: (driver, input) => driver.heapObject(input.tabID, { fileID: input.fileID, id: input.id, limit: input.limit }).then(done),
  }),
  define("heap.compare", {
    resources: tabResources,
    run: (driver, input) => driver.heapCompare(input.tabID, { before: input.before, after: input.after, limit: input.limit }).then(done),
  }),
  define("lighthouse", {
    resources: tabResources,
    run: (driver, input) => driver.lighthouse(input.tabID).then(done),
  }),
]



export * as BrowserTools from "./tools"
