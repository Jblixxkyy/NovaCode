import { Context } from "effect"

const trustedOrigin = /^https:\/\/([a-z0-9-]+\.)*(opencode|novacode)\.ai$/

export type CorsOptions = { readonly cors?: ReadonlyArray<string> }

export const CorsConfig = Context.Reference<CorsOptions | undefined>("@novacode/ServerCorsConfig", {
  defaultValue: () => undefined,
})

export function isAllowedCorsOrigin(input: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (input.startsWith("http://localhost:")) return true
  if (input.startsWith("http://127.0.0.1:")) return true
  // LAN origins for when web app is opened via 192.168.x.x / 10.x / 172.16-31.x
  if (/^http:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(input)) return true
  if (input.startsWith("oc://renderer")) return true
  if (input === "tauri://localhost" || input === "http://tauri.localhost" || input === "https://tauri.localhost")
    return true
  if (trustedOrigin.test(input)) return true
  return opts?.cors?.includes(input) ?? false
}

export function isAllowedRequestOrigin(input: string | undefined, host: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (host && sameHost(input, host)) return true
  return isAllowedCorsOrigin(input, opts)
}

function sameHost(origin: string, host: string) {
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}
