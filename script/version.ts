#!/usr/bin/env bun

import { Script } from "@novacode-ai/script"
import { $ } from "bun"

const output = [`version=${Script.version}`]
const sha = process.env.GITHUB_SHA ?? (await $`git rev-parse HEAD`.text()).trim()

// Helper function to retry with exponential backoff
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 5,
  initialDelayMs = 1000
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i === maxRetries - 1) throw e
      const delay = initialDelayMs * Math.pow(2, i)
      console.log(`Retry attempt ${i + 1}/${maxRetries} after ${delay}ms...`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw new Error("Max retries exceeded")
}

if (!Script.preview) {
  try {
    await $`bun script/changelog.ts --to ${sha}`.cwd(process.cwd())
    const file = `${process.cwd()}/UPCOMING_CHANGELOG.md`
    const body = await Bun.file(file)
      .text()
      .catch(() => "No notable changes")
    const dir = process.env.RUNNER_TEMP ?? "/tmp"
    const notesFile = `${dir}/novacode-release-notes.txt`
    await Bun.write(notesFile, body)
    await $`gh release create v${Script.version} -d --target ${sha} --title "NovaCode v${Script.version}" --notes-file ${notesFile} --repo ${process.env.GH_REPO}`
    
    // Add retry logic for retrieving release info
    const release = await retryWithBackoff(() =>
      $`gh release view v${Script.version} --json tagName,databaseId --repo ${process.env.GH_REPO}`.json()
    )
    
    output.push(`release=${release.databaseId}`)
    output.push(`tag=${release.tagName}`)
  } catch (e) {
    console.warn("gh release create failed, continuing without draft:", e)
    output.push(`release=0`)
    output.push(`tag=v${Script.version}`)
  }
} else if (Script.channel === "beta") {
  try {
    await $`gh release create v${Script.version} -d --title "NovaCode v${Script.version}" --repo ${process.env.GH_REPO}`
    
    // Add retry logic for beta release
    const release = await retryWithBackoff(() =>
      $`gh release view v${Script.version} --json tagName,databaseId --repo ${process.env.GH_REPO}`.json()
    )
    
    output.push(`release=${release.databaseId}`)
    output.push(`tag=${release.tagName}`)
  } catch (e) {
    console.warn("gh beta release failed:", e)
    output.push(`release=0`)
    output.push(`tag=v${Script.version}`)
  }
}

output.push(`repo=${process.env.GH_REPO}`)

if (process.env.GITHUB_OUTPUT) {
  await Bun.write(process.env.GITHUB_OUTPUT, output.join("\n"))
}

process.exit(0)
