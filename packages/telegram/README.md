# @novacode-ai/novatelegram

Telegram bot integration for novacode. One long-running bot process talks to a local novacode server (v2 SDK via `promptAsync` + event stream) — one novacode session per chat or forum topic, with streaming preview, media, reactions, approvals, and durable polling.

## Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token.
2. Copy `.env.example` to `.env` and set `TELEGRAM_BOT_TOKEN`.
3. Optionally create `telegram.json` next to `.env` for richer config (groups, topics, custom commands, etc.); env vars override it.

```bash
bun dev
```

The bot starts a novacode server on an ephemeral port, registers Telegram commands, and begins long-polling.

## How it routes

- `chatId` → session. In forum supergroups each `message_thread_id` gets its own session (`${chatId}:topic:${threadId}`), with the General topic (`threadId=1`) collapsed to the chat-level session.
- DMs with `has_topics_enabled` (BotFather threaded mode) get per-topic sessions; otherwise flat.
- Sessions lazily share a URL on first message in a chat (via `session.share`).

## Commands

`/start` greeting, `/help`, `/status`, `/whoami`, `/new` (clear chat session), `/model <provider/model>`, `/agent <name>`, `/activation`, `/pair <code>`, `/context`. Custom commands from `telegram.json` `customCommands` are appended via `setMyCommands`.

## Auth / pairing

`dmPolicy` (`pairing` | `allowlist` | `open` | `disabled`) controls DMs; `groupPolicy` (`open` | `allowlist` | `disabled`) + `groupAllowFrom` + `groups.<chatId>` per-group/topic overrides. `requireMention` (default `true` in groups) gates group messages to mentions or replies-to-bot. `pairing` issues a 1h code shown in-chat; `/pair <code>` approves.

## Streaming

When enabled (`streaming.enabled`, debounce `400ms`, min delta `80`), the bot posts a `Thinking…` message and edits it in place as the model streams text parts (diffed cumulatively, since v2 events are cumulative, not delta). Markdown parse falls back to plain text.

## Media

Photos (largest size), documents, audio/voice, video/video_note, stickers are downloaded via `getFile` with retry-after/exponential backoff, oversize-checked (20 MB default), and forwarded as `file` parts to `promptAsync`. Media groups (`media_group_id`) are buffered `800 ms` and sent as one turn. Agent file/tool attachments are echoed back as Telegram photo/document.

## Reactions / approvals / callbacks

- Ack reaction `👀` on inbound, `✅` on completion (configurable via `reactions.*`).
- `message_reaction` inbound is tracked/logged; optionally forwarded when `reactions.forwardInbound`.
- `permission.asked` events post an inline keyboard `Allow` / `Always` / `Deny` (prefix `perm:<requestID>:`); the router answers `callback_query` first (before dispatch) and long-prefix-matched handlers call `permission.reply({ requestID, reply: "once" | "always" | "reject" })`.

## Transport

- Default `polling` (long polling via grammY). Stall watchdog (`polling.stallTimeoutMs`, default `120s`) restarts polling if idle too long; offsets are persisted in `stateFile` and resumed on restart; `401`/`404` are fatal (bad token), `409` is a polling conflict (another instance on this token), `5xx`/`429` honor `retry_after` with backoff — modeled on OpenClaw's polling-session but trimmed for a personal bot.
- Webhook mode (`TELEGRAM_TRANSPORT=webhook`, `webhook.url` required): a `Bun.serve` on `webhook.host:port` serves `/healthz` and `webhook.path` (with constant-time `x-telegram-bot-api-secret-token` check), calls `bot.handleUpdate`, and registers via `setWebhook`.

## Env vars

See `.env.example`. Complex policy (`groups`, `topics`, `customCommands`) lives in `telegram.json`; sensitive / token / transport overrides are env vars (see `src/config.ts`).

## Notes

- Built against the v2 Opencode SDK (`@novacode-ai/sdk/v2`, `promptAsync` → `session.idle` event collection, cumulative `message.part.updated` with no delta).
- Throttled via `@grammyjs/transformer-throttler` + `sequentialize` wrapper in `src/runtime.ts`.
- `packages/slack` is the original template; this package reaches OpenClaw parity (minus multi-account/ACP bindings/gateway ceremony) with less slop.
- Run `bun typecheck` (`tsgo` / `tsc`) from this package to verify; polling durability is best-effort for a personal bot — Telegram redelivers on crash, the bot re-processes from offset.
