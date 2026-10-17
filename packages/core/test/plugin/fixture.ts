import { AgentV2 } from "@novacode-ai/core/agent"
import { AISDK } from "@novacode-ai/core/aisdk"
import { Catalog } from "@novacode-ai/core/catalog"
import { CommandV2 } from "@novacode-ai/core/command"
import { Credential } from "@novacode-ai/core/credential"
import { AppNodeBuilder } from "@novacode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@novacode-ai/core/effect/app-node-platform"
import { LayerNode } from "@novacode-ai/core/effect/layer-node"
import { EventV2 } from "@novacode-ai/core/event"
import { FileSystem } from "@novacode-ai/core/filesystem"
import { FSUtil } from "@novacode-ai/core/fs-util"
import { Integration } from "@novacode-ai/core/integration"
import { Location } from "@novacode-ai/core/location"
import { Npm } from "@novacode-ai/core/npm"
import { PluginV2 } from "@novacode-ai/core/plugin"
import { Reference } from "@novacode-ai/core/reference"
import { SkillV2 } from "@novacode-ai/core/skill"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: undefined }),
    install: () => Effect.void,
    which: () => Effect.succeed(undefined),
  }),
)

export const PluginTestLayer = AppNodeBuilder.build(
  LayerNode.group([
    FileSystem.node,
    FSUtil.node,
    Location.node,
    Npm.node,
    Credential.node,
    EventV2.node,
    LayerNodePlatform.httpClient,
    PluginV2.node,
    AgentV2.node,
    AISDK.node,
    Catalog.node,
    CommandV2.node,
    Integration.node,
    Reference.node,
    SkillV2.node,
  ]),
  [
    [Location.node, tempLocationLayer],
    [Npm.node, npmLayer],
  ],
)
