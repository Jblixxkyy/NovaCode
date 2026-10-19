import { afterEach, describe, expect, test } from "bun:test"
import { BrowserPermissions } from "../src/permissions"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await Bun.$`rm -rf ${dir}`.quiet()
})

describe("isSensitive", () => {
  test("form and input operations are sensitive", () => {
    for (const operation of ["fill", "fill_form", "select", "check", "press", "files.upload", "files.drop", "evaluate"])
      expect(BrowserPermissions.isSensitive(operation)).toBe(true)
  })

  test("observation and navigation are not sensitive", () => {
    for (const operation of ["snapshot", "screenshot", "navigate", "tabs.open", "console", "network.list", "lighthouse"])
      expect(BrowserPermissions.isSensitive(operation)).toBe(false)
  })
})

describe("checkDomain", () => {
  test("empty ACL allows everything", () => {
    expect(() => BrowserPermissions.checkDomain("https://example.com/", { allow: [], deny: [] })).not.toThrow()
  })

  test("deny list blocks hosts and subdomains", () => {
    const acl = { allow: [], deny: ["evil.com"] }
    expect(() => BrowserPermissions.checkDomain("https://evil.com/", acl)).toThrow(BrowserPermissions.DomainDeniedError)
    expect(() => BrowserPermissions.checkDomain("https://sub.evil.com/x", acl)).toThrow(
      BrowserPermissions.DomainDeniedError,
    )
    expect(() => BrowserPermissions.checkDomain("https://good.com/", acl)).not.toThrow()
  })

  test("allow list restricts to listed hosts", () => {
    const acl = { allow: ["example.com"], deny: [] }
    expect(() => BrowserPermissions.checkDomain("https://example.com/", acl)).not.toThrow()
    expect(() => BrowserPermissions.checkDomain("https://www.example.com/", acl)).not.toThrow()
    expect(() => BrowserPermissions.checkDomain("https://other.com/", acl)).toThrow(BrowserPermissions.DomainDeniedError)
  })

  test("deny wins over allow", () => {
    const acl = { allow: ["example.com"], deny: ["example.com"] }
    expect(() => BrowserPermissions.checkDomain("https://example.com/", acl)).toThrow(
      BrowserPermissions.DomainDeniedError,
    )
  })
})

describe("loadACL", () => {
  test("missing file yields an empty ACL", async () => {
    const dir = `${import.meta.dir}/acl-${Date.now()}`
    dirs.push(dir)
    await Bun.$`mkdir -p ${dir}`.quiet()
    expect(await BrowserPermissions.loadACL(dir)).toEqual({ allow: [], deny: [] })
  })

  test("loads allow/deny lists", async () => {
    const dir = `${import.meta.dir}/acl-${Date.now()}-2`
    dirs.push(dir)
    await Bun.$`mkdir -p ${dir}`.quiet()
    await Bun.write(`${dir}/browser-acl.json`, JSON.stringify({ allow: ["a.com"], deny: ["b.com"] }))
    expect(await BrowserPermissions.loadACL(dir)).toEqual({ allow: ["a.com"], deny: ["b.com"] })
  })

  test("invalid JSON yields an empty ACL", async () => {
    const dir = `${import.meta.dir}/acl-${Date.now()}-3`
    dirs.push(dir)
    await Bun.$`mkdir -p ${dir}`.quiet()
    await Bun.write(`${dir}/browser-acl.json`, "not json")
    expect(await BrowserPermissions.loadACL(dir)).toEqual({ allow: [], deny: [] })
  })
})
