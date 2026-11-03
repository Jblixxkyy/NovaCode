import type { Hooks, PluginInput } from "@novacode-ai/plugin"

export async function DeepseekPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "deepseek",
      methods: [
        {
          label: "OAuth Token",
          type: "oauth",
          prompts: [
            {
              type: "text",
              key: "oauthToken",
              message: "Enter your OAuth token (from Google sign-in on DeepSeek)",
              placeholder: "sk-...",
            },
          ],
          authorize: async (inputs) => {
            const token = inputs?.oauthToken?.trim()
            if (!token) throw new Error("OAuth token is required")
            return {
              url: "",
              instructions: "",
              method: "auto" as const,
              callback: async () => ({
                type: "success" as const,
                access: token,
                refresh: "",
                expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
              }),
            }
          },
        },
        {
          label: "API Key",
          type: "api",
        },
      ],
    },
  }
}