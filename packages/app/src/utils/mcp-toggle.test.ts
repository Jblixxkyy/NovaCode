import { describe, expect, test } from "bun:test"
import {
  connectedMcpServerNames,
  reconnectableMcpServerNames,
  reconnectedMcpServerNames,
  type McpStatusMap,
} from "./mcp-toggle"

const statuses: McpStatusMap = {
  photocraft: { status: "connected" },
  filesystem: { status: "disabled" },
  broken: { status: "failed", error: "connection refused" },
  oauth: { status: "needs_auth" },
  registering: { status: "needs_client_registration", error: "no client id" },
  starting: { status: "pending" },
  gone: undefined,
}

describe("connectedMcpServerNames", () => {
  test("returns only the connected servers", () => {
    expect(connectedMcpServerNames(statuses)).toEqual(["photocraft"])
  })

  test("returns an empty list when nothing is connected", () => {
    expect(connectedMcpServerNames({ filesystem: { status: "disabled" } })).toEqual([])
    expect(connectedMcpServerNames({})).toEqual([])
  })
})

describe("reconnectableMcpServerNames", () => {
  test("returns only disabled or failed servers from the remembered list", () => {
    expect(
      reconnectableMcpServerNames(
        ["filesystem", "broken", "photocraft", "oauth", "registering", "starting", "missing"],
        statuses,
      ),
    ).toEqual(["filesystem", "broken"])
  })

  test("returns an empty list when nothing can be reconnected", () => {
    expect(reconnectableMcpServerNames(["photocraft", "oauth"], statuses)).toEqual([])
    expect(reconnectableMcpServerNames([], statuses)).toEqual([])
  })
})

describe("reconnectedMcpServerNames", () => {
  test("returns the remembered servers that are already connected", () => {
    expect(reconnectedMcpServerNames(["photocraft", "filesystem", "broken"], statuses)).toEqual(["photocraft"])
  })
})
