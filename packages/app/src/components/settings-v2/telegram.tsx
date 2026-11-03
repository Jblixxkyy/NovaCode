import { type Component, createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@novacode-ai/ui/v2/button-v2"
import { SelectV2 } from "@novacode-ai/ui/v2/select-v2"
import { Switch } from "@novacode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@novacode-ai/ui/v2/text-input-v2"
import { Tag } from "@novacode-ai/ui/v2/badge-v2"
import { useLanguage } from "@/context/language"
import { persisted } from "@/utils/persist"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type DmPolicy = "pairing" | "allowlist" | "open" | "disabled"

type TelegramSettings = {
  token: string
  dmPolicy: DmPolicy
  allowedUserIds: string
  requireMention: boolean
  streamingEnabled: boolean
  approvalsEnabled: boolean
}

type TelegramBotStatus = {
  available: boolean
  running: boolean
  botUsername?: string
  errorCode?: string
  errorDetail?: string
}

type TelegramBotApi = {
  telegramBotStatus: () => Promise<TelegramBotStatus>
  startTelegramBot: (config: {
    token: string
    dmPolicy: DmPolicy
    dmAllowFrom: number[]
    requireMention: boolean
    streamingEnabled: boolean
    approvalsEnabled: boolean
  }) => Promise<TelegramBotStatus>
  stopTelegramBot: () => Promise<TelegramBotStatus>
}

const defaultTelegramSettings: TelegramSettings = {
  token: "",
  dmPolicy: "pairing",
  allowedUserIds: "",
  requireMention: true,
  streamingEnabled: true,
  approvalsEnabled: true,
}

function parseAllowedUserIds(value: string): number[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number(part))
    .filter((id) => Number.isFinite(id) && Number.isInteger(id))
}

export function telegramConfigJson(settings: TelegramSettings): string {
  return JSON.stringify(
    {
      dmPolicy: settings.dmPolicy,
      dmAllowFrom: parseAllowedUserIds(settings.allowedUserIds),
      requireMention: settings.requireMention,
      streaming: { enabled: settings.streamingEnabled },
      approvals: { enabled: settings.approvalsEnabled },
    },
    null,
    2,
  )
}

