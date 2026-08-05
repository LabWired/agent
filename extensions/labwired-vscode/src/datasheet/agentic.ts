/**
 * Agentic datasheet access — NOT vector RAG.
 *
 * Why not RAG: chunk/embed pipelines go stale, lose structure, and fight
 * long-context models. Better: keep full text on disk, let the agent
 * navigate with tools (list → extract → grep → read section) — same
 * pattern as modern coding agents reading a repo.
 *
 * Pipeline:
 *   PDF → pdftotext (or plain md/txt) → .labwired/datasheets/.text/
 *   Section map from form-feed / headings → grep → on-demand windows
 */
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import * as vscode from "vscode";

export type DatasheetDoc = {
  id: string;
  sourcePath: string;
  textPath: string;
  title: string;
  pagesApprox: number;
  chars: number;
  sections: { title: string; offset: number; length: number }[];
};

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function datasheetDir(): string | undefined {
  const root = workspaceRoot();
  if (!root) return undefined;
  return path.join(root, ".labwired", "datasheets");
}

function textCacheDir(): string | undefined {
  const d = datasheetDir();
  if (!d) return undefined;
  return path.join(d, ".text");
}

function findPdftotext(): string | null {
  for (const c of [
    "pdftotext",
    "/opt/homebrew/bin/pdftotext",
    "/usr/local/bin/pdftotext",
    "/usr/bin/pdftotext",
  ]) {
    try {
      const r = spawnSync(c, ["-v"], { encoding: "utf8" });
      // pdftotext prints version to stderr, exit 0 or 99
      if (r.error) continue;
      return c;
    } catch {
      /* */
    }
  }
  return null;
}

function extractPdf(pdfPath: string, outTxt: string): { ok: boolean; error?: string } {
  const bin = findPdftotext();
  if (!bin) {
    return {
      ok: false,
      error:
        "pdftotext not found. Install poppler: brew install poppler (macOS) / apt install poppler-utils",
    };
  }
  // layout preserves columns better for register tables
  const r = spawnSync(bin, ["-layout", pdfPath, outTxt], { encoding: "utf8" });
  if (!fs.existsSync(outTxt) || fs.statSync(outTxt).size === 0) {
    return {
      ok: false,
      error: r.stderr || r.stdout || "pdftotext produced empty output",
    };
  }
  return { ok: true };
}

function parseSections(text: string): DatasheetDoc["sections"] {
  const sections: DatasheetDoc["sections"] = [];
  // form-feed page breaks
  const pages = text.split("\f");
  if (pages.length > 1) {
    let offset = 0;
    pages.forEach((p, i) => {
      const first = p.trim().split("\n").find((l) => l.trim().length > 3) || `Page ${i + 1}`;
      sections.push({
        title: first.slice(0, 80).replace(/\s+/g, " "),
        offset,
        length: p.length,
      });
      offset += p.length + 1;
    });
    return sections;
  }
  // heading-like lines
  const lines = text.split("\n");
  let offset = 0;
  for (const line of lines) {
    const t = line.trim();
    if (
      /^(\d+(\.\d+){0,3}\s+|[A-Z][A-Z0-9 \-/]{8,}|Section\s+\d+|CHAPTER\s+\d+)/.test(
        t
      ) &&
      t.length < 100
    ) {
      sections.push({ title: t.slice(0, 100), offset, length: 0 });
    }
    offset += line.length + 1;
  }
  // fill lengths
  for (let i = 0; i < sections.length; i++) {
    const end =
      i + 1 < sections.length ? sections[i + 1].offset : text.length;
    sections[i].length = Math.max(0, end - sections[i].offset);
  }
  if (!sections.length) {
    sections.push({ title: "full document", offset: 0, length: text.length });
  }
  return sections;
}

