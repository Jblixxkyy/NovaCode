import { createMemo, createSignal, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { DateTime } from "luxon"
import { Icon as IconV2 } from "@novacode-ai/ui/v2/icon"
import { IconButtonV2 } from "@novacode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@novacode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { useSessionLayout } from "@/pages/session/session-layout"
import { sessionTitle } from "@/utils/session-title"

type MemoryNode = {
  id: string
  label: string
  detail?: string
  color: string
  icon?: string
  kind: "message" | "compaction" | "session"
  targetID: string
}

type OrbitConfig = {
  id: string
  name: string
  radius: number
  speed: number
  items: MemoryNode[]
}

function timeAgo(created: number, language: ReturnType<typeof useLanguage>) {
  const dt = DateTime.fromMillis(created).setLocale(language.intl())
  return dt.toRelative({ style: "short" }) ?? dt.toLocaleString(DateTime.DATETIME_SHORT)
}

function truncate(text: string, n = 22) {
  const t = text.replace(/\s+/g, " ").trim()
  if (!t) return ""
  return t.length > n ? t.slice(0, n - 1) + "…" : t
}

function extractText(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  for (const p of parts as Array<Record<string, unknown>>) {
    if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) return p.text as string
  }
  for (const p of parts as Array<Record<string, unknown>>) {
    if (p?.type === "tool" && p.state && typeof p.state === "object") {
      const s = p.state as Record<string, unknown>
      if (typeof s.input === "object" && s.input && typeof (s.input as Record<string, unknown>).description === "string")
        return (s.input as Record<string, unknown>).description as string
    }
  }
  return ""
}

function mockOrbits(): OrbitConfig[] {
  return [
    {
      id: "inner",
      name: "Recent",
      radius: 96,
      speed: 18,
      items: [
        { id: "m1", label: "Auth fix", detail: "2 files • 2h ago", color: "#fcd53a", icon: "grid-plus", kind: "message", targetID: "m1" },
        { id: "m2", label: "Scroll state", detail: "compaction", color: "#38bdf8", icon: "branch", kind: "compaction", targetID: "m2" },
        { id: "m3", label: "Review tab", detail: "turn", color: "#a78bfa", icon: "help", kind: "message", targetID: "m3" },
      ],
    },
    {
      id: "mid",
      name: "Pinned",
      radius: 156,
      speed: 32,
      items: [
        { id: "m4", label: "API design", detail: "pinned", color: "#34d399", icon: "grid-plus", kind: "message", targetID: "m4" },
        { id: "m5", label: "Project reloc", detail: "pinned", color: "#fb7185", icon: "folder", kind: "message", targetID: "m5" },
        { id: "m6", label: "Supermemory", detail: "persistent", color: "#f472b6", icon: "help", kind: "session", targetID: "m6" },
      ],
    },
    {
      id: "outer",
      name: "Archive",
      radius: 218,
      speed: 48,
      items: [
        { id: "m7", label: "Initial setup", detail: "3d ago", color: "#94a3b8", icon: "archive", kind: "session", targetID: "m7" },
        { id: "m8", label: "sdk regen", detail: "5d ago", color: "#94a3b8", icon: "archive", kind: "session", targetID: "m8" },
        { id: "m9", label: "Staging deploy", detail: "7d ago", color: "#64748b", icon: "archive", kind: "session", targetID: "m9" },
      ],
    },
  ]
}

