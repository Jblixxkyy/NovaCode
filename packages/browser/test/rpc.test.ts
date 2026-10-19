import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Browser } from "../src/rpc"

describe("branded types", () => {
  test("TabID accepts tab_ prefixed UUIDs", () => {
    const id = `tab_${crypto.randomUUID()}`
    expect(() => Schema.decodeUnknownSync(Browser.TabID)(id)).not.toThrow()
    expect(() => Schema.decodeUnknownSync(Browser.TabID)("tab_123")).toThrow()
    expect(() => Schema.decodeUnknownSync(Browser.TabID)("nope")).toThrow()
  })

  test("Ref accepts e1 style refs with optional @", () => {
    expect(String(Schema.decodeUnknownSync(Browser.Ref)("e12"))).toBe("e12")
    expect(String(Schema.decodeUnknownSync(Browser.Ref)("@e3"))).toBe("@e3")
    expect(() => Schema.decodeUnknownSync(Browser.Ref)("e0")).toThrow()
    expect(() => Schema.decodeUnknownSync(Browser.Ref)("12")).toThrow()
  })

  test("FileID accepts file_ prefixed UUIDs", () => {
    expect(() => Schema.decodeUnknownSync(Browser.FileID)(`file_${crypto.randomUUID()}`)).not.toThrow()
    expect(() => Schema.decodeUnknownSync(Browser.FileID)("file_x")).toThrow()
  })
})

describe("Operations", () => {
  test("all 45 operations are present with unique names", () => {
    expect(Browser.Operations).toHaveLength(45)
    const names = Browser.Operations.map((operation) => operation.name)
    expect(new Set(names).size).toBe(45)
  })

  test("expected operation names exist", () => {
    const names = new Set(Browser.Operations.map((operation) => operation.name))
    for (const name of [
      "tabs.list",
      "tabs.open",
      "tabs.focus",
      "tabs.close",
      "preview",
      "navigate",
      "back",
      "forward",
      "reload",
      "stop",
      "frames",
      "snapshot",
      "find",
      "evaluate",
      "click",
      "hover",
      "drag",
      "fill",
      "fill_form",
      "select",
      "check",
      "press",
      "scroll",
      "wait",
      "screenshot",
      "dialog",
      "files.upload",
      "files.drop",
      "files.list",
      "files.get",
      "console",
      "network.list",
      "network.get",
      "trace.start",
      "trace.stop",
      "trace.analyze",
      "cpu.start",
      "cpu.stop",
      "cpu.analyze",
      "heap.snapshot",
      "heap.summary",
      "heap.query",
      "heap.object",
      "heap.compare",
      "lighthouse",
    ])
      expect(names.has(name as Browser.Method)).toBe(true)
  })

  test("every operation has a description and input/output schemas", () => {
    for (const operation of Browser.Operations) {
      expect(operation.description.length).toBeGreaterThan(10)
      expect(operation.input).toBeDefined()
      expect(operation.output).toBeDefined()
    }
  })
})

describe("normalizeAction", () => {
  const tabID = () => Browser.TabID.make(`tab_${crypto.randomUUID()}`)
  const navigate = (url: string) => Browser.normalizeAction({ type: "navigate", tabID: tabID(), url })

  test("bare hostnames gain https", () => {
    const action = navigate("example.com")
    expect(action.type).toBe("navigate")
    if (action.type === "navigate") expect(action.url).toBe("https://example.com/")
  })

  test("localhost gains http", () => {
    const action = navigate("localhost:3000/app")
    if (action.type === "navigate") expect(action.url).toBe("http://localhost:3000/app")
  })

  test("about:blank passes through", () => {
    const action = navigate("about:blank")
    if (action.type === "navigate") expect(action.url).toBe("about:blank")
  })

  test("filesystem paths are rejected", () => {
    expect(() => navigate("/tmp/x")).toThrow(Browser.InvalidURLError)
    expect(() => navigate("./relative")).toThrow(Browser.InvalidURLError)
    expect(() => navigate("C:\\Windows")).toThrow(Browser.InvalidURLError)
  })

  test("file:// URLs are rejected", () => {
    expect(() => navigate("file:///etc/passwd")).toThrow(Browser.InvalidURLError)
  })

  test("URLs with credentials are rejected", () => {
    expect(() => navigate("https://user:pass@example.com")).toThrow(Browser.InvalidURLError)
  })

  test("non-navigate actions pass through untouched", () => {
    const id = tabID()
    const action = Browser.normalizeAction({ type: "back", tabID: id })
    expect(action).toEqual({ type: "back", tabID: id })
  })

  test("tabs.open without URL passes through", () => {
    const action = Browser.normalizeAction({ type: "tabs.open" })
    expect(action).toEqual({ type: "tabs.open" })
  })
})
