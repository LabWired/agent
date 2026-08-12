/**
 * LabWired TUI brand plugin.
 *
 * Replaces the stock engine home_logo slot so the product surface is
 * LabWired Agent (logo + tagline). Loaded via config/tui.json.
 * Install copies this file next to ~/.config/opencode/tui.json as
 * plugins/labwired-brand.tsx.
 */
/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

type ColorMap = Record<string, unknown>

function color(map: ColorMap, name: string, fallback: string): unknown {
  const value = map[name]
  if (typeof value === "string" && value.trim()) return value
  if (value != null && typeof value === "object") return value
  return fallback
}

/**
 * Build a fixed-width logo block.
 * Wire L is left-aligned as one unit (not per-line centered — that looked shifted),
 * then the whole block is padded so the outer box can center it cleanly.
 */
function labwiredLogoArt(): string[] {
  // L-mark columns must match: stem under top node.
  const mark = ["●", "│", "│", "└──●"]
  const title = "L A B W I R E D"
  const rule = "───────────────"
  const agent = "A G E N T"
  const tag = "The easy way to build hardware"
  // Indent a *group* by the same amount so relative columns stay fixed.
  const indentGroup = (lines: string[]) => {
    const groupW = Math.max(0, ...lines.map((l) => l.length))
    const n = Math.max(0, Math.floor((title.length - groupW) / 2))
    const pad = " ".repeat(n)
    return lines.map((l) => pad + l)
  }
  const under = (s: string) => {
    const n = Math.max(0, Math.floor((title.length - s.length) / 2))
    return " ".repeat(n) + s
  }
  const core = [
    ...indentGroup(mark),
    "",
    title,
    rule,
    under(agent),
    "",
    tag,
  ]
  // Equal width via RIGHT pad only — left edges stay fixed so the L never shifts.
  // Outer alignItems=center then moves the whole block as one unit.
  const width = Math.max(...core.map((l) => l.length))
  return core.map((l) => l + " ".repeat(width - l.length))
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    // Win replace mode against the built-in stock home logo.
    order: 0,
    slots: {
      home_logo(ctx) {
        const map = (ctx.theme?.current ?? {}) as ColorMap
        const primary = color(map, "primary", "#3d8fd1")
        const muted = color(map, "textMuted", "#8b91a3")
        const text = color(map, "text", "#e8eaf0")
        const art = labwiredLogoArt()
        const isMuted = (line: string) => line.trim() === "───────────────"
        const isTag = (line: string) =>
          line.trim().startsWith("The easy way to build hardware")
        return (
          <box flexDirection="column" alignItems="center">
            {art.map((line) => (
              <text
                fg={
                  isTag(line) ? text : isMuted(line) ? muted : primary
                }
              >
                {line.length ? line : " "}
              </text>
            ))}
          </box>
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "labwired.brand",
  tui,
}

export default plugin
