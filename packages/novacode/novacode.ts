// Shim entry for `novacode` global command.
// Bun needs --cwd to resolve workspace deps (solid-js, react, etc.),
// but we want the TUI's project to be the caller's original directory,
// not packages/novacode.
if (process.env.NOVACODE_ORIGINAL_CWD) {
  try {
    process.chdir(process.env.NOVACODE_ORIGINAL_CWD)
  } catch {}
}
await import("./src/index.ts")
