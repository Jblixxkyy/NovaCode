import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { ConfigService } from "@/effect/config-service"

const novaName = (name: string) => name.replace(/^NOVACODE_/, "NOVACODE_")
const bool = (name: string) =>
  Config.boolean(novaName(name)).pipe(Config.orElse(() => Config.boolean(name)), Config.withDefault(false))
const positiveInteger = (name: string) =>
  Config.number(novaName(name)).pipe(
    Config.orElse(() => Config.number(name)),
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = bool("NOVACODE_EXPERIMENTAL")
const enabledByExperimental = (name: string) =>
  Config.all({
    experimental,
    nova: Config.boolean(novaName(name)).pipe(Config.option),
    open: Config.boolean(name).pipe(Config.option),
  }).pipe(
    Config.map((flags) =>
      Option.getOrElse(flags.nova, () => Option.getOrElse(flags.open, () => flags.experimental)),
    ),
  )

export class Service extends ConfigService.Service<Service>()("@novacode/RuntimeFlags", {
  autoShare: bool("NOVACODE_AUTO_SHARE"),
  pure: bool("NOVACODE_PURE"),
  disableDefaultPlugins: bool("NOVACODE_DISABLE_DEFAULT_PLUGINS"),
  disableEmbeddedWebUi: bool("NOVACODE_DISABLE_EMBEDDED_WEB_UI"),
  disableExternalSkills: bool("NOVACODE_DISABLE_EXTERNAL_SKILLS"),
  disableLspDownload: bool("NOVACODE_DISABLE_LSP_DOWNLOAD"),
  disableClaudeCodePrompt: Config.all({
    broad: bool("NOVACODE_DISABLE_CLAUDE_CODE"),
    direct: bool("NOVACODE_DISABLE_CLAUDE_CODE_PROMPT"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  disableClaudeCodeSkills: Config.all({
    broad: bool("NOVACODE_DISABLE_CLAUDE_CODE"),
    direct: bool("NOVACODE_DISABLE_CLAUDE_CODE_SKILLS"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  enableExa: Config.all({
    experimental,
    enabled: bool("NOVACODE_ENABLE_EXA"),
    legacy: bool("NOVACODE_EXPERIMENTAL_EXA"),
  }).pipe(Config.map((flags) => flags.experimental || flags.enabled || flags.legacy)),
  enableParallel: Config.all({
    enabled: bool("NOVACODE_ENABLE_PARALLEL"),
    legacy: bool("NOVACODE_EXPERIMENTAL_PARALLEL"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableExperimentalModels: bool("NOVACODE_ENABLE_EXPERIMENTAL_MODELS"),
  enableQuestionTool: bool("NOVACODE_ENABLE_QUESTION_TOOL"),
  experimentalReferences: enabledByExperimental("NOVACODE_EXPERIMENTAL_REFERENCES"),
  experimentalBackgroundSubagents: enabledByExperimental("NOVACODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  experimentalLspTy: bool("NOVACODE_EXPERIMENTAL_LSP_TY"),
  experimentalLspTool: enabledByExperimental("NOVACODE_EXPERIMENTAL_LSP_TOOL"),
  experimentalOxfmt: enabledByExperimental("NOVACODE_EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("NOVACODE_EXPERIMENTAL_PLAN_MODE"),
  experimentalCodeMode: enabledByExperimental("NOVACODE_EXPERIMENTAL_CODE_MODE"),
  experimentalEventSystem: enabledByExperimental("NOVACODE_EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalWorkspaces: enabledByExperimental("NOVACODE_EXPERIMENTAL_WORKSPACES"),
  experimentalIconDiscovery: enabledByExperimental("NOVACODE_EXPERIMENTAL_ICON_DISCOVERY"),
  outputTokenMax: positiveInteger("NOVACODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("NOVACODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  experimentalNativeLlm: bool("NOVACODE_EXPERIMENTAL_NATIVE_LLM"),
  experimentalWebSockets: bool("NOVACODE_EXPERIMENTAL_WEBSOCKETS"),
  client: Config.string("NOVACODE_CLIENT").pipe(
    Config.orElse(() => Config.string("NOVACODE_CLIENT")),
    Config.withDefault("cli"),
  ),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.layer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const node = LayerNode.make({ service: Service, layer: Service.layer.pipe(Layer.orDie), deps: [] })

export * as RuntimeFlags from "./runtime-flags"
import { LayerNode } from "@novacode-ai/core/effect/layer-node"
