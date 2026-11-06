import { nitro } from "nitro/vite"
import { defineConfig } from "vite"

export default defineConfig({
  base: "/data/",
  plugins: [
    nitro({
      compatibilityDate: "2024-09-19",
      preset: "cloudflare-module",
      cloudflare: {
        nodeCompat: true,
      },
    }),
  ],
  server: {
    allowedHosts: true,
  },
  build: {
    minify: "esbuild",
    cssMinify: true,
  },
})
