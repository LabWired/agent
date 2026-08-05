# LabWired Pro — what we actually sell

Extension UX is **delivery**. Pro **value** is not “Embedder clone complete.”

## Four pillars (only these justify a seat)

| Pillar | Customer gets | Free alternative |
|--------|---------------|------------------|
| **Model** | Hosted / good default LLM | BYO Ollama / API key |
| **Catalog** | Full maintained parts/platforms | Thin open facts + local PDFs |
| **Workbench** | Polished IDE agent + evidence + serial | CLI + MCP |
| **Twin** | Priority / reliable virtual-board verify | Local sim / community MCP |

## Sense check for new features

Ship in Pro only if it strengthens a pillar. Examples:

| Feature | Pillar? | Verdict |
|---------|---------|---------|
| Parts catalog search | Catalog | **Pro core** (full set) |
| Hosted model routing | Model | **Pro core** |
| Evidence / twin verify | Twin | Free + Pro (don’t gate honesty) |
| Serial monitor | Workbench | Free capable, Pro polish |
| GDB/RTT helpers | Workbench/HW | Nice; not the SKU |
| GitHub daemon | Team scale | Pro team, not free hero |
| Vector RAG | — | **Avoid as product** — agentic datasheets instead |

## Free stays PLG

Anyone can `curl | bash`, run doctor, verify on a twin with BYO model.  
Pro is for teams that want **model + catalog + workbench** without building the stack.

## Architecture (how we deliver, not what we sell)

Thin client → `labwired server` → tools + twin + catalog + model.  
Same *shape* as Embedder; **different paid core** (twin + catalog + model, not datasheet cloud + 30 instruments).

See [docs/PRODUCT.md](../../docs/PRODUCT.md).
