import path from "path"

process.env.NOVACODE_DB = ":memory:"
process.env.NOVACODE_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.NOVACODE_DISABLE_MODELS_FETCH = "true"
