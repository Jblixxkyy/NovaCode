# OpenClaw → NovaCode Gap Analysis

> Source: `github.com/openclaw/openclaw` (fetched via public docs + README, Aug 2026)
>
> NovaCode is a single-user coding agent (CLI + TUI + Web + Desktop + IDE integrations). OpenClaw is a multi-channel assistant gateway with paired device nodes. The categories below are the things **NovaCode does not have** that OpenClaw does.

## 1. Messaging channel integrations

NovaCode has zero first-party chat-channel integrations outside the editor surfaces. There is a `packages/slack` and `packages/telegram` package, but they are thin SDK/data adapters, not full chat-bot integrations.

OpenClaw has full bidirectional bot integrations for: Discord, Slack, Telegram (bundled), WhatsApp, Signal, iMessage (via `imsg` JSON-RPC), Microsoft Teams, Google Chat, Feishu/Lark, LINE, Matrix, Mattermost, Nextcloud Talk, Synology Chat, IRC, Tlon/Urbit, Twitch, Zalo, Zalo Personal, SMS via Twilio, QQ Bot, Reef (E2E agent-to-agent), A2A (external agent → OpenClaw via A2A 1.0 JSON-RPC), Buzz rooms, ClickClack, plus WeChat/WeCom/Yuanbao/Zalo ClawBot via external plugins.

## 2. Companion / device "node" ecosystem

OpenClaw has a paired-node architecture where peripherals connect to a single Gateway with `role: "node"` and expose allowlisted device commands. NovaCode has none of this:

- **macOS menu bar app** (camera, screen, voice, notifications, computer-use, Canvas widget, Talk voice, local sessions)
- **iOS node** (camera, screen, voice, location, motion, photos, calendar, reminders, contacts, notifications, offline chat)
- **Android node** (chat, voice, camera, Talk, home canvas, mobile UI observe/act)
- **Linux companion**
- **Windows Hub** native app
- **watchOS node** (limited HTTPS polling)
- **Browser extension** as a paired CDP relay (Puppeteer/MCP controllable Chrome)
- **swabble** standalone speech/transcription subproject

NovaCode's `packages/desktop` is a single-user Electron app. There's no paired-node protocol, no `node.ts`-equivalent surface in OpenClaw's sense.

## 3. Voice / Talk / Telephony

OpenClaw ships:
- **Talk mode** with OpenAI Realtime (WebRTC) on browser + macOS native
- **Voice wake**, **push-to-talk**, **voice notes**
- **Voice Call** plugin for Plivo/Telnyx/Twilio telephony
- **macOS MLX TTS** for local on-device TTS
- Per-provider voice: ElevenLabs, Azure Speech, Gradium, Deepgram, Fish Audio (hosted S2.1 + local S2 Pro), sherpa-onnx-tts, senseaudio, tts-local-cli, talk-voice

NovaCode has `audio.d.ts` type stubs only — no voice wake, no Talk mode, no telephony, no TTS provider plugins, no realtime voice.

## 4. Computer use / Camera / Screen / Location

OpenClaw exposes `computer.act`, `desktop.stream`, `screen.record`, `screen.snapshot`, `camera.snap/clip/PTZ`, `location.get`, `mobile.ui.observe/act`, `system.run`, `terminal.resume`, `terminal.upload`. All gated by per-node `gateway.nodes.commands.allow`/`deny` with deny-wins.

NovaCode has none. No screen capture, no camera, no computer-use surface, no mobile UI observe/act. See `plans/computer-use.mdx` for a build plan.

## 5. Canvas / A2UI / hosted widget surface

OpenClaw serves Canvas widget docs at `/__openclaw__/canvas/` and A2UI renderer at `/__openclaw__/a2ui/` from the Gateway HTTP server. NovaCode has no hosted-widget or A2UI surface.

## 6. Memory as a swappable plugin slot

OpenClaw has a `memory-host-sdk` plugin contract with multiple backends (lancedb, wiki, active-memory), single-active-at-a-time, with user-memory capture on session departure and lazy companion tables.

NovaCode has no equivalent memory plugin surface in `packages/novacode/src` (no `memory/` directory). Sessions exist but no swappable memory plugin slot.

## 7. Cron / Heartbeat / Webhooks / Workboard

OpenClaw has scheduled jobs with per-job model selection, agent-initiated heartbeat, incoming webhook automation, and a Workboard with `--max-starts` cap, sequential starts, and one-card-per-owner guard.

NovaCode has `background/job.ts` for one-off async jobs but no recurring cron, no heartbeat scheduling model, no webhook ingress, no workboard/task-board concept.

## 8. Sandboxing (Crabbox)

OpenClaw's `extensions/crabbox` provides Docker/Podman-isolated exec with hardlinked pnpm store, container-isolated worker sessions (`nodeHost.workerRuns.isolation: "container"`).

NovaCode has `packages/containers` (Docker sandbox for tool exec) but no Crabbox-equivalent isolation contract, no pnpm-store hardlink hydration, no per-job isolation mode toggle.

## 9. Tailscale / remote access patterns

OpenClaw has first-class Tailscale Serve / SSH, trusted-proxy mode, identity-bearing auth via Tailscale headers.

NovaCode has no documented Tailscale Serve support, no trusted-proxy mode.

## 10. Pairing / device auth / DM safety

OpenClaw pairs unknown senders by default on DM-capable channels with `openclaw pairing approve <channel> <code>`, plus device pairing for nodes. NovaCode has no pairing concept — it's a local single-user tool.

## 11. Foreign session hosting (Claude Code / Codex / OpenCode / Pi)

OpenClaw discovers and reads native Claude Code, Codex, OpenCode, and Pi sessions, and lets you resume them from the Control UI via allowlisted PTY relay. NovaCode has no foreign-runtime hosting surface.

