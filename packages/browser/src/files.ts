import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { Browser } from "./rpc"

export class FileTransferError extends Schema.TaggedErrorClass<FileTransferError>()("Browser.FileTransferError", {
  message: Schema.String,
}) {}

// Files cross from the server into the browser as bytes. Only this module interprets server-local paths.
export async function read(paths: ReadonlyArray<string>, directory: string): Promise<Browser.File[]> {
  const files: Browser.File[] = []
  for (const input of paths) {
    // path.resolve handles both relative inputs and absolute paths on any platform
    // (POSIX `/...` and Windows `C:\...` alike); a startsWith("/") check misreads the latter as relative.
    const resolved = path.resolve(directory, input)
    const info = await stat(resolved).catch(() => undefined)
    if (!info) throw new FileTransferError({ message: `Upload path does not exist: ${input}` })
    if (info.size > Browser.MAX_FILE_BYTES)
      throw new FileTransferError({
        message: `Upload is ${info.size} bytes; the limit is ${Browser.MAX_FILE_BYTES} bytes (5 MiB). Select a smaller file; do not retry the same upload.`,
      })
    files.push({
      id: Browser.FileID.make(`file_${crypto.randomUUID()}`),
      name: path.basename(input),
      mime: mimeFor(input),
      data: new Uint8Array(await readFile(resolved)),
    })
  }
  if (files.reduce((size, file) => size + file.data.byteLength, 0) > Browser.MAX_FILE_BYTES)
    throw new FileTransferError({
      message:
        "The selected upload files exceed 5 MiB in total. Send fewer or smaller files; splitting them into one batch does not bypass the total limit.",
    })
  return files
}

export async function save(files: ReadonlyArray<Browser.File>, directory: string): Promise<Browser.FileInfo[]> {
  if (files.length === 0) return []
  if (files.reduce((size, file) => size + file.data.byteLength, 0) > Browser.MAX_FILE_BYTES)
    throw new FileTransferError({
      message:
        "Capture files exceed the 5 MiB total transfer limit. Use a smaller screenshot, a shorter trace/profile, or a smaller page for heap capture; do not retry the identical capture.",
    })
  const saved: Browser.FileInfo[] = []
  for (const [index, file] of files.entries()) {
    const name = captureName(file.name)
    const dir = path.join(directory, `${Date.now()}-${index}`)
    await mkdir(dir, { recursive: true })
    const filePath = path.join(dir, name)
    await writeFile(filePath, file.data)
    saved.push({ id: file.id, name: file.name, mime: file.mime, bytes: file.data.byteLength, path: filePath })
  }
  return saved
}

// `.`/`..` escape the per-file directory and Windows resolves device names such as CON.txt regardless of directory.
export function captureName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-160)
  if (!sanitized || /^\.{1,2}$/.test(sanitized) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(sanitized))
    return "capture"
  return sanitized
}

export function mimeFor(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
  return (
    {
      txt: "text/plain",
      csv: "text/csv",
      json: "application/json",
      html: "text/html",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      svg: "image/svg+xml",
      pdf: "application/pdf",
      zip: "application/zip",
      gz: "application/gzip",
    }[ext] ?? "application/octet-stream"
  )
}


export * as BrowserFiles from "./files"
