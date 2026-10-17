import { For, Show, createMemo, createSignal, onCleanup, createEffect } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { useServerSync } from "@/context/server-sync"
import { sessionHref } from "@/utils/session-route"
import { useServer } from "@/context/server"
import { sessionTitle as formatTitle } from "@/utils/session-title"

function hash01(input: string) {
  let h = 0
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) >>> 0
  return (h % 1000) / 1000
}
function hashHue(input: string) {
  return Math.floor(hash01(input) * 360)
}
type Pos = { x: number; y: number; tx: number; ty: number; dir: 1 | -1; sitting: boolean }

// Decluttered: only 4 tables, generous breathing room
const TABLES = [
  { x: 22, y: 32 },
  { x: 78, y: 32 },
  { x: 22, y: 82 },
  { x: 78, y: 82 },
]
function seatFor(id: string) {
  const ti = Math.floor(hash01(id) * TABLES.length) % TABLES.length
  const t = TABLES[ti] ?? TABLES[0]!
  const side = hash01(id + "side") > 0.5 ? -1 : 1
  return { x: t.x + side * 9.5, y: t.y + 1.5, ti }
}

function CoffeeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none">
      <path d="M3 4.5h8a1.5 1.5 0 0 1 1.5 1.5v2A2.5 2.5 0 0 1 10 10.5H5.5A2.5 2.5 0 0 1 3 8V4.5Z" fill="#FFF" stroke="#8B6A3A" stroke-width="1.3" />
      <path d="M12.5 6.5h1a1.25 1.25 0 0 1 0 2.5h-1" stroke="#8B6A3A" stroke-width="1.1" />
      <ellipse cx="7.2" cy="8" rx="2.8" ry="0.9" fill="#6F4A1F" opacity="0.95" />
    </svg>
  )
}
function LaptopIcon() {
  return (
    <svg viewBox="0 0 20 14" width="16" height="10" fill="none">
      <rect x="1" y="1" width="18" height="10" rx="1.6" fill="#0F172A" stroke="#1E293B" />
      <rect x="3" y="3" width="14" height="6" rx="1" fill="#A7F3D0" />
      <text x="5.8" y="7.4" font-size="4.8" font-family="monospace" fill="#065F46" font-weight="700">{"</>"}</text>
    </svg>
  )
}