## 12. Multi-user / Teams deployment

OpenClaw supports durable profiles per person, catalog visibility filters, separate Gateway domains for hostile isolation, and runs the same Gateway as a shared team deployment. NovaCode is single-operator only.

## 13. Marketplace (ClawHub) + Plugin SDK

OpenClaw has a public marketplace (`clawhub.ai`) and a published Plugin SDK (`openclaw/plugin-sdk/*`) with code plugins and bundle-style plugins, vetted publishers, trust gating. NovaCode has `packages/plugin` but no public marketplace, no bundle-plugin format, no publisher trust model.

## 14. Model providers as plugins

OpenClaw has ~35 model-provider plugins: OpenAI, Anthropic (+ Vertex), Google, xAI, Mistral, DeepSeek, Cohere, OpenRouter, Groq, Cerebras, Chutes, Fireworks, Together, HuggingFace, DeepInfra, Novita, Baseten, Featherless, Vercel AI Gateway, Cloudflare AI Gateway, NVIDIA, Xiaomi, Moonshot, Alibaba (qwen/qianfan), BytePlus, Volcengine, ZAI, LM Studio, Ollama, llama.cpp, vLLM, SGLang, LiteLLM, Venice, Minimax, Longcat, MXC, Stepfun, Tencent, Inworld, Arcee, Pixverse, Runway, SenseAudio, Synthetic, Parallel, plus OpenAI-compatible hubs.

NovaCode has provider icons in `packages/ui/src/assets/icons/provider/` covering most of the same names, but the provider plugin architecture is not as plugin-extensible; providers are configured, not installed as separate plugins.

## 15. Media generation / understanding plugins

OpenClaw has `image-generation-core`, `media-generation-core`, `media-understanding-common`, `music-generation-core`, `video-generation-core`, plus per-provider plugins: comfy, fal, pixverse, runway, qwen, qianfan, kimi-coding, xiaomi, volcengine, stepfun, novita, longcat, mxc, music-generation-providers, plus tools like gifgrep, video-frames, oc-path, geolocation, goplaces.

NovaCode has `image/` (likely read/embed) but no generation pipeline plugins, no music, no video generation surface.

## 16. Backup / restore CLI

OpenClaw has `openclaw backup sqlite create|list|verify|restore` for compact verified global + per-agent DB snapshots.

NovaCode has no backup CLI.

## 17. Observability / OTEL / Prometheus

OpenClaw has `diagnostics-otel` and `diagnostics-prometheus` extensions.

NovaCode has no OTEL/Prometheus plugin surface. (`packages/stats` is internal usage analytics, not third-party metrics export.)

## 18. ACP / agent commerce

OpenClaw has ACPX plugin for agent commerce protocol, plus A2A external-agent bridge (A2A 1.0 JSON-RPC).

NovaCode has `packages/codemode` but not the same surface; no A2A bridge, no ACPX.

## 19. Onboarding migration

OpenClaw imports sessions from Claude, Codex, Hermes, etc. via an onboarding migration menu.

NovaCode has no equivalent migration flow for foreign session history.

## 20. Skill Workshop

OpenClaw has autonomous skill creation/apply/quarantine + history review.

NovaCode's `packages/novacode/src/skill/` is a loader, not a workshop.

## 21. macOS app profiles

OpenClaw supports named macOS app instances isolated across state, Keychain, services, ownership.

NovaCode's desktop is one instance.

## 22. External supervisor mode

`OPENCLAW_SUPERVISOR_MODE=external` for OCM-style lifecycle owners with a versioned atomic restart-handoff contract.

NovaCode has no equivalent supervisor handoff.

## 23. Browser CDP relay

OpenClaw's paired Chrome + browser extension serves DevTools-style `/json/list` and `openclaw browser extension cdp` for external CDP clients.

NovaCode has `packages/novacode/src/browser/` but it's a built-in browser automation tool, not an externally-controllable CDP endpoint. (Note: directory may not exist yet — verify before relying on this claim.)

## 24. Per-method rate limiting (30/min buckets) + runaway-loop protection

A control-plane concern OpenClaw ships. NovaCode has no equivalent.

## 25. Audit-but-not-authorize model

OpenClaw's `audit.run.inspect` exposes a fixed `decisionDisplays` allowlist with HMAC-projected raw refs, opt-in diagnostic provenance only.

NovaCode has no formal audit surface.

## Summary

NovaCode is positioned as a **single-user coding agent** with strong editor/IDE/TUI/Web/Desktop surfaces, a broad model-provider list, MCP, ACP, plugins, skills, and a comprehensive documentation site. OpenClaw is positioned as a **multi-channel assistant gateway** with paired device nodes, voice, computer use, telephony, a marketplace, and team deployments.

The biggest **product-shape** gaps (the ones that would change NovaCode's identity if added):

1. Chat-channel integrations (Slack/Telegram/Discord/WhatsApp/etc.)
2. Companion device nodes (macOS/iOS/Android/Linux/watchOS/Browser)
3. Voice/Talk/telephony
4. Computer use / camera / screen — see `plans/computer-use.mdx`
5. Memory-as-plugin slot
6. Cron/Heartbeat/Webhooks
7. Crabbox-style sandboxing contract
8. ClawHub marketplace + Plugin SDK
9. Foreign session hosting (Codex/Claude Code/Pi)
10. Multi-user/Teams deployment

Everything else (Tailscale Serve, backup CLI, OTEL, ACPX, A2A bridge, supervisor handoff, audit surface, app profiles, migration menu, Skill Workshop, CDP relay, rate limiting) is smaller-scope polish relative to those ten.