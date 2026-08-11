/**
 * LabWired TUI brand plugin.
 *
 * Replaces the OpenCode home_logo slot so the product surface is LabWired CLI,
 * not OpenCode. Engine remains OpenCode under the hood.
 *
 * Loaded via config/tui.json → plugin: ["./plugins/labwired-brand.tsx"]
 * (path is relative to the tui.json that declares it; install copies this
 * file next to ~/.config/opencode/tui.json as plugins/labwired-brand.tsx).
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

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    // Win replace mode against the built-in OpenCode Logo.
    order: 0,
    slots: {
      home_logo(ctx) {
        const map = (ctx.theme?.current ?? {}) as ColorMap
        const primary = color(map, "primary", "#3d8fd1")
        const muted = color(map, "textMuted", "#8b91a3")
        const text = color(map, "text", "#e8eaf0")
        // Simple, product-owned mark — not the OpenCode wordmark.
        const art = [
          "  L A B W I R E D",
          "  ───────────────",
          "  A G E N T",
        ]
        return (
          <box flexDirection="column" alignItems="center">
            {art.map((line, i) => (
              <text fg={i === 1 ? muted : primary}>{line}</text>
            ))}
            <box height={1} />
            <text fg={text}>Write firmware · check on a twin</text>
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
