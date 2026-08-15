export const HOSTED_PUBLIC_MODEL = "labwired-default";

export function isTrustedHostedModelUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "api.labwired.com" &&
      url.port === "" &&
      (url.pathname === "/v1" || url.pathname === "/v1/") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export function resolveModelForUrl(modelUrl: string, configuredModel: string): string {
  return isTrustedHostedModelUrl(modelUrl) ? HOSTED_PUBLIC_MODEL : configuredModel;
}

export function pinHostedModelEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!isTrustedHostedModelUrl(env.LABWIRED_MODEL_URL)) return env;
  return { ...env, LABWIRED_MODEL: HOSTED_PUBLIC_MODEL };
}

export function buildChatCompletionBody(
  modelUrl: string,
  configuredModel: string,
  system: string,
  prompt: string
) {
  return {
    model: resolveModelForUrl(modelUrl, configuredModel),
    stream: true,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
  };
}
