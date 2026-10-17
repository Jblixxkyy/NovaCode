import { spawn } from "node:child_process"
import os from "node:os"

export type ScreenshotResult = {
  data: string // base64 png
  mime: string
  width: number
  height: number
}

export async function captureScreen(): Promise<ScreenshotResult> {
  // Try screenshot-desktop first (cross-platform, pure JS wrapper)
  try {
    // @ts-ignore — optional dep
    const mod = await import("screenshot-desktop")
    const capture = (mod as any).default ?? mod
    const img: Buffer = await capture({ format: "png" })
    // screenshot-desktop returns a single display; dimensions unknown — probe via buffer header
    const dims = pngDimensions(img) ?? { width: 1280, height: 720 }
    return { data: img.toString("base64"), mime: "image/png", width: dims.width, height: dims.height }
  } catch {}

  // Try nut-js screen capture as fallback
  try {
    // @ts-ignore — optional dep
    const nut = await import("@nut-tree/nut-js")
    // nut-js screen API varies by version; try screen.capture if exists
    const screen: any = (nut as any).screen
    if (screen?.capture) {
      const region = await screen.capture()
      // region is not directly PNG — nut-js returns image with toPng?
      void region
    }
  } catch {}

  // Windows fallback: PowerShell + System.Drawing
  if (os.platform() === "win32") {
    const ps = await powershellScreenshot()
    if (ps) return ps
  }

  // macOS fallback: screencapture
  if (os.platform() === "darwin") {
    const mac = await macScreenshot()
    if (mac) return mac
  }

  throw new Error(
    "No screenshot backend available. Install optional deps: `npm i screenshot-desktop @nut-tree/nut-js` or ensure PowerShell/screencapture is available.",
  )
}

function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  // PNG IHDR at byte 16..24
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  return { width, height }
}

function powershellScreenshot(): Promise<ScreenshotResult | null> {
  return new Promise((resolve) => {
    const psScript = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
[Convert]::ToBase64String($ms.ToArray())
$g.Dispose(); $bmp.Dispose(); $ms.Dispose()
`.trim()
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", psScript], { windowsHide: true })
    let out = ""
    let err = ""
    child.stdout.on("data", (d) => (out += d.toString()))
    child.stderr.on("data", (d) => (err += d.toString()))
    child.on("error", () => resolve(null))
    child.on("close", (code) => {
      if (code !== 0 || !out.trim()) return resolve(null)
      const data = out.trim().replace(/\s+/g, "")
      // Probe dims by decoding first bytes
      try {
        const buf = Buffer.from(data, "base64")
        const dims = pngDimensions(buf) ?? { width: 1280, height: 720 }
        resolve({ data, mime: "image/png", width: dims.width, height: dims.height })
      } catch {
        resolve({ data, mime: "image/png", width: 1280, height: 720 })
      }
      void err
    })
  })
}

function macScreenshot(): Promise<ScreenshotResult | null> {
  return new Promise((resolve) => {
    // screencapture -x -t png -o /tmp/... then read
    const tmp = `${os.tmpdir()}/novacode-screenshot-${Date.now()}.png`
    const child = spawn("screencapture", ["-x", "-t", "png", tmp])
    child.on("error", () => resolve(null))
    child.on("close", async (code) => {
      if (code !== 0) return resolve(null)
      try {
        const { readFile, unlink } = await import("node:fs/promises")
        const b = await readFile(tmp)
        const dims = pngDimensions(b) ?? { width: 1280, height: 720 }
        resolve({ data: b.toString("base64"), mime: "image/png", width: dims.width, height: dims.height })
        await unlink(tmp).catch(() => {})
      } catch {
        resolve(null)
      }
    })
  })
}