export function MemorySolarSystemDialog(props: { onClose: () => void; onSelect?: (id: string) => void }) {
  const language = useLanguage()
  const sync = useSync()
  const navigate = useNavigate()
  const { params } = useSessionLayout()
  const [paused, setPaused] = createSignal(false)
  const [speed, setSpeed] = createSignal(1)
  const orbits = createMemo<OrbitConfig[]>(() => {
    const sid = params.id
    const messages = sid ? (sync().data.message[sid] ?? []) : []
    const sessionMessages = sid ? (sync().data.session_message[sid] ?? []) : []
    const allSessions = (sync().data.session ?? []) as Array<{ id: string; title?: string; time: { created: number; archived?: number }; parentID?: string; directory: string }>
    const partsByMsg = sync().data.part as Record<string, unknown[] | undefined>

    // Build real nodes from current session messages
    const recentMsgs = [...messages].sort((a, b) => b.time.created - a.time.created).slice(0, 8)
    const inner: MemoryNode[] = recentMsgs.slice(0, 4).map((m) => {
      const parts = partsByMsg[m.id] ?? []
      const hasCompaction = parts.some((p) => (p as Record<string, unknown>).type === "compaction")
      const txt = truncate(extractText(parts) || sessionTitle((allSessions.find((s) => s.id === sid)?.title)) || m.id.slice(0, 8))
      return {
        id: m.id,
        label: hasCompaction ? `${truncate(txt, 18)} · ✦` : truncate(txt, 20) || (m.role === "user" ? "Prompt" : "Answer"),
        detail: `${m.role === "user" ? language.t("session.tab.session") : m.role} • ${timeAgo(m.time.created, language)}${hasCompaction ? " • compaction" : ""}`,
        color: hasCompaction ? "#fcd53a" : m.role === "user" ? "#38bdf8" : "#a78bfa",
        icon: hasCompaction ? "branch" : m.role === "user" ? "help" : "grid-plus",
        kind: hasCompaction ? "compaction" : "message",
        targetID: m.id,
      }
    })

    // Mid: compactions + older messages in same session (or flagged by synthetic/branch)
    const midCandidates = [...messages].filter((m) => {
      const parts = partsByMsg[m.id] ?? []
      return parts.some((p) => (p as Record<string, unknown>).type === "compaction")
    })
    const sessionNodes: MessageNodeLike[] = sessionMessages
      .filter((m) => "role" in m && m.role === "user")
      .slice(-6)
      .map((m) => m as unknown as MessageNodeLike)
    // fallback: if no compaction, use next older messages
    const midSource = midCandidates.length > 0 ? midCandidates.slice(-4) : recentMsgs.slice(4, 8)
    const midExtra = sessionNodes.slice(0, 2).map((m) => ({
      id: m.id,
      label: truncate(extractText(partsByMsg[m.id] ?? []) || m.id.slice(0, 8), 20),
      detail: `${language.t("session.tab.session")} • ${timeAgo(m.time.created, language)}`,
      color: "#34d399",
      icon: "grid-plus",
      kind: "message" as const,
      targetID: m.id,
    }))
    const mid: MemoryNode[] = [
      ...midSource.map((m) => {
        const parts = partsByMsg[m.id] ?? []
        const txt = truncate(extractText(parts) || m.id.slice(0, 8), 20)
        return {
          id: `mid-${m.id}`,
          label: txt || "Memory",
          detail: `${timeAgo(m.time.created, language)}`,
          color: "#34d399",
          icon: "branch",
          kind: "compaction" as const,
          targetID: m.id,
        }
      }),
      ...midExtra,
    ].slice(0, 4)

    // Outer: other sessions in same directory (app memories) + archived
    const siblings = allSessions
      .filter((s) => !s.parentID && s.id !== sid)
      .sort((a, b) => b.time.created - a.time.created)
      .slice(0, 6)
    const outer: MemoryNode[] = siblings.map((s) => ({
      id: s.id,
      label: truncate(sessionTitle(s.title) ?? s.id.slice(0, 8), 18),
      detail: `${timeAgo(s.time.created, language)}${s.time.archived ? " • archived" : ""}`,
      color: s.time.archived ? "#64748b" : "#94a3b8",
      icon: "archive",
      kind: "session" as const,
      targetID: s.id,
    }))

    const hasReal = inner.length > 0 || mid.length > 0 || outer.length > 0
    if (!hasReal) return mockOrbits()
    return [
      { id: "inner", name: language.t("session.memory.orbit.recent"), radius: 96, speed: 18, items: inner.length ? inner : mockOrbits()[0].items },
      { id: "mid", name: language.t("session.memory.orbit.pinned"), radius: 156, speed: 32, items: mid.length ? mid : mockOrbits()[1].items },
      { id: "outer", name: language.t("session.memory.orbit.archive"), radius: 218, speed: 48, items: outer.length ? outer : mockOrbits()[2].items },
    ]
  })
  type MessageNodeLike = { id: string; time: { created: number }; role: string }
  const [hovered, setHovered] = createSignal<string | undefined>(undefined)
  const [selected, setSelected] = createSignal<MemoryNode | undefined>(undefined)

  const handleSelect = (node: MemoryNode) => {
    setSelected(node)
    props.onSelect?.(node.targetID)
    if (node.kind === "session") {
      // navigate to that session's page — keeps scope/directory from current params
      const target = node.targetID
      try {
        // preserve directory segment from current route if present
        const dir = params.dir
        if (dir) navigate(`/${dir}/session/${target}`)
        else navigate(`/session/${target}`)
      } catch {}
      return
    }
    // message/compaction: jump to anchor in current session
    try {
      const el = document.getElementById(`message-${node.targetID}`)
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" })
      else window.location.hash = `message-${node.targetID}`
    } catch {}
  }

  return (
    <div class="relative flex h-[min(82vh,760px)] w-[min(92vw,980px)] flex-col overflow-hidden rounded-[16px] border border-white/10 bg-[#0a0a0f] shadow-[0_20px_80px_rgba(0,0,0,0.6)]">
      <style>{`
        @keyframes orbit-rotate { from { transform: rotate(0deg)} to { transform: rotate(360deg)} }
        @keyframes billboard { from { transform: rotate(0deg)} to { transform: rotate(-360deg)} }
      `}</style>
      <div class="flex items-center justify-between border-b border-white/10 bg-white/[0.04] px-4 py-3">
        <div class="flex items-center gap-3">
          <div class="flex size-8 items-center justify-center rounded-full bg-[#fcd53a]/15 ring-1 ring-[#fcd53a]/30">
            <IconV2 name="branch" class="size-4 text-[#fcd53a]" />
          </div>
          <div>
            <div class="text-13-medium text-white">{language.t("session.memory.title")}</div>
            <div class="text-11-regular text-white/50">{language.t("session.memory.subtitle")}</div>
          </div>
        </div>
        <div class="flex items-center gap-1">
          <TooltipV2 value={paused() ? language.t("session.memory.play") : language.t("session.memory.pause")} placement="bottom">
            <IconButtonV2
              variant="ghost-muted"
              size="small"
              aria-label={paused() ? language.t("session.memory.play") : language.t("session.memory.pause")}
              icon={<IconV2 name={paused() ? "plus" : "collapse"} />}
              onClick={() => setPaused(!paused())}
            />
          </TooltipV2>
          <IconButtonV2
            variant="ghost-muted"
            size="small"
            aria-label={language.t("common.close")}
            icon={<IconV2 name="xmark-small" />}
            onClick={props.onClose}
          />
        </div>
      </div>

      <div class="relative flex flex-1 items-center justify-center overflow-hidden bg-[radial-gradient(ellipse_at_center,_rgba(252,213,58,0.08),transparent_60%),radial-gradient(ellipse_at_bottom,_rgba(56,189,248,0.06),transparent_60%)]">
        <div class="absolute inset-0 opacity-[0.04]" style={{ background: "radial-gradient(circle at 1px 1px, white 1px, transparent 0)", "background-size": "24px 24px" }} />

        <div class="relative size-[520px] shrink-0">
          <For each={orbits()}>
            {(orbit) => (
              <>
                <div
                  class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-white/12 pointer-events-none"
                  style={{
                    width: `${orbit.radius * 2}px`,
                    height: `${orbit.radius * 2}px`,
                    "box-shadow": "inset 0 0 40px rgba(255,255,255,0.02)",
                  }}
                />
                <div class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[10px] tracking-widest text-white/20 pointer-events-none select-none" style={{ transform: `translate(-50%, -50%) translateY(-${orbit.radius + 10}px)` }}>
                  {orbit.name.toUpperCase()}
                </div>
                <For each={orbit.items}>
                  {(item, idx) => {
                    const delay = -(orbit.speed / orbit.items.length) * idx()
                    const duration = orbit.speed / speed()
                    const isHovered = createMemo(() => hovered() === item.id)
                    return (
                      <div
                        class="absolute left-1/2 top-1/2 size-0 pointer-events-none"
                        style={{
                          animation: `orbit-rotate ${duration}s linear infinite`,
                          "animation-delay": `${delay}s`,
                          "animation-play-state": paused() ? "paused" : "running",
                        }}
                      >
                        <div
                          class="absolute left-0 top-1/2 h-[1.5px] origin-right -translate-y-1/2 pointer-events-none transition-opacity duration-300"
                          style={{
                            width: `${orbit.radius}px`,
                            right: "0",
                            left: "auto",
                            opacity: isHovered() ? "1" : "0",
                            background: `linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.12) 20%, ${item.color} 100%)`,
                            "box-shadow": `0 0 8px ${item.color}`,
                          }}
                        />
                        <div
                          class="absolute flex items-center gap-1.5 rounded-full border bg-[#1a1a22] px-2.5 py-1.5 shadow-lg cursor-pointer pointer-events-auto transition-all"
                          style={{
                            left: `${orbit.radius}px`,
                            top: "50%",
                            transform: "translate(-50%, -50%)",
                            animation: `billboard ${duration}s linear infinite`,
                            "animation-delay": `${delay}s`,
                            "animation-play-state": paused() ? "paused" : "running",
                            "border-color": isHovered() ? item.color : "rgba(255,255,255,0.12)",
                            "box-shadow": isHovered() ? `0 0 18px ${item.color}45, 0 4px 16px rgba(0,0,0,0.4)` : "0 4px 16px rgba(0,0,0,0.4)",
                            scale: isHovered() ? "1.07" : "1",
                          }}
                          onMouseEnter={() => setHovered(item.id)}
                          onMouseLeave={() => setHovered(undefined)}
                          onClick={() => handleSelect(item)}
                        >
                          <span class="size-5 rounded-full flex items-center justify-center shrink-0" style={{ background: `${item.color}1a`, color: item.color }}>
                            <IconV2 name={(item.icon as never) ?? "circle"} class="size-3" />
                          </span>
                          <span class="text-11-medium whitespace-nowrap text-white/90">{item.label}</span>
                        </div>
                      </div>
                    )
                  }}
                </For>
              </>
            )}
          </For>

          <div class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-1">
            <div class="relative flex size-[72px] items-center justify-center rounded-full bg-[radial-gradient(circle_at_30%_30%,_#ffe78a,_#fcd53a_45%,_#eab308_70%)] shadow-[0_0_40px_rgba(252,213,58,0.6),0_0_80px_rgba(252,213,58,0.25)] ring-1 ring-white/20">
              <span class="text-11-bold tracking-widest text-black/70">NOW</span>
              <div class="absolute inset-0 rounded-full animate-pulse border border-white/20 pointer-events-none" />
            </div>
            <div class="text-11-medium text-white/80">Active Epoch</div>
            <div class="text-10-regular text-white/40">center · click a planet</div>
          </div>
        </div>

        <Show when={selected()}>
          {(node) => (
            <div class="absolute bottom-4 left-4 right-4 flex items-center justify-between rounded-xl border border-white/10 bg-black/40 px-4 py-3 backdrop-blur-md">
              <div class="flex items-center gap-3 min-w-0">
                <span class="size-8 rounded-full flex items-center justify-center shrink-0" style={{ background: `${node().color}20`, color: node().color, border: `1px solid ${node().color}40` }}>
                  <IconV2 name={(node().icon as never) ?? "circle"} class="size-4" />
                </span>
                <div class="min-w-0">
                  <div class="text-12-medium text-white truncate">{node().label}</div>
                  <div class="text-11-regular text-white/50 truncate">{node().detail ?? language.t("session.memory.detailFallback")}</div>
                </div>
              </div>
              <button type="button" class="shrink-0 rounded-full bg-white text-black px-3 py-1.5 text-11-medium hover:bg-white/90" onClick={() => setSelected(undefined)}>
                {language.t("common.close")}
              </button>
            </div>
          )}
        </Show>
      </div>

      <div class="flex items-center justify-between border-t border-white/10 bg-white/[0.03] px-4 py-2.5">
        <div class="flex items-center gap-2 text-11-regular text-white/50">
          <span class="hidden sm:inline">{language.t("session.memory.hint")}</span>
          <span class="sm:hidden">{language.t("session.memory.hintShort")}</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-11-regular text-white/40">{language.t("session.memory.speed")}</span>
          <input type="range" min="0.5" max="2" step="0.5" value={String(speed())} onInput={(e) => setSpeed(Number(e.currentTarget.value))} class="w-20 accent-[#fcd53a]" />
        </div>
      </div>
    </div>
  )
}
