export function formatTelegramText(text: string): string {
  if (!text) return ""
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^[-|:\s]+$/.test(line))
    .join("\n")
    .trim()
}
