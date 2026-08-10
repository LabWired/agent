/**
 * Pro billing / account surface.
 * Primary path = same as CLI: `labwired login` → ~/.labwired/session/cloud.json.
 * Also supports RPC auth/* and secret-storage token paste.
 */
import * as vscode from "vscode";
import { loadCloudSession } from "../cli/cloudSession";
import type { LabWiredBridge } from "../cli/bridge";
import type { RpcClient } from "../cli/rpcClient";

export type BillingStatus = {
  loggedIn: boolean;
  email?: string;
  plan: "free" | "pro" | "enterprise" | "unknown";
  seats?: number;
  projectId?: string;
  projectName?: string;
  usageNote?: string;
  raw?: unknown;
};

const SECRET_KEY = "labwired.authToken";

export class BillingService {
  private rpc?: RpcClient;
  private bridge?: LabWiredBridge;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  setRpc(rpc: RpcClient | undefined) {
    this.rpc = rpc;
  }

  setBridge(bridge: LabWiredBridge | undefined) {
    this.bridge = bridge;
  }

  appUrl(path = ""): string {
    const base = (
      vscode.workspace.getConfiguration("labwired").get<string>("appUrl") ||
      "https://app.labwired.com"
    ).replace(/\/$/, "");
    return path ? `${base}/${path.replace(/^\//, "")}` : base;
  }

  async getToken(): Promise<string | undefined> {
    return this.ctx.secrets.get(SECRET_KEY);
  }

  async setToken(token: string | undefined): Promise<void> {
    if (!token) await this.ctx.secrets.delete(SECRET_KEY);
    else await this.ctx.secrets.store(SECRET_KEY, token);
  }

