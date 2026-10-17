// Static UI assets the browser fetches without app-managed credentials, e.g.
// the manifest link in <head>. These bypass auth so the page can install/render
// the manifest icons even when a server password is configured.
export const PUBLIC_UI_PATHS = new Set<string>([
  "/site.webmanifest",
  "/web-app-manifest-192x192.png",
  "/web-app-manifest-512x512.png",
])

// Health and discovery must be reachable without credentials so a LAN webapp
// (e.g. http://192.168.1.25:4444) can probe the server and discover the
// desktop sidecar even when the server has a password.
export const PUBLIC_API_PATHS = new Set<string>([
  "/global/health",
  "/global/desktop-discovery",
  "/api/health",
])

export function isPublicAPIPath(method: string, pathname: string) {
  return method === "GET" && PUBLIC_API_PATHS.has(pathname)
}

export function isPublicUIPath(method: string, pathname: string) {
  return method === "GET" && PUBLIC_UI_PATHS.has(pathname)
}
