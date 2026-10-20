
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"

/** Operations that can change web state or submit data: always ask, even with a broad browser grant. */
export const SENSITIVE_OPERATIONS: ReadonlySet<string> = new Set([
  "fill",
  "fill_form",
  "select",
  "check",
  "press",
  "files.upload",
  "files.drop",
  "evaluate",
])

export function isSensitive(operation: string): boolean {
  return SENSITIVE_OPERATIONS.has(operation)
}

export interface DomainACL {
  readonly allow: ReadonlyArray<string>
  readonly deny: ReadonlyArray<string>
}

const emptyACL: DomainACL = { allow: [], deny: [] }

/** Load the domain allow/deny list from the NovaCode config dir. Missing or invalid file means no list. */
export async function loadACL(configDir: string): Promise<DomainACL> {
  try {
    const parsed = JSON.parse(await readFile(path.join(configDir, "browser-acl.json"), "utf8")) as Partial<DomainACL>
    return {
      allow: Array.isArray(parsed.allow) ? parsed.allow.filter((d) => typeof d === "string") : [],
      deny: Array.isArray(parsed.deny) ? parsed.deny.filter((d) => typeof d === "string") : [],
    }
  } catch {
    return emptyACL
  }
}

export class DomainDeniedError extends Schema.TaggedErrorClass<DomainDeniedError>()("Browser.DomainDeniedError", {
  message: Schema.String,
}) {}

/**
 * Enforce the domain ACL for a navigation target. Deny-listed hosts always fail;
 * when an allow list is configured, only listed hosts pass.
 */
export function checkDomain(url: string, acl: DomainACL): void {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return
  }
  const matches = (pattern: string) => {
    const value = pattern.toLowerCase()
    return host === value || host.endsWith(`.${value}`)
  }
  if (acl.deny.some(matches)) throw new DomainDeniedError({ message: `Navigation to ${host} is denied by browser-acl.json.` })
  if (acl.allow.length > 0 && !acl.allow.some(matches))
    throw new DomainDeniedError({ message: `Navigation to ${host} is not in the browser-acl.json allow list.` })
}


export * as BrowserPermissions from "./permissions"