  async loginInteractive(): Promise<void> {
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: "$(terminal) labwired login (CLI — same as terminal)",
          description:
            "Device-code → ~/.labwired/session/cloud.json → hosted MCP + model gateway",
          id: "cli",
        },
        {
          label: "Device code (RPC server)",
          description: "auth/startDeviceCode when labwired --server is running",
          id: "device",
        },
        {
          label: "Paste API token",
          description: "auth/loginWithToken + SecretStorage",
          id: "token",
        },
        {
          label: "Open browser login",
          description: this.appUrl("login"),
          id: "browser",
        },
        {
          label: "Dev Pro (local mock)",
          description: "Instant local Pro without cloud",
          id: "dev",
        },
        { label: "Continue as free (local)", id: "free" },
      ],
      { title: "LabWired login — same session as CLI" }
    );
    if (!choice) return;

    if (choice.id === "cli") {
      if (this.bridge) {
        await this.bridge.startLoginTerminal();
      } else {
        const term = vscode.window.createTerminal("LabWired Login");
        term.show(true);
        term.sendText("labwired login");
      }
      void vscode.window.showInformationMessage(
        "Complete device login in the terminal. Then Start Agent — same hosted tools as CLI."
      );
      return;
    }

    if (choice.id === "free") {
      await this.setToken(undefined);
      if (this.rpc?.isRunning()) {
        try {
          await this.rpc.request("auth/logout", {});
        } catch {
          /* */
        }
      }
      void vscode.window.showInformationMessage("Using free local agent");
      return;
    }

    if (choice.id === "dev") {
      const token = `dev_${Date.now().toString(36)}`;
      await this.setToken(token);
      if (this.rpc?.isRunning()) {
        await this.rpc.request("auth/loginWithToken", {
          token,
          email: "example@example.com",
          plan: "pro",
        });
        await this.ensureProject();
      }
      void vscode.window.showInformationMessage("Local Pro active (dev token)");
      return;
    }

    if (choice.id === "device" && this.rpc?.isRunning()) {
      const started = (await this.rpc.request("auth/startDeviceCode", {})) as {
        userCode?: string;
        deviceCode?: string;
        verificationUri?: string;
        autoCompleted?: boolean;
        message?: string;
      };
      if (started.autoCompleted) {
        void vscode.window.showInformationMessage(started.message || "Pro login OK");
        await this.ensureProject();
        return;
      }
      const uri = started.verificationUri || this.appUrl("device");
      const code = started.userCode || "——";
      const open = await vscode.window.showInformationMessage(
        `LabWired device code: ${code}\nOpen ${uri} then paste a token (cloud) or use Paste API token.`,
        "Open browser",
        "Paste token now"
      );
      if (open === "Open browser") {
        await vscode.env.openExternal(vscode.Uri.parse(uri));
      }
      const token = await vscode.window.showInputBox({
        prompt: `Complete device ${code} — paste Pro token (or any string for local Pro mock)`,
        password: true,
        ignoreFocusOut: true,
      });
      if (token) {
        await this.setToken(token.trim());
        await this.rpc.request("auth/completeDeviceCode", {
          token: token.trim(),
          email: "example@example.com",
          plan: "pro",
        });
        await this.ensureProject();
        void vscode.window.showInformationMessage("Pro login complete");
      }
      return;
    }

    if (choice.id === "browser") {
      await vscode.env.openExternal(vscode.Uri.parse(this.appUrl("login")));
      const token = await vscode.window.showInputBox({
        prompt: "Paste token from app after login",
        password: true,
        ignoreFocusOut: true,
      });
      if (token) {
        await this.setToken(token.trim());
        if (this.rpc?.isRunning()) {
          await this.rpc.request("auth/loginWithToken", {
            token: token.trim(),
            plan: "pro",
          });
          await this.ensureProject();
        }
      }
      return;
    }

    if (choice.id === "token") {
      const token = await vscode.window.showInputBox({
        prompt: "LabWired API token",
        password: true,
        ignoreFocusOut: true,
      });
      if (token) {
        await this.setToken(token.trim());
        if (this.rpc?.isRunning()) {
          await this.rpc.request("auth/loginWithToken", {
            token: token.trim(),
            plan: "pro",
          });
          await this.ensureProject();
        }
        void vscode.window.showInformationMessage("Token saved");
      }
    }
  }

  async ensureProject(): Promise<void> {
    if (!this.rpc?.isRunning()) return;
    try {
      const list = (await this.rpc.request("project/list", {})) as {
        projects?: { id: string; name: string }[];
      };
      const projects = list.projects || [];
      if (!projects.length) {
        await this.rpc.request("project/create", { name: "Default project" });
        return;
      }
      const pick = await vscode.window.showQuickPick(
        [
          ...projects.map((p) => ({
            label: p.name,
            description: p.id,
            id: p.id,
            name: p.name,
          })),
          { label: "$(add) Create project…", id: "__new", name: "" },
        ],
        { title: "Select Pro project (required for hosted model)" }
      );
      if (!pick) return;
      if (pick.id === "__new") {
        const name =
          (await vscode.window.showInputBox({ prompt: "Project name" })) ||
          "New project";
        await this.rpc.request("project/create", { name });
      } else {
        await this.rpc.request("project/select", {
          projectId: pick.id,
          name: pick.name || pick.label,
        });
      }
    } catch (e) {
      void vscode.window.showWarningMessage(`Project select: ${e}`);
    }
  }

  async selectProjectInteractive(): Promise<void> {
    if (!this.rpc?.isRunning()) {
      void vscode.window.showWarningMessage("Start labwired server first");
      return;
    }
    await this.ensureProject();
  }

  async logout(): Promise<void> {
    await this.setToken(undefined);
    if (this.rpc?.isRunning()) {
      try {
        await this.rpc.request("auth/logout", {});
      } catch {
        /* */
      }
    }
    void vscode.window.showInformationMessage("Logged out");
  }

  async status(): Promise<BillingStatus> {
    // Prefer CLI cloud session (same path as OpenCode hosted)
    const cloud = loadCloudSession();
    if (cloud) {
      return {
        loggedIn: true,
        email: cloud.email,
        plan: "pro",
        projectId: cloud.projectId,
        projectName: cloud.projectId,
        usageNote: `CLI session · ${cloud.path} · MCP ${cloud.apiBase}/mcp · model ${cloud.modelUrl}`,
        raw: { source: "cloud.json", email: cloud.email },
      };
    }

    if (this.rpc?.isRunning()) {
      try {
        const a = (await this.rpc.request("auth/status", {})) as {
          loggedIn?: boolean;
          email?: string;
          plan?: string;
          project?: { id?: string; name?: string };
        };
        const ent = (await this.rpc.request("entitlement/status", {})) as {
          pro?: boolean;
          features?: string[];
          limits?: { hostedModel?: boolean };
        };
        if (a.loggedIn) {
          return {
            loggedIn: true,
            email: a.email,
            plan: (a.plan as BillingStatus["plan"]) || "pro",
            projectId: a.project?.id,
            projectName: a.project?.name,
            usageNote: ent.pro
              ? `Pro · project ${a.project?.name || a.project?.id || "(none)"} · hostedModel=${!!ent.limits?.hostedModel}`
              : "Logged in",
            raw: { a, ent },
          };
        }
      } catch {
        /* fall through */
      }
    }

    const token = await this.getToken();
    if (!token) {
      return {
        loggedIn: false,
        plan: "free",
        usageNote:
          "Not signed in · LabWired: Log in (or labwired login) for hosted MCP + model",
      };
    }
    try {
      const res = await fetch(this.appUrl("api/v1/me"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        return {
          loggedIn: true,
          plan: "pro",
          usageNote: `Token stored (API ${res.status}) — using local Pro path`,
        };
      }
      const j = (await res.json()) as {
        email?: string;
        plan?: string;
        seats?: number;
        usage?: string;
      };
      return {
        loggedIn: true,
        email: j.email,
        plan: (j.plan as BillingStatus["plan"]) || "pro",
        seats: j.seats,
        usageNote: j.usage || "Pro active",
        raw: j,
      };
    } catch {
      return {
        loggedIn: true,
        plan: "pro",
        usageNote: "Token present (offline local Pro)",
      };
    }
  }

  async openBilling(): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(this.appUrl("billing")));
  }

  formatStatus(s: BillingStatus): string {
    return [
      "# LabWired account",
      "",
      `- loggedIn: **${s.loggedIn}**`,
      `- plan: **${s.plan}**`,
      s.email ? `- email: ${s.email}` : "",
      s.projectId
        ? `- project: ${s.projectName || s.projectId} (\`${s.projectId}\`)`
        : "",
      s.usageNote ? `- note: ${s.usageNote}` : "",
      "",
      "## Start-here (same as CLI)",
      "1. LabWired: Log in → `labwired login`",
      "2. LabWired: Run Doctor",
      "3. LabWired: Start Agent (Terminal) → OpenCode + golden-path + MCP",
      "4. Chat: *Blink the LED and prove it on the twin.*",
      "",
      "Session file: `~/.labwired/session/cloud.json`",
    ]
      .filter(Boolean)
      .join("\n");
  }
}