export const SettingsTelegramV2: Component = () => {
  const language = useLanguage()
  const [store, setStore] = persisted("telegram.v1", createStore<TelegramSettings>(defaultTelegramSettings))
  const [botStatus, setBotStatus] = createSignal<TelegramBotStatus | undefined>(undefined)
  const [busy, setBusy] = createSignal(false)

  const desktopApi = () => (window as unknown as { api?: TelegramBotApi }).api

  createEffect(() => {
    const api = desktopApi()
    if (!api?.telegramBotStatus) return
    const tick = () => {
      void api.telegramBotStatus().then(setBotStatus).catch(() => undefined)
    }
    tick()
    const id = setInterval(tick, 5000)
    onCleanup(() => clearInterval(id))
  })

  const dmPolicyOptions = createMemo(() => {
    const policies: DmPolicy[] = ["pairing", "allowlist", "open", "disabled"]
    return policies.map((value) => ({
      value,
      label: language.t(`settings.telegram.dmPolicy.${value}`),
    }))
  })

  const statusLabel = createMemo(() => {
    if (!desktopApi()?.telegramBotStatus) return language.t("settings.telegram.status.desktopOnly")
    const current = botStatus()
    if (!current) return language.t("common.loading")
    if (!current.available) return language.t("settings.telegram.status.notAvailable")
    if (current.errorCode) return language.t("settings.telegram.status.error")
    if (current.running) return language.t("settings.telegram.status.running")
    return language.t("settings.telegram.status.stopped")
  })

  const statusDescription = createMemo(() => {
    const current = botStatus()
    if (current?.errorCode) {
      return (
        <>
          {language.t(`settings.telegram.error.${current.errorCode}`)}
          <Show when={current.errorDetail}>
            <br />
            <span>{current.errorDetail}</span>
          </Show>
        </>
      )
    }
    if (current?.running && current.botUsername) {
      return language.t("settings.telegram.status.runningAs", { username: `@${current.botUsername}` })
    }
    return language.t("settings.telegram.row.status.description")
  })

  const startBot = async () => {
    const api = desktopApi()
    if (!api?.startTelegramBot) return
    if (!store.token.trim()) {
      showToast({
        title: language.t("settings.telegram.start.toast.noToken.title"),
        description: language.t("settings.telegram.start.toast.noToken.description"),
      })
      return
    }
    setBusy(true)
    try {
      const result = await api.startTelegramBot({
        token: store.token,
        dmPolicy: store.dmPolicy,
        dmAllowFrom: parseAllowedUserIds(store.allowedUserIds),
        requireMention: store.requireMention,
        streamingEnabled: store.streamingEnabled,
        approvalsEnabled: store.approvalsEnabled,
      })
      setBotStatus(result)
      if (result.errorCode) {
        showToast({
          title: language.t("settings.telegram.start.toast.failed.title"),
          description: language.t(`settings.telegram.error.${result.errorCode}`),
        })
        return
      }
      if (result.running) {
        showToast({
          variant: "success",
          icon: "check",
          title: language.t("settings.telegram.start.toast.success.title"),
          description: language.t("settings.telegram.start.toast.success.description"),
        })
      }
    } finally {
      setBusy(false)
    }
  }

  const stopBot = async () => {
    const api = desktopApi()
    if (!api?.stopTelegramBot) return
    setBusy(true)
    try {
      setBotStatus(await api.stopTelegramBot())
    } finally {
      setBusy(false)
    }
  }

  const copyConfig = async () => {
    try {
      await navigator.clipboard.writeText(telegramConfigJson(store))
      showToast({
        variant: "success",
        icon: "check",
        title: language.t("settings.telegram.export.toast.success.title"),
        description: language.t("settings.telegram.export.toast.success.description"),
      })
    } catch {
      showToast({
        title: language.t("settings.telegram.export.toast.failed.title"),
        description: language.t("settings.telegram.export.toast.failed.description"),
      })
    }
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <div>
          <h2 class="settings-v2-tab-title">{language.t("settings.telegram.title")}</h2>
          <p class="settings-v2-provider-description">{language.t("settings.telegram.description")}</p>
        </div>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.telegram.section.connection")}</h3>
          <SettingsListV2>
            <SettingsRowV2 title={language.t("settings.telegram.row.status.title")} description={statusDescription()}>
              <Tag>{statusLabel()}</Tag>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.telegram.row.bot.title")}
              description={language.t("settings.telegram.row.bot.description")}
            >
              <Show
                when={desktopApi()?.startTelegramBot}
                fallback={<Tag>{language.t("settings.telegram.status.desktopOnly")}</Tag>}
              >
                <ButtonV2
                  size="normal"
                  variant={botStatus()?.running ? "neutral" : "contrast"}
                  disabled={busy()}
                  onClick={() => void (botStatus()?.running ? stopBot() : startBot())}
                >
                  {botStatus()?.running
                    ? language.t("settings.telegram.row.bot.stop")
                    : language.t("settings.telegram.row.bot.start")}
                </ButtonV2>
              </Show>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.telegram.row.token.title")}
              description={language.t("settings.telegram.row.token.description")}
            >
              <div class="flex items-center gap-2 w-full sm:w-[320px]">
                <TextInputV2
                  data-action="settings-telegram-token"
                  type="password"
                  appearance="base"
                  value={store.token}
                  onInput={(event) => setStore("token", event.currentTarget.value)}
                  placeholder={language.t("settings.telegram.row.token.placeholder")}
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  aria-label={language.t("settings.telegram.row.token.title")}
                />
                <Show when={store.token}>
                  <ButtonV2 size="normal" variant="neutral" onClick={() => setStore("token", "")}>
                    {language.t("settings.telegram.row.token.clear")}
                  </ButtonV2>
                </Show>
              </div>
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.telegram.section.access")}</h3>
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.telegram.row.dmPolicy.title")}
              description={language.t("settings.telegram.row.dmPolicy.description")}
            >
              <SelectV2
                appearance="inline"
                data-action="settings-telegram-dm-policy"
                options={dmPolicyOptions()}
                current={dmPolicyOptions().find((option) => option.value === store.dmPolicy)}
                placement="bottom-end"
                gutter={6}
                value={(option) => option.value}
                label={(option) => option.label}
                onSelect={(option) => option && setStore("dmPolicy", option.value)}
              />
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.telegram.row.allowedUserIds.title")}
              description={language.t("settings.telegram.row.allowedUserIds.description")}
            >
              <div class="w-full sm:w-[320px]">
                <TextInputV2
                  data-action="settings-telegram-allowed-users"
                  type="text"
                  appearance="base"
                  value={store.allowedUserIds}
                  onInput={(event) => setStore("allowedUserIds", event.currentTarget.value)}
                  placeholder={language.t("settings.telegram.row.allowedUserIds.placeholder")}
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  aria-label={language.t("settings.telegram.row.allowedUserIds.title")}
                />
              </div>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.telegram.row.requireMention.title")}
              description={language.t("settings.telegram.row.requireMention.description")}
            >
              <Switch checked={store.requireMention} onChange={(value) => setStore("requireMention", value)} />
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.telegram.section.behaviour")}</h3>
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.telegram.row.streaming.title")}
              description={language.t("settings.telegram.row.streaming.description")}
            >
              <Switch checked={store.streamingEnabled} onChange={(value) => setStore("streamingEnabled", value)} />
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.telegram.row.approvals.title")}
              description={language.t("settings.telegram.row.approvals.description")}
            >
              <Switch checked={store.approvalsEnabled} onChange={(value) => setStore("approvalsEnabled", value)} />
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.telegram.section.export")}</h3>
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.telegram.row.export.title")}
              description={language.t("settings.telegram.row.export.description")}
            >
              <ButtonV2 size="normal" variant="neutral" onClick={() => void copyConfig()}>
                {language.t("settings.telegram.row.export.button")}
              </ButtonV2>
            </SettingsRowV2>
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}
