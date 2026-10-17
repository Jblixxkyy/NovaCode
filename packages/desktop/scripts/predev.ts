import { $ } from "bun"
import { copyLocalCliToResources } from "./utils"

await $`bun run install-electron`

await $`bun ./scripts/copy-icons.ts ${process.env.NOVACODE_CHANNEL ?? "dev"}`

await $`cd ../novacode && bun script/build-node.ts`
await copyLocalCliToResources()
