/**
 * Pro billing status for the agent tool runner.
 */
import * as vscode from "vscode";

export type BillingStatus = {
  signedIn: boolean;
  plan?: string;
  email?: string;
  message: string;
};

export class BillingService {
  async status(): Promise<BillingStatus> {
    const project = vscode.workspace
      .getConfiguration("labwired")
      .get<string>("project");
    return {
      signedIn: false,
      message: project
        ? `Project setting: ${project}. Run LabWired: Log in (Pro) for live billing.`
        : "Not signed in. Run LabWired: Log in (Pro) or labwired login for hosted tools.",
    };
  }

  formatStatus(s: BillingStatus): string {
    return [
      "LabWired billing",
      `signedIn: ${s.signedIn}`,
      s.plan ? `plan: ${s.plan}` : undefined,
      s.email ? `email: ${s.email}` : undefined,
      s.message,
      "App: https://app.labwired.com",
    ]
      .filter(Boolean)
      .join("\n");
  }
}
