# Vendoring `@labwired/mcp` for air-gapped installs

Online install may use `npx -y @labwired/mcp` as a fallback. **Air-gap install refuses naked `npx`.** Provide a real filesystem entry instead.

## Option A — `LABWIRED_MCP_ENTRY`

Point at a local Node entry file (absolute path preferred):

```bash
export LABWIRED_MCP_ENTRY=/path/to/node_modules/@labwired/mcp/dist/index.js
./install.sh --airgap
```

The resolver rewrites OpenCode config to:

```json
["node", "/absolute/path/to/index.js"]
```

## Option B — vendor under this repo

From a machine with network:

```bash
# From a machine with network:
npm pack @labwired/mcp
# extract the package; copy dist/index.js (and any required siblings) into:
#   agent/mcp/vendor/index.js
# or: export LABWIRED_MCP_ENTRY=/path/to/node_modules/@labwired/mcp/dist/index.js
./install.sh --airgap
```

Layout expected by the resolver:

```text
mcp/vendor/index.js   # Node entry for the MCP server
```

`install.sh --airgap` (or `LABWIRED_PROFILE=airgap`) fails closed if neither `LABWIRED_MCP_ENTRY` nor `mcp/vendor/index.js` is present.

## Force online npx

```bash
export LABWIRED_MCP_ALLOW_NPX=1
# or omit --airgap (default profile is online)
./install.sh
```

## Resolution priority

1. `LABWIRED_MCP_ENTRY` if it is an existing file → `["node", <abs>]`
2. `<agent-root>/mcp/vendor/index.js` if present → `["node", <abs>]`
3. `LABWIRED_MCP_ALLOW_NPX=1|true` → `["npx","-y","@labwired/mcp"]`
4. `LABWIRED_PROFILE=airgap` without (1) or (2) → **error**
5. Online default → `["npx","-y","@labwired/mcp"]`
