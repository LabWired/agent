#!/usr/bin/env node
/**
 * LabWired GitHub daemon — Embedder `start daemon` analogue.
 *
 * Polls GitHub for issue/PR comments containing @labwired (or configured mention),
 * claims work, runs `opencode run` / labwired agent in a worktree, optional PR.
 *
 * Env:
 *   GITHUB_TOKEN / GH_TOKEN   required
 *   LABWIRED_GITHUB_REPO      owner/name (or detect from git remote)
 *   LABWIRED_GITHUB_MENTION   default @labwired
 *   LABWIRED_DAEMON_POLL_MS   default 60000
 *   LABWIRED_DAEMON_DRY_RUN   1 = don't run agent, only log
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const mention = (process.env.LABWIRED_GITHUB_MENTION || "@labwired").toLowerCase();
const pollMs = Number(process.env.LABWIRED_DAEMON_POLL_MS || 60_000);
const dry = process.env.LABWIRED_DAEMON_DRY_RUN === "1";
const statePath =
  process.env.LABWIRED_DAEMON_STATE ||
  path.join(os.homedir(), ".labwired", "daemon-state.json");

function log(...a) {
  console.error(new Date().toISOString(), ...a);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { seen: {} };
  }
}

function saveState(s) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
}

function detectRepo() {
  if (process.env.LABWIRED_GITHUB_REPO) return process.env.LABWIRED_GITHUB_REPO;
  const r = spawnSync("git", ["remote", "get-url", "origin"], {
    encoding: "utf8",
  });
  const url = (r.stdout || "").trim();
  const m = url.match(/github\.com[:/](.+?)(?:\.git)?$/i);
  return m ? m[1] : null;
}

async function gh(apiPath) {
  if (!token) throw new Error("GITHUB_TOKEN / GH_TOKEN required");
  const res = await fetch(`https://api.github.com${apiPath}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "labwired-daemon",
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

async function findMentions(repo) {
  // Search recent issue comments via events is heavy; use search API
  const q = encodeURIComponent(
    `repo:${repo} ${mention} in:comments is:issue is:open`
  );
  try {
    const data = await gh(`/search/issues?q=${q}&sort=updated&per_page=10`);
    return data.items || [];
  } catch (e) {
    log("search failed", e.message);
    return [];
  }
}

function runAgent(workdir, prompt) {
  if (dry) {
    log("DRY_RUN would run agent:", prompt.slice(0, 120));
    return 0;
  }
  log("running agent in", workdir);
  const r = spawnSync(
    "opencode",
    ["run", "--auto", "--agent", "labwired", prompt],
    {
      cwd: workdir,
      encoding: "utf8",
      env: process.env,
      timeout: 600_000,
    }
  );
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status ?? 1;
}

async function handleIssue(repo, issue) {
  const state = loadState();
  const key = `issue:${issue.number}:${issue.updated_at}`;
  if (state.seen[key]) return;
  log("claim", repo, "issue", issue.number, issue.title);

  const body = [
    `GitHub issue #${issue.number}: ${issue.title}`,
    issue.body || "",
    "",
    "You were mentioned with " + mention + ". Investigate and implement a fix.",
    "Open a PR if appropriate. Use labwired verify when firmware is involved.",
  ].join("\n");

  const cwd = process.cwd();
  const code = runAgent(cwd, body);
  state.seen[key] = { at: Date.now(), code };
  // prune
  const keys = Object.keys(state.seen);
  if (keys.length > 200) {
    for (const k of keys.slice(0, keys.length - 200)) delete state.seen[k];
  }
  saveState(state);

  // comment back if token allows
  if (!dry && token) {
    try {
      await fetch(
        `https://api.github.com/repos/${repo}/issues/${issue.number}/comments`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "labwired-daemon",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            body: `🤖 LabWired daemon finished (exit ${code}). Check the machine logs / open PR if created.`,
          }),
        }
      );
    } catch (e) {
      log("comment failed", e.message);
    }
  }
}

async function tick() {
  const repo = detectRepo();
  if (!repo) {
    log("no repo — set LABWIRED_GITHUB_REPO=owner/name");
    return;
  }
  if (!token) {
    log("no GITHUB_TOKEN — daemon idle");
    return;
  }
  log("poll", repo, "mention", mention);
  const items = await findMentions(repo);
  for (const it of items) {
    await handleIssue(repo, it);
  }
}

async function main() {
  log("LabWired GitHub daemon start", {
    mention,
    pollMs,
    dry,
    repo: detectRepo(),
  });
  await tick();
  setInterval(() => {
    void tick().catch((e) => log("tick error", e));
  }, pollMs);
}

main().catch((e) => {
  log("fatal", e);
  process.exit(1);
});
