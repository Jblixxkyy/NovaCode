import { spawn, type ChildProcess } from "node:child_process"
import { copyFileSync, existsSync, writeFileSync } from "node:fs"
import { chmod, copyFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { app } from "electron"

export type TelegramBotConfig = {
  token: string
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled"
  dmAllowFrom: number[]
  requireMention: boolean
  streamingEnabled: boolean
  approvalsEnabled: boolean
}

export type TelegramBotErrorCode =
  | "no-token"
  | "invalid-token"
  | "network"
  | "not-available"
  | "bun-not-found"
  | "bot-exited"

export type TelegramBotStatus = {
  available: boolean
  running: boolean
  botUsername?: string
  errorCode?: TelegramBotErrorCode
  errorDetail?: string
}

function executableName() {
  return process.platform === "win32" ? "telegram-bot.exe" : "telegram-bot"
}

function findTelegramDir(): string | undefined {
  const starts: string[] = []
  try {
    starts.push(app.getAppPath())
  } catch {}
  try {
    starts.push(dirname(fileURLToPath(import.meta.url)))
  } catch {}
  starts.push(process.cwd())
  for (const start of starts) {
    let dir = start
    for (let depth = 0; depth < 5; depth++) {
      if (existsSync(join(dir, "packages", "telegram", "package.json"))) return join(dir, "packages", "telegram")
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return undefined
}

/**
 * In packaged builds the compiled telegram-bot binary is bundled under
 * `process.resourcesPath` by electron-builder (extraResources). Return that
 * directory so `status()` can report availability before a start.
 */
function findPackagedBotDir(): string | undefined {
  if (!app.isPackaged) return undefined
  const binary = join(process.resourcesPath, executableName())
  if (existsSync(binary)) return process.resourcesPath
  return undefined
}

/**
 * Copy the bundled binary from the read-only resources dir into a writable
 * userData subdirectory so the bot can write `telegram.json` and state files
 * next to itself. Returns the staging directory used as the process cwd.
 */
async function stagePackagedBot(): Promise<string> {
  const userData = app.getPath("userData")
  const dir = join(userData, "telegram-bot")
  const dest = join(dir, executableName())
  if (!existsSync(dest)) {
    await mkdir(dir, { recursive: true })
    const source = join(process.resourcesPath, executableName())
    await copyFile(source, dest)
    if (process.platform !== "win32") await chmod(dest, 0o755)
  }
  return dir
}

export function createTelegramBotManager() {
  let child: ChildProcess | undefined
  let botUsername: string | undefined
  let errorCode: TelegramBotErrorCode | undefined
  let errorDetail: string | undefined
  let stopping = false
  let lastLines: string[] = []

  const pushLine = (text: string) => {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      lastLines.push(trimmed)
      if (lastLines.length > 20) lastLines.shift()
    }
  }

  const telegramDir = (): string | undefined => (app.isPackaged ? findPackagedBotDir() : findTelegramDir())

  const status = (): TelegramBotStatus => {
    const running = !!child && child.exitCode === null && !child.killed
    const dir = telegramDir()
    if (!running && errorCode) {
      return {
        available: !!dir,
        running: false,
        botUsername,
        errorCode,
        errorDetail,
      }
    }
    return {
      available: !!dir,
      running,
      botUsername: running ? botUsername : undefined,
    }
  }

  const stop = async (): Promise<TelegramBotStatus> => {
    const current = child
    child = undefined
    if (!current) return status()
    stopping = true
    try {
      current.kill()
      await Promise.race([
        new Promise<void>((resolve) => current.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ])
      if (current.exitCode === null) {
        try {
          current.kill("SIGKILL")
        } catch {}
      }
    } catch {}
    stopping = false
    botUsername = undefined
    errorCode = undefined
    errorDetail = undefined
    return status()
  }

  const start = async (config: TelegramBotConfig): Promise<TelegramBotStatus> => {
    if (status().running) return status()
    let dir: string | undefined
    try {
      dir = app.isPackaged ? await stagePackagedBot() : findTelegramDir()
    } catch {
      errorCode = "bun-not-found"
      errorDetail = undefined
      return status()
    }
    if (!dir) {
      errorCode = "not-available"
      errorDetail = undefined
      return status()
    }
    const token = config.token.trim()
    if (!token) {
      errorCode = "no-token"
      errorDetail = undefined
      return status()
    }

    let me: { username?: string } | undefined
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/getMe`)
      const body = (await response.json()) as { ok?: boolean; result?: { username?: string }; description?: string }
      if (!response.ok || !body.ok || !body.result) {
        errorCode = "invalid-token"
        errorDetail = body.description
        return status()
      }
      me = body.result
    } catch {
      errorCode = "network"
      errorDetail = undefined
      return status()
    }

    const configPath = join(dir, "telegram.json")
    try {
      if (existsSync(configPath)) copyFileSync(configPath, join(dir, "telegram.json.bak"))
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            dmPolicy: config.dmPolicy,
            dmAllowFrom: config.dmAllowFrom,
            requireMention: config.requireMention,
            streaming: { enabled: config.streamingEnabled },
            approvals: { enabled: config.approvalsEnabled },
          },
          null,
          2,
        ),
      )
    } catch {
      errorCode = "bot-exited"
      errorDetail = "Could not write telegram.json"
      return status()
    }

    errorCode = undefined
    errorDetail = undefined
    lastLines = []
    botUsername = me.username
    stopping = false

    const binaryPath = join(dir, executableName())
    const next = spawn(binaryPath, [], {
      cwd: dir,
      env: { ...process.env, TELEGRAM_BOT_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    child = next
    next.stdout?.on("data", (chunk: Buffer) => pushLine(chunk.toString("utf8")))
    next.stderr?.on("data", (chunk: Buffer) => pushLine(chunk.toString("utf8")))
    next.on("error", (err: Error) => {
      if (stopping) return
      child = undefined
      errorCode = "bun-not-found"
      errorDetail = err.message
    })
    next.on("exit", (code) => {
      if (child !== next) return
      child = undefined
      if (stopping) return
      errorCode = "bot-exited"
      errorDetail = lastLines.length > 0 ? lastLines[lastLines.length - 1] : `Bot exited with code ${code ?? "unknown"}`
    })
    return status()
  }

  return { status, start, stop }
}

export type TelegramBotManager = ReturnType<typeof createTelegramBotManager>
