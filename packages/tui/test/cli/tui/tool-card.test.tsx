/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { testRender, type JSX } from "@opentui/solid"
import { BasicTool } from "../../../src/ui/basic-tool"
import { ThemeProvider } from "../../../src/context/theme"
import { KVProvider } from "../../../src/context/kv"
import { TuiConfigProvider } from "../../../src/config"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

function withTheme(component: () => JSX.Element) {
  return (
    <TestTuiContexts>
      <TuiConfigProvider config={createTuiResolvedConfig()}>
        <KVProvider>
          <ThemeProvider mode="dark">{component()}</ThemeProvider>
        </KVProvider>
      </TuiConfigProvider>
    </TestTuiContexts>
  )
}

async function renderOnceSettled(app: Awaited<ReturnType<typeof testRender>>) {
  await app.renderOnce()
  await new Promise((resolve) => setTimeout(resolve, 25))
  await app.renderOnce()
}

async function captureSettledFrame(app: Awaited<ReturnType<typeof testRender>>) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const frame = app.captureCharFrame()
    if (frame.trim().length > 0) return frame
    await new Promise((resolve) => setTimeout(resolve, 25))
    await app.renderOnce()
  }
  return app.captureCharFrame()
}

async function renderFrame(component: () => JSX.Element, options: { width: number; height: number }) {
  testSetup = await testRender(() => withTheme(component), options)
  await renderOnceSettled(testSetup)
  return captureSettledFrame(testSetup)
}

describe("TUI tool cards", () => {
  test("renders the tool title and subtitle", async () => {
    const frame = await renderFrame(
      () => <BasicTool icon="$" status="completed" trigger={{ title: "Shell", subtitle: "bun run dev" }} />,
      { width: 60, height: 6 },
    )

    expect(frame).toContain("Shell")
    expect(frame).toContain("bun run dev")
  })

  test("keeps the tool body hidden until the card is expanded", async () => {
    const frame = await renderFrame(
      () => (
        <BasicTool icon="$" status="completed" trigger={{ title: "Shell", subtitle: "bun run dev" }}>
          <text>command output</text>
        </BasicTool>
      ),
      { width: 60, height: 8 },
    )

    expect(frame).toContain("Shell")
    expect(frame).not.toContain("command output")
  })

  test("shows the tool body when the card starts expanded", async () => {
    const frame = await renderFrame(
      () => (
        <BasicTool
          icon="$"
          status="completed"
          defaultOpen={true}
          trigger={{ title: "Shell", subtitle: "bun run dev" }}
        >
          <text>command output</text>
        </BasicTool>
      ),
      { width: 60, height: 8 },
    )

    expect(frame).toContain("Shell")
    expect(frame).toContain("command output")
  })

  test("surfaces the failure message of an errored tool", async () => {
    const frame = await renderFrame(
      () => (
        <BasicTool
          icon="$"
          status="error"
          error="Command exited with code 1"
          trigger={{ title: "Shell", subtitle: "bun run dev" }}
        />
      ),
      { width: 60, height: 8 },
    )

    expect(frame).toContain("Command exited with code 1")
  })

  test("renders argument chips alongside the subtitle", async () => {
    const frame = await renderFrame(
      () => (
        <BasicTool
          icon="✱"
          status="completed"
          trigger={{ title: "Grep", subtitle: "{pattern}", args: ["in src/core"] }}
        />
      ),
      { width: 60, height: 6 },
    )

    expect(frame).toContain("Grep")
    expect(frame).toContain("{pattern}")
    expect(frame).toContain("in src/core")
  })
})
