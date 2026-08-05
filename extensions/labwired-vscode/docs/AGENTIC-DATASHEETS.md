# Agentic datasheets (not vector RAG)

## Why not RAG

Vector chunk-and-embed pipelines:

- Lose register-table structure
- Go stale when PDFs update
- Add infra (vectors, reindex) for little gain with long-context models
- Encourage “retrieve 3 chunks” instead of reading the right section

## What we do instead

**Tools over the full extracted text** (same idea as agents grepping a repo):

| Tool | Action |
|------|--------|
| `/datasheet list` | List PDFs + extract status |
| `/datasheet extract` | `pdftotext -layout` → `.labwired/datasheets/.text/` |
| `/datasheet grep <pattern>` | Regex over full text with context lines |
| `/datasheet section <id> <title>` | Jump to heading / page section |

Agent freeform prompts get a **short inventory** of available docs, then use tools to open the right window.

## Setup

```bash
brew install poppler   # pdftotext
# In project:
mkdir -p .labwired/datasheets
# drop RM0090.pdf, bme280.pdf, …
```

Then in chat: `/datasheet extract` → `/datasheet grep USART_BRR`
