import type { Session } from "@novacode-ai/sdk/v2/client"
import { pathKey } from "@/utils/path-key"

export function sessionMatchesHomeProjects(
  session: Pick<Session, "directory" | "projectID">,
  projectDirectories: string[],
  projects: Array<{ id?: string; worktree: string; sandboxes?: string[] }>,
) {
  const directorySet = new Set(projectDirectories.map(pathKey))
  if (directorySet.has(pathKey(session.directory))) return true
  if (!session.projectID || session.projectID === "global") return false
  return projects.some(
    (project) =>
      project.id === session.projectID &&
      [project.worktree, ...(project.sandboxes ?? [])].some((directory) => directorySet.has(pathKey(directory))),
  )
}
