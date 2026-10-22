#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@novacode-ai/script"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0
}

async function publish(dir: string, name: string, version: string) {
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(dir)
  if (await published(name, version)) return console.log(`already published ${name}@${version}`)
  await $`bun pm pack`.cwd(dir)
  await $`npm publish *.tgz --access public --tag ${Script.channel}`.cwd(dir)
}

const version = pkg.version
const source = fileURLToPath(new URL("../../novacode/dist", import.meta.url))
const binaries: Record<string, string> = {}
for (const filepath of new Bun.Glob("novacode-*/package.json").scanSync({ cwd: source })) {
  const file = `${source}/${filepath}`
  const item = await Bun.file(file).json()
  const name = item.name.replace(/^novacode-/, "@novacode-cli/cli-")
  await Bun.write(file, JSON.stringify({ ...item, name, version }, null, 2))
  binaries[name] = version
}
console.log("binaries", binaries)

await $`mkdir -p ./dist/${pkg.name}/bin`
await $`cp ./bin/novacode.cjs ./dist/${pkg.name}/bin/novacode`
await Bun.file(`./dist/${pkg.name}/package.json`).write(
  JSON.stringify(
    {
      name: pkg.name,
      bin: { novacode: "./bin/novacode" },
      version,
      license: pkg.license,
      repository: { type: "git", url: "git+https://github.com/Jblixxkyy/NovaCode.git" },
      os: ["darwin", "linux", "win32"],
      cpu: ["arm64", "x64"],
      optionalDependencies: binaries,
    },
    null,
    2,
  ),
)

await Promise.all(
  Object.entries(binaries).map(([name]) =>
    publish(`${source}/novacode-${name.replace("@novacode-cli/cli-", "")}`, name, version),
  ),
)
await publish(`./dist/${pkg.name}`, pkg.name, version)
