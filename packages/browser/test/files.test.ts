import { afterEach, describe, expect, test } from "bun:test"
import { Browser } from "../src/rpc"
import { BrowserFiles } from "../src/files"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await Bun.$`rm -rf ${dir}`.quiet()
})

async function makeDir(): Promise<string> {
  const dir = `${import.meta.dir}/tmp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await Bun.$`mkdir -p ${dir}`.quiet()
  dirs.push(dir)
  return dir
}

describe("captureName", () => {
  test("sanitizes unsafe characters", () => {
    expect(BrowserFiles.captureName("a/b\\c:d")).toBe("a_b_c_d")
  })

  test("rejects dot segments and Windows device names", () => {
    expect(BrowserFiles.captureName(".")).toBe("capture")
    expect(BrowserFiles.captureName("..")).toBe("capture")
    expect(BrowserFiles.captureName("CON.txt")).toBe("capture")
    expect(BrowserFiles.captureName("nul")).toBe("capture")
  })

  test("keeps ordinary names and truncates long ones", () => {
    expect(BrowserFiles.captureName("screenshot-1.png")).toBe("screenshot-1.png")
    expect(BrowserFiles.captureName("a".repeat(200))).toHaveLength(160)
  })
})

describe("save", () => {
  test("round-trips file bytes to disk", async () => {
    const dir = await makeDir()
    const data = new TextEncoder().encode("hello browser")
    const saved = await BrowserFiles.save(
      [{ id: Browser.FileID.make(`file_${crypto.randomUUID()}`), name: "note.txt", mime: "text/plain", data }],
      dir,
    )
    expect(saved).toHaveLength(1)
    expect(saved[0]!.bytes).toBe(data.byteLength)
    expect(await Bun.file(saved[0]!.path).text()).toBe("hello browser")
  })

  test("empty input saves nothing", async () => {
    expect(await BrowserFiles.save([], await makeDir())).toEqual([])
  })

  test("rejects transfers over 5 MiB", async () => {
    const dir = await makeDir()
    const data = new Uint8Array(Browser.MAX_FILE_BYTES + 1)
    await expect(
      BrowserFiles.save(
        [{ id: Browser.FileID.make(`file_${crypto.randomUUID()}`), name: "big.bin", mime: "application/octet-stream", data }],
        dir,
      ),
    ).rejects.toThrow("5 MiB")
  })
})

describe("read", () => {
  test("reads server-local files with detected mime", async () => {
    const dir = await makeDir()
    await Bun.write(`${dir}/page.html`, "<h1>hi</h1>")
    const files = await BrowserFiles.read(["page.html"], dir)
    expect(files).toHaveLength(1)
    expect(files[0]!.mime).toBe("text/html")
    expect(files[0]!.name).toBe("page.html")
    expect(new TextDecoder().decode(files[0]!.data)).toBe("<h1>hi</h1>")
  })

  test("resolves absolute paths", async () => {
    const dir = await makeDir()
    await Bun.write(`${dir}/a.txt`, "x")
    const files = await BrowserFiles.read([`${dir}/a.txt`], "/nope")
    expect(files).toHaveLength(1)
  })

  test("reads back the absolute path returned by save", async () => {
    const dir = await makeDir()
    const saved = await BrowserFiles.save(
      [
        {
          id: Browser.FileID.make(`file_${crypto.randomUUID()}`),
          name: "a.txt",
          mime: "text/plain",
          data: new TextEncoder().encode("round trip"),
        },
      ],
      dir,
    )
    // save() returns a platform-native absolute path; read() must accept it verbatim on every OS.
    const files = await BrowserFiles.read([saved[0]!.path], "/nope")
    expect(files).toHaveLength(1)
    expect(files[0]!.name).toBe("a.txt")
    expect(new TextDecoder().decode(files[0]!.data)).toBe("round trip")
  })

  test("rejects missing files", async () => {
    const dir = await makeDir()
    await expect(BrowserFiles.read(["missing.txt"], dir)).rejects.toThrow("does not exist")
  })
})