export class DatasheetService {
  ensureDirs(): string {
    const d = datasheetDir();
    if (!d) throw new Error("Open a workspace folder first");
    fs.mkdirSync(d, { recursive: true });
    fs.mkdirSync(path.join(d, ".text"), { recursive: true });
    const readme = path.join(d, "README.md");
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(
        readme,
        `# Project datasheets (agentic — not vector RAG)

Drop PDF / MD / TXT reference manuals here.

LabWired extracts text and lets the agent **navigate** with tools:
- list documents
- grep / search strings (register names, "USART_BRR")
- read by section / byte window

No embedding index. Structure + tools > chunk RAG.

Install PDF extract: \`brew install poppler\` (pdftotext)
`,
        "utf8"
      );
    }
    return d;
  }

  listSources(): { name: string; path: string; kind: string }[] {
    const d = datasheetDir();
    if (!d || !fs.existsSync(d)) return [];
    return fs
      .readdirSync(d)
      .filter((f) => !f.startsWith(".") && /\.(pdf|md|txt)$/i.test(f))
      .map((f) => ({
        name: f,
        path: path.join(d, f),
        kind: path.extname(f).slice(1).toLowerCase(),
      }));
  }

  /** Extract (or re-extract) all sources into .text cache */
  extractAll(force = false): { docs: DatasheetDoc[]; errors: string[] } {
    const d = this.ensureDirs();
    const cache = textCacheDir()!;
    const docs: DatasheetDoc[] = [];
    const errors: string[] = [];

    for (const src of this.listSources()) {
      try {
        const id = src.name.replace(/\.[^.]+$/, "");
        const textPath = path.join(cache, id + ".txt");
        const metaPath = path.join(cache, id + ".meta.json");

        if (src.kind === "pdf") {
          if (force || !fs.existsSync(textPath)) {
            const r = extractPdf(src.path, textPath);
            if (!r.ok) {
              errors.push(`${src.name}: ${r.error}`);
              continue;
            }
          }
        } else {
          // md/txt copy
          if (force || !fs.existsSync(textPath)) {
            fs.copyFileSync(src.path, textPath);
          }
        }

        const text = fs.readFileSync(textPath, "utf8");
        const sections = parseSections(text);
        const pagesApprox = (text.match(/\f/g) || []).length + 1;
        const doc: DatasheetDoc = {
          id,
          sourcePath: src.path,
          textPath,
          title: id,
          pagesApprox,
          chars: text.length,
          sections,
        };
        fs.writeFileSync(metaPath, JSON.stringify(doc, null, 2));
        docs.push(doc);
      } catch (e) {
        errors.push(`${src.name}: ${e}`);
      }
    }
    return { docs, errors };
  }

  loadMeta(id: string): DatasheetDoc | null {
    const cache = textCacheDir();
    if (!cache) return null;
    const metaPath = path.join(cache, id + ".meta.json");
    if (!fs.existsSync(metaPath)) {
      this.extractAll(false);
    }
    if (!fs.existsSync(metaPath)) return null;
    return JSON.parse(fs.readFileSync(metaPath, "utf8")) as DatasheetDoc;
  }

  readWindow(
    id: string,
    offset: number,
    length: number
  ): { text: string; chars: number } {
    const meta = this.loadMeta(id);
    if (!meta) throw new Error(`Unknown datasheet: ${id}. Run extract first.`);
    const text = fs.readFileSync(meta.textPath, "utf8");
    const start = Math.max(0, offset);
    const end = Math.min(text.length, start + Math.min(length, 24000));
    return { text: text.slice(start, end), chars: text.length };
  }

  readSection(id: string, sectionQuery: string): string {
    const meta = this.loadMeta(id);
    if (!meta) throw new Error(`Unknown datasheet: ${id}`);
    const q = sectionQuery.toLowerCase();
    const sec =
      meta.sections.find((s) => s.title.toLowerCase().includes(q)) ||
      meta.sections.find((s) => s.title.toLowerCase() === q);
    if (!sec) {
      return (
        `Section not found: ${sectionQuery}\nAvailable (first 40):\n` +
        meta.sections
          .slice(0, 40)
          .map((s, i) => `  [${i}] ${s.title}`)
          .join("\n")
      );
    }
    return this.readWindow(id, sec.offset, Math.min(sec.length, 20000)).text;
  }

  /**
   * Grep-style search across extracted text (agentic, not embeddings).
   */
  grep(
    pattern: string,
    opts?: { id?: string; context?: number; maxHits?: number }
  ): string {
    const context = opts?.context ?? 2;
    const maxHits = opts?.maxHits ?? 40;
    const re = new RegExp(pattern, "gi");
    const { docs, errors } = this.extractAll(false);
    const linesOut: string[] = [];
    if (errors.length) linesOut.push("Extract warnings:", ...errors.map((e) => `  ${e}`), "");

    let hits = 0;
    for (const doc of docs) {
      if (opts?.id && doc.id !== opts.id) continue;
      const text = fs.readFileSync(doc.textPath, "utf8");
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) {
          re.lastIndex = 0;
          continue;
        }
        re.lastIndex = 0;
        hits++;
        const from = Math.max(0, i - context);
        const to = Math.min(lines.length - 1, i + context);
        linesOut.push(`── ${doc.id}:${i + 1} ──`);
        for (let j = from; j <= to; j++) {
          const mark = j === i ? "›" : " ";
          linesOut.push(`${mark} ${j + 1}: ${lines[j]}`);
        }
        linesOut.push("");
        if (hits >= maxHits) {
          linesOut.push(`(truncated at ${maxHits} hits)`);
          return linesOut.join("\n");
        }
      }
    }
    if (!hits) linesOut.push(`No matches for /${pattern}/`);
    return linesOut.join("\n");
  }

  /** Compact briefing for agent system prompt — still agentic tools, not RAG chunks */
  agentBrief(): string {
    const sources = this.listSources();
    if (!sources.length) {
      return "No datasheets in .labwired/datasheets/ yet. Drop PDFs there; use /datasheet extract.";
    }
    const { docs } = this.extractAll(false);
    return [
      "## Datasheets (agentic tools — not vector RAG)",
      ...docs.map(
        (d) =>
          `- ${d.id}: ${d.chars} chars, ~${d.pagesApprox} pages, ${d.sections.length} sections`
      ),
      "Tools: /datasheet list | extract | grep <pattern> | section <id> <title> | read <id> <offset> <len>",
    ].join("\n");
  }
}