function HumanSVG(props: { hue: number; dir: 1 | -1; walking: boolean; sitting: boolean; busy: boolean }) {
  const skin = props.hue > 200 ? "#FDD8B8" : props.hue > 120 ? "#F5CBA7" : "#FFE9C4"
  const hair = `hsl(${props.hue} 58% 42%)`
  const shirt = `hsl(${(props.hue + 38) % 360} 58% 56%)`
  return (
    <svg viewBox="0 0 48 56" width="40" height="45" class="drop-shadow-[0_3px_7px_rgba(0,0,0,0.14)]" style={{ transform: `scaleX(${props.dir})` } as any}>
      <ellipse cx="24" cy="52" rx={props.sitting ? 10 : 12} ry="3.2" fill="rgba(0,0,0,0.12)" />
      <Show when={props.sitting}>
        <rect x="12" y="32" width="24" height="14" rx="4" fill="#D9C7A0" stroke="#C2B08C" stroke-width="0.7" />
      </Show>
      <g class="human-legs" classList={{ walking: props.walking && !props.sitting }}>
        <Show when={!props.sitting} fallback={<>
          <rect x="18" y="39" width="5.5" height="7.5" rx="2.7" fill="#1F2937" />
          <rect x="25.5" y="39" width="5.5" height="7.5" rx="2.7" fill="#1F2937" />
        </>}>
          <rect x="15.5" y="34" width="6.5" height="13" rx="3" fill="#1F2937" />
          <rect x="26.5" y="34" width="6.5" height="13" rx="3" fill="#1F2937" />
          <ellipse cx="18.7" cy="49" rx="4.5" ry="1.8" fill="#0F172A" />
          <ellipse cx="29.7" cy="49" rx="4.5" ry="1.8" fill="#0F172A" />
        </Show>
      </g>
      <rect x="14.5" y={props.sitting ? 23 : 20.5} width="19" height="14.5" rx="6.5" fill={shirt} stroke="rgba(0,0,0,0.06)" />
      <Show when={props.busy} fallback={<>
        <rect x="8" y={props.sitting ? 27 : 25} width="9" height="5.5" rx="2.7" fill={skin} />
        <rect x="32" y={props.sitting ? 27 : 25} width="9" height="5.5" rx="2.7" fill={skin} />
      </>}>
        <rect x="6" y={props.sitting ? 28.5 : 26.5} width="10" height="6.5" rx="3" fill={skin} />
        <rect x="32" y={props.sitting ? 28.5 : 26.5} width="10" height="6.5" rx="3" fill={skin} />
        <rect x="12.5" y={props.sitting ? 30 : 28} width="23" height="11.5" rx="2.6" fill="#0F172A" />
        <rect x="14.5" y={props.sitting ? 32 : 30} width="19" height="7" rx="1.3" fill="#A7F3D0" />
        <text x="17" y={props.sitting ? 36.5 : 34.5} font-size="4.4" fill="#065F46" font-family="monospace" font-weight="700">{"</>"}</text>
      </Show>
      <circle cx="24" cy={props.sitting ? 16.5 : 14.2} r="10.2" fill={skin} stroke="rgba(0,0,0,0.06)" />
      <path d={props.sitting ? "M14 16.5 C14 7.5, 20 4.5, 24 4.5 C28 4.5, 34 7.5, 34 16.5 L32 11.5 C30 7.5, 18 7.5, 16 11.5 Z" : "M13.5 14.2 C13.5 5.5, 20 2.5, 24 2.5 C28 2.5, 34.5 5.5, 34.5 14.2 L32.2 10 C30 6, 18 6, 15.8 10 Z"} fill={hair} />
      <circle cx="20.3" cy={props.sitting ? 17 : 14.6} r="1.15" fill="#0F172A" />
      <circle cx="27.7" cy={props.sitting ? 17 : 14.6} r="1.15" fill="#0F172A" />
      <path d={props.sitting ? "M20.8 20 Q24 21.6 27.2 20" : "M20.2 18 Q24 19.8 27.8 18"} stroke="#7C2D12" stroke-width="1.1" fill="none" stroke-linecap="round" />
    </svg>
  )
}

