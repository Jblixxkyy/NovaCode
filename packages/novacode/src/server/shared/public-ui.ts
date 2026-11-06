// Static UI assets the browser fetches without app-managed credentials, e.g.
// the manifest link in <head>. These bypass auth so the page can install/render
// the manifest icons even when a server password is configured.
export const PUBLIC_UI_PATHS = new Set<string>([
  "/site.webmanifest",
  "/web-app-manifest-192x192.png",
  "/web-app-manifest-512x512.png",
  // Root static files referenced by the app's index.html (theme preload
  // script, favicons). Same category as the manifest: no user data.
  "/oc-theme-preload.js",
  "/favicon-96x96-v3.png",
  "/favicon-v3.svg",
  "/favicon-v3.ico",
  "/apple-touch-icon-180x180.png",
  "/social-share.png",
])

// Vite-built app bundles (JS/CSS/fonts) live under /assets/. The browser
// fetches them without app-managed credentials: the page itself loads with
// ?auth_token=, but the bundle requests carry no token and no Authorization
// header, so authing them leaves the page black (the app never boots).
export const PUBLIC_UI_PREFIXES = ["/assets/"]

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
  if (method !== "GET") return false
  if (PUBLIC_UI_PATHS.has(pathname)) return true
  return PUBLIC_UI_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}
