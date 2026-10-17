import { describe, expect, test } from "bun:test"
import { APP_NAME, appEnv, appEnvTruthy, isAppConfigDir } from "@novacode-ai/core/identity"

describe("identity", () => {
  test("product name is novacode", () => {
    expect(APP_NAME).toBe("novacode")
  })

  test("appEnv reads NOVACODE_ variables only", () => {
    const previous = process.env.NOVACODE_CONFIG
    process.env.NOVACODE_CONFIG = "/new"
    expect(appEnv("NOVACODE_CONFIG")).toBe("/new")
    if (previous === undefined) delete process.env.NOVACODE_CONFIG
    else process.env.NOVACODE_CONFIG = previous
  })

  test("appEnvTruthy and config dir detection", () => {
    expect(appEnvTruthy("NOVACODE_PURE")).toBe(false)
    expect(isAppConfigDir("/repo/.novacode")).toBe(true)
    expect(isAppConfigDir("/repo/.novacode")).toBe(false)
    expect(isAppConfigDir("/repo/src")).toBe(false)
  })
})