export default function Playground() {
  const sync = useServerSync()
  const navigate = useNavigate()
  const server = useServer()

  const activeSessions = createMemo(() => {
    const info = sync().session.data.info
    const status = sync().session.data.session_status
    const list = Object.values(info).filter(Boolean) as import("@novacode-ai/sdk/v2/client").Session[]
    return list.filter((s) => {
      const t = status[s.id]?.type
      return t === "busy" || t === "retry"
    })
  })
  const total = createMemo(() => Object.keys(sync().session.data.info).length)
  const [pos, setPos] = createStore<Record<string, Pos>>({})
  const [hover, setHover] = createSignal<string | null>(null)
  const [demo, setDemo] = createSignal(true)

  let prevSigs = new Map<string, string>()
  let firstRun = true
  createEffect(() => {
    const sessions = activeSessions()
    const ids = sessions.map((s) => s.id)
    const status = sync().session.data.session_status
    const cur = new Map<string, string>()
    for (const s of sessions) {
      const title = formatTitle(s.title) || s.id
      const st = status[s.id]?.type ?? "busy"
      cur.set(s.id, `${title}|${st}`)
    }
    for (const s of sessions) if (!pos[s.id]) {
      const seat = seatFor(s.id)
      setPos(s.id, { x: seat.x, y: seat.y, tx: seat.x, ty: seat.y, dir: hash01(s.id) > 0.5 ? 1 : -1, sitting: true })
    }
    for (const key of Object.keys(pos)) if (!ids.includes(key)) {
      const c = { ...pos }; delete (c as any)[key]; // @ts-ignore
      setPos(c); prevSigs.delete(key)
    }
    if (!firstRun) {
      for (const s of sessions) {
        const prev = prevSigs.get(s.id)
        const now = cur.get(s.id)!
        if (prev !== undefined && prev !== now) {
          const curPos = pos[s.id]
          if (!curPos?.sitting) continue
          const curTi = seatFor(s.id).ti
          let tries = 0
          let next = seatFor(s.id + String(Date.now()))
          while (next.ti === curTi && tries < 5) { tries++; next = seatFor(s.id + String(Math.random())) }
          const jx = (hash01(s.id + now) - 0.5) * 2
          setPos(s.id, "tx", next.x + jx); setPos(s.id, "ty", next.y); setPos(s.id, "sitting", false); setPos(s.id, "dir", next.x > curPos.x ? 1 : -1)
        }
      }
    }
    prevSigs = cur; firstRun = false
  })

  const doTick = () => {
    for (const id of Object.keys(pos)) {
      const p = pos[id]!
      if (p.sitting) continue
      const dx = p.tx - p.x, dy = p.ty - p.y, dist = Math.hypot(dx, dy)
      if (dist < 0.8) { setPos(id, "x", p.tx); setPos(id, "y", p.ty); setPos(id, "sitting", true) }
      else { const spd = 0.9 + hash01(id) * 0.4; setPos(id, "x", p.x + (dx / dist) * spd); setPos(id, "y", p.y + (dy / dist) * spd); setPos(id, "dir", dx > 0 ? 1 : -1) }
    }
  }
  let timer: ReturnType<typeof setInterval> | undefined
  createEffect(() => {
    const moving = Object.values(pos).some((p) => !p.sitting)
    if (moving) { if (timer) clearInterval(timer); timer = setInterval(doTick, 42); onCleanup(() => clearInterval(timer)) }
    else { if (timer) clearInterval(timer); timer = undefined }
  })
  onCleanup(() => timer && clearInterval(timer))

  const tables = TABLES
  const demoHumans = [
    { id: "d1", hue: 30, title: "Fix scroll state" },
    { id: "d2", hue: 200, title: "Review PR #42" },
  ]

  return (
    <div class="m-2 min-h-0 flex-1 self-stretch overflow-hidden rounded-[14px] bg-[#FFFBF8] dark:bg-[#0F0E0D] shadow-[0_8px_30px_rgba(0,0,0,0.10)] flex flex-col border border-[#E9DDC2] dark:border-zinc-800">
      <header class="flex items-center justify-between gap-3 px-5 py-3 bg-white dark:bg-zinc-900 border-b border-[#E9DDC2] dark:border-zinc-800 shrink-0">
        <div class="flex items-center gap-3 min-w-0">
          <div class="h-8 w-8 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 grid place-items-center text-white shadow-sm shrink-0 text-[14px]">☕</div>
          <div class="min-w-0">
            <div class="text-[13px] font-[750] leading-none truncate">Agent Coffee Shop</div>
            <div class="text-[11px] text-zinc-500 dark:text-zinc-400 leading-none mt-0.5 truncate">Sitting until task changes • click to open</div>
          </div>
          <span class="hidden lg:inline-flex items-center gap-1.5 rounded-full bg-emerald-50 dark:bg-emerald-950/25 text-emerald-700 dark:text-emerald-300 border border-emerald-200/70 dark:border-emerald-900 px-2.5 py-1 text-[11px] font-[700]">
            <span class="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" /> {activeSessions().length} active
            <span class="opacity-40">• {total()} total</span>
          </span>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <Show when={activeSessions().length === 0}>
            <button onClick={() => setDemo((v) => !v)} class="hidden sm:inline-flex rounded-full bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 px-3 py-1 text-[11px] font-[600]">
              {demo() ? "Hide demo" : "Show demo"}
            </button>
          </Show>
          <button class="rounded-full border border-zinc-200 dark:border-zinc-700 px-3.5 py-1.5 text-[12px] font-[600] hover:bg-zinc-50 dark:hover:bg-zinc-800" onClick={() => navigate("/")}>← Home</button>
        </div>
      </header>

      <div class="relative flex-1 overflow-hidden bg-[#FFF8EB] dark:bg-[#12100E]">
        {/* minimal floor - soft cream, very subtle grid */}
        <div class="absolute inset-0 top-[14%] bg-[#FFF6E0] dark:bg-[#1A1816]" />
        <div class="absolute inset-0 top-[14%] opacity-[0.035]" style={{ background: "linear-gradient(to right, #000 1px, transparent 1px), linear-gradient(to bottom, #000 1px, transparent 1px)", "background-size": "96px 96px" } as any} />
        {/* single subtle rug */}
        <div class="absolute left-1/2 top-[60%] -translate-x-1/2 h-[28%] w-[42%] rounded-[20px] bg-[#F0E2C0]/35 dark:bg-white/[0.04] border border-[#E9DDC2]/40 dark:border-white/5" />

        {/* top bar - ultra minimal */}
        <div class="absolute inset-x-0 top-0 h-[14%] bg-[#FFFDF5] dark:bg-[#1A1816] border-b border-[#EDE3C8] dark:border-zinc-800 flex items-center justify-between px-6">
          <div class="flex items-center gap-3">
            <div class="hidden sm:flex h-8 px-3 rounded-full bg-zinc-900 text-amber-100 items-center gap-2 text-[11px] font-[600] tracking-wide">
              <span class="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" /> OPEN • task change = walk
            </div>
            <div class="hidden md:flex gap-1.5">
              <For each={Array.from({ length: 5 })}>
                {(_, i) => <div class="h-1.5 w-1.5 rounded-full bg-amber-200/80" style={{ opacity: `${0.55 + i() * 0.08}` } as any} />}
              </For>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <div class="h-9 w-14 rounded-[10px] bg-[#7A4A1F] border border-[#5A3410] grid place-items-center text-white shadow-sm">
              <span class="text-[10px] font-[800] tracking-[0.12em]">DOOR</span>
            </div>
            <div class="hidden sm:block text-[11px] text-zinc-400">counter →</div>
          </div>
        </div>

        {/* counter - slimmer, cleaner */}
        <div class="absolute right-[5%] top-[18%] bottom-[42%] w-[13%] rounded-[12px] bg-[#E8C99A] dark:bg-[#2E2618] border border-[#D4B98A] dark:border-[#3A2E1A] shadow-[0_6px_16px_rgba(0,0,0,0.10)] flex flex-col items-center pt-3 gap-2">
          <div class="text-[8px] font-[800] tracking-[0.16em] text-[#5A3E1B]/70 dark:text-white/60">COUNTER</div>
          <div class="h-7 w-7 rounded-full bg-white grid place-items-center text-[13px] shadow-sm">🧑‍🍳</div>
          <div class="text-[7px] font-[600] text-[#5A3E1B]/60 dark:text-white/40">barista</div>
        </div>

        <For each={tables}>
          {(t) => (
            <div class="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${t.x}%`, top: `${t.y}%` }}>
              <div class="absolute left-1/2 top-[55%] -translate-x-1/2 h-[14px] w-[70px] rounded-full bg-black/[0.08] blur-[4px]" />
              <div class="relative h-[54px] w-[76px] rounded-[14px] bg-white dark:bg-zinc-800 border border-[#E9DDC2] dark:border-white/10 shadow-[0_6px_14px_rgba(0,0,0,0.08)] grid place-items-center">
                <div class="flex items-center gap-1.5">
                  <span class="h-6 w-6 rounded-full bg-[#FFFBF0] dark:bg-zinc-900 border border-black/5 grid place-items-center"><CoffeeIcon /></span>
                  <LaptopIcon />
                </div>
              </div>
              <div class="absolute -left-2 top-1/2 -translate-y-1/2 h-5 w-2 rounded-full bg-[#E2CC9F] dark:bg-zinc-700 border border-black/5" />
              <div class="absolute -right-2 top-1/2 -translate-y-1/2 h-5 w-2 rounded-full bg-[#E2CC9F] dark:bg-zinc-700 border border-black/5" />
            </div>
          )}
        </For>

        <Show when={activeSessions().length === 0 && demo()}>
          <For each={demoHumans}>
            {(d, i) => {
              const idx = i()
              const t = tables[idx % tables.length]!
              const side = idx % 2 === 0 ? 1 : -1
              return (
                <div class="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center pointer-events-none" style={{ left: `${t.x + side * 9.5}%`, top: `${t.y + 1.5}%` } as any}>
                  <div class="rounded-full bg-white dark:bg-zinc-900 border border-black/10 shadow-sm px-2.5 py-1 text-[10px] font-[600] mb-1 whitespace-nowrap">
                    {d.title} <span class="opacity-40">• demo</span>
                  </div>
                  <HumanSVG hue={d.hue} dir={side as 1 | -1} walking={false} sitting={true} busy={true} />
                </div>
              )
            }}
          </For>
        </Show>

        <Show when={activeSessions().length > 0} fallback={
          <div class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(420px,88%)] pointer-events-none">
            <div class="rounded-[14px] bg-white dark:bg-zinc-900 border border-black/5 dark:border-white/10 shadow-[0_12px_28px_rgba(0,0,0,0.12)] px-6 py-5 text-center">
              <div class="mx-auto h-10 w-10 rounded-full bg-amber-500 grid place-items-center text-white text-[18px]">☕</div>
              <div class="mt-3 text-[13px] font-[700]">Quiet shop — no active chats</div>
              <div class="mt-1 text-[12px] leading-5 text-zinc-500">Humans sit until their task changes, then they walk to a new table. Idle chats stay hidden.</div>
              <div class="mt-3 text-[11px] text-zinc-400">{total()} total • demo shown • walking = task changed</div>
            </div>
          </div>
        }>
          <For each={[...activeSessions()].sort((a, b) => (pos[a.id]?.y ?? 0) - (pos[b.id]?.y ?? 0))}>
            {(session) => {
              const title = () => formatTitle(session.title) || "Untitled"
              const p = () => pos[session.id]
              const sitting = () => p()?.sitting ?? true
              const walking = () => !sitting()
              return (
                <button
                  type="button"
                  onMouseEnter={() => setHover(session.id)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => navigate(sessionHref(server.key, session.id))}
                  class="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center"
                  style={{ left: `${p()?.x ?? 50}%`, top: `${p()?.y ?? 50}%`, "z-index": `${Math.floor((p()?.y ?? 50) * 10 + 20)}`, transition: sitting() ? "none" : "left 42ms linear, top 42ms linear" } as any}
                >
                  <div class="pointer-events-none rounded-full bg-white dark:bg-zinc-900 border border-black/10 shadow px-2.5 py-1 text-[11px] font-[600] flex items-center gap-1.5 max-w-[160px]">
                    <span class="h-2 w-2 rounded-full shrink-0" classList={{ "bg-emerald-500": sitting(), "bg-amber-500 animate-pulse": walking() }} />
                    <span class="truncate">{title()}</span>
                    <span class="hidden sm:inline text-[9px] px-1 py-0.5 rounded-full border shrink-0" classList={{ "bg-zinc-50 border-zinc-200": sitting(), "bg-amber-50 border-amber-200": walking() }}>{sitting() ? "sitting" : "walking"}</span>
                  </div>
                  <div class="mt-1"><HumanSVG hue={hashHue(session.id)} dir={p()?.dir ?? 1} walking={walking()} sitting={sitting()} busy={true} /></div>
                  <Show when={hover() === session.id}>
                    <div class="mt-1 rounded-full bg-zinc-900 text-white text-[10px] px-2 py-0.5">open →</div>
                  </Show>
                </button>
              )
            }}
          </For>
        </Show>

        <div class="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-white/90 dark:bg-zinc-900/90 backdrop-blur border border-black/5 shadow px-3 py-1 text-[10px] font-[500] text-zinc-600 dark:text-zinc-300 whitespace-nowrap">
          sitting = stable • walking = task changed • click human → chat
        </div>
      </div>
      <style>{`.human-legs.walking{animation:legs 0.28s ease-in-out infinite alternate}@keyframes legs{from{transform:translateY(0)}to{transform:translateY(0.7px)}}`}</style>
    </div>
  )
}
