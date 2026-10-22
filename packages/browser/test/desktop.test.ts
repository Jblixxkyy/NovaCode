import { describe, expect, test } from "bun:test"
import { BrowserDesktop } from "../src/desktop"
import { Browser } from "../src/rpc"

const { DesktopHost, DesktopError } = BrowserDesktop

describe("DesktopHost", () => {
  test("execute rejects as unavailable with no attachment", async () => {
    const host = new DesktopHost()
    expect(host.attached()).toBe(false)
    await expect(host.execute("scope", { type: "tabs.list" })).rejects.toMatchObject({ code: "unavailable" })
  })

  test("attach hands the desktop the server domain ACL and refreshes it per attach", () => {
    const host = new BrowserDesktop.DesktopHost()
    const first = host.attach("test-client", { allow: ["example.com"], deny: ["evil.com"] })
    expect(first.acl).toEqual({ allow: ["example.com"], deny: ["evil.com"] })
    const second = host.attach("test-client")
    expect(second.acl).toEqual({ allow: ["example.com"], deny: ["evil.com"] })
    const third = host.attach("test-client", { allow: [], deny: [] })
    expect(third.acl).toEqual({ allow: [], deny: [] })
  })

  test("attach, poll, and complete round-trip a command", async () => {
    const host = new DesktopHost()
    const { attachment, replaced } = host.attach("test-client")
    expect(replaced).toBe(false)
    expect(host.attached()).toBe(true)

    const result = host.execute("/work", { type: "tabs.open", url: "https://example.com" })
    const polled = await host.poll(attachment, 1_000)
    expect(polled.status).toBe("command")
    if (polled.status !== "command") throw new Error("expected a command")
    expect(polled.command.scope).toBe("/work")
    expect(polled.command.action).toEqual({ type: "tabs.open", url: "https://example.com" })

    expect(host.complete(attachment, polled.command.requestID, { type: "success", result: { id: "tab_x" } })).toBe(true)
    await expect(result).resolves.toEqual({ id: "tab_x" })
  })

  test("failure outcomes reject with the desktop's code and message", async () => {
    const host = new DesktopHost()
    const { attachment } = host.attach("test-client")
    const result = host.execute("scope", { type: "tabs.list" })
    const polled = await host.poll(attachment, 1_000)
    if (polled.status !== "command") throw new Error("expected a command")
    expect(host.complete(attachment, polled.command.requestID, {
      type: "failure",
      code: "unsupported",
      message: "This desktop does not support the requested browser operation.",
    })).toBe(true)
    const error = await result.catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(DesktopError)
    expect(error).toMatchObject({ code: "unsupported", message: "This desktop does not support the requested browser operation." })
  })

  test("poll times out with no command and completes unknown requests as false", async () => {
    const host = new DesktopHost()
    const { attachment } = host.attach("test-client")
    await expect(host.poll(attachment, 20)).resolves.toEqual({ status: "timeout" })
    expect(host.complete(attachment, "req_missing", { type: "success", result: null })).toBe(false)
    expect(host.complete("attach_wrong", "req_missing", { type: "success", result: null })).toBe(false)
  })

  test("execute times out when the desktop never answers", async () => {
    const host = new DesktopHost()
    host.attach("test-client")
    await expect(host.execute("scope", { type: "tabs.list" }, 30)).rejects.toMatchObject({ code: "timeout" })
  })

  test("a new attach replaces the old one and fails its in-flight work", async () => {
    const host = new DesktopHost()
    const first = host.attach("first")
    const inFlight = host.execute("scope", { type: "tabs.list" })

    const second = host.attach("second")
    expect(second.replaced).toBe(true)
    await expect(inFlight).rejects.toMatchObject({ code: "detached" })
    await expect(host.poll(first.attachment, 10)).resolves.toEqual({ status: "detached" })
    expect(host.touch(first.attachment)).toBe(false)
    expect(host.attached()).toBe(true)
  })

  test("detach resolves parked polls as detached and clears published state", async () => {
    const host = new DesktopHost()
    const { attachment } = host.attach("test-client")
    host.publish(attachment, "/work", { tabs: [], focusedTabID: null })
    expect(host.stateFor("/work")).toEqual({ state: { tabs: [], focusedTabID: null } })

    const parked = host.poll(attachment, 5_000)
    expect(host.detach(attachment)).toBe(true)
    await expect(parked).resolves.toEqual({ status: "detached" })
    expect(host.attached()).toBe(false)
    expect(host.stateFor("/work")).toBeUndefined()
    expect(host.detach(attachment)).toBe(false)
  })

  test("published state is stored per scope with its viewport", () => {
    const host = new DesktopHost()
    const { attachment } = host.attach("test-client")
    const tabID = Browser.TabID.make("tab_00000000-0000-4000-8000-000000000000")
    const state: Browser.State = {
      tabs: [
        {
          id: tabID,
          url: "https://example.com",
          title: "Example",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          generation: 1,
        },
      ],
      focusedTabID: tabID,
    }
    expect(host.publish(attachment, "/work", state, { width: 900, height: 600 })).toBe(true)
    expect(host.stateFor("/work")?.viewport).toEqual({ width: 900, height: 600 })
    expect(host.stateFor("/other")).toBeUndefined()
    expect(host.publish("attach_wrong", "/work", state)).toBe(false)
  })

  test("attachments expire after the liveness TTL", async () => {
    const host = new DesktopHost(30)
    host.attach("test-client")
    expect(host.attached()).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(host.attached()).toBe(false)
    await expect(host.execute("scope", { type: "tabs.list" })).rejects.toMatchObject({ code: "unavailable" })
  })
})
