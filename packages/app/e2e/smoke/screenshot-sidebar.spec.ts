import { expect, test } from "@playwright/test"
import { base64Encode } from "@novacode-ai/core/util/encode"
import { fixture, pageMessages } from "./session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

test("capture sidebar screenshot", async ({ page }) => {
  await mockOpenCodeServer(page, {
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  
  await page.addInitScript(() => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({
        general: {
          editToolPartsExpanded: true,
          shellToolPartsExpanded: true,
          showReasoningSummaries: true,
        },
      }),
    )
  })

  await page.addInitScript((directory) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: {
          local: [{ worktree: directory, expanded: true }],
        },
        lastProject: {
          local: directory,
        },
      }),
    )
  }, fixture.directory)

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/${base64Encode(fixture.directory)}/session/${fixture.targetID}`)
  await expectSessionTitle(page, fixture.expected.targetTitle)
  await page.waitForSelector("[data-message-id]", { timeout: 15_000 })

  await page.screenshot({ path: "packages/app/e2e/test-results/full-app.png" })
  
  const sidebar = page.locator("aside, nav, [data-component='sidebar'], .sidebar").first()
  if (await sidebar.isVisible()) {
    await sidebar.screenshot({ path: "packages/app/e2e/test-results/sidebar.png" })
  } else {
    await page.screenshot({ path: "packages/app/e2e/test-results/sidebar.png", clip: { x: 0, y: 0, width: 320, height: 800 } })
  }
})
