import { describe, expect, test } from "bun:test"
import { sessionMatchesHomeProjects } from "./home-session-match"
import type { Session } from "@novacode-ai/sdk/v2/client"

const session = (input: { directory: string; projectID?: string }) =>
  ({
    id: "ses_1",
    directory: input.directory,
    projectID: input.projectID,
  }) as Session

describe("sessionMatchesHomeProjects", () => {
  const project = {
    id: "25ad1233636954c079cdd11aa9687d0583106cd0",
    worktree: "C:/Users/jblix/Documents/work/novacode/novacode",
    sandboxes: [] as string[],
    expanded: true,
  }

  test("keeps sessions at the open project directory", () => {
    expect(
      sessionMatchesHomeProjects(session({ directory: project.worktree, projectID: project.id }), [project.worktree], [
        project,
      ]),
    ).toBe(true)
  })

  test("keeps sessions for the same project after the folder moved", () => {
    expect(
      sessionMatchesHomeProjects(
        session({ directory: "C:/Users/jblix/Downloads/novacode/novacode", projectID: project.id }),
        [project.worktree],
        [project],
      ),
    ).toBe(true)
  })

  test("does not attach global sessions to an unrelated project", () => {
    expect(
      sessionMatchesHomeProjects(session({ directory: "C:/Users/jblix", projectID: "global" }), [project.worktree], [
        project,
      ]),
    ).toBe(false)
  })
})
