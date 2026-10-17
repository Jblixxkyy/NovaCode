interface ImportMetaEnv {
  readonly NOVACODE_CHANNEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:novacode-server" {
  export namespace Server {
    export const listen: typeof import("../../../novacode/dist/types/src/node").Server.listen
    export type Listener = import("../../../novacode/dist/types/src/node").Server.Listener
  }
  export namespace Config {
    export const get: typeof import("../../../novacode/dist/types/src/node").Config.get
    export type Info = import("../../../novacode/dist/types/src/node").Config.Info
  }
  export const bootstrap: typeof import("../../../novacode/dist/types/src/node").bootstrap
}
