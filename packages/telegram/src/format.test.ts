import { describe, test, expect } from "bun:test"
import { formatTelegramText } from "./format"

describe("formatTelegramText", () => {
  test("returns empty string for empty input", () => {
    expect(formatTelegramText("")).toBe("")
  })

  test("normalizes CRLF line endings", () => {
    expect(formatTelegramText("hello\r\nworld")).toBe("hello\nworld")
  })

  test("strips table divider lines", () => {
    expect(formatTelegramText("Header\n---|---\nRow")).toBe("Header\nRow")
  })

  test("strips reasoning think tags", () => {
    expect(formatTelegramText("<think>internal thought</think>Hello world")).toBe("Hello world")
  })

  test("cleans up messy AI markdown response for Telegram", () => {
    const messy = "### Results\r\n| Status | Count |\r\n|---|---|\r\n| Success | 10 |\r\n"
    const expected = "### Results\n| Status | Count |\n| Success | 10 |"
    expect(formatTelegramText(messy)).toBe(expected)
  })
})
