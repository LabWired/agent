/**
 * Cloud control-plane client for Pro auth/projects (G1).
 *
 * Enabled when LABWIRED_CLOUD_AUTH=1 (or LABWIRED_API_URL set and not LABWIRED_CLOUD_AUTH=0).
 * Base: LABWIRED_API_URL (default https://api.labwired.com) — no /v1 suffix required.
 */
const DEFAULT_API = "https://api.labwired.com";

export function cloudAuthEnabled() {
  if (process.env.LABWIRED_CLOUD_AUTH === "0") return false;
  if (process.env.LABWIRED_CLOUD_AUTH === "1") return true;
  // Prefer cloud when API URL is explicitly set and not local stub-only
  if (process.env.LABWIRED_API_URL) return true;
  return false;
}

export function apiBase() {
  return (
    process.env.LABWIRED_API_URL ||
    process.env.LABWIRED_CLOUD_API_URL ||
    DEFAULT_API
  ).replace(/\/$/, "");
}

async function api(method, path, { body, token, headers } = {}) {
  const h = {
    Accept: "application/json",
    ...(headers || {}),
  };
  if (body != null) h["Content-Type"] = "application/json";
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: h,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

/** POST /v1/auth/device/code */
export async function cloudStartDeviceCode() {
  const r = await api("POST", "/v1/auth/device/code", { body: {} });
  if (!r.ok) {
    const err = new Error(
      r.data?.error?.message || `device/code failed (${r.status})`
    );
    err.code = -32003;
    err.data = r.data;
    throw err;
  }
  return {
    deviceCode: r.data.deviceCode,
    userCode: r.data.userCode,
    verificationUri: r.data.verificationUri,
    verificationUriComplete: r.data.verificationUriComplete,
    expiresIn: r.data.expiresIn ?? 900,
    interval: r.data.interval ?? 2,
  };
}

/**
 * Poll until approved or pending/expired.
 * @returns {{ status: 'pending'|'approved'|'expired'|'denied', tokens?: object, error?: string }}
 */
export async function cloudPollDeviceToken(deviceCode) {
  const r = await api("POST", "/v1/auth/device/token", {
    body: {
      deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
  });
  if (r.data?.error === "authorization_pending") {
    return { status: "pending" };
  }
  if (r.status === 400 && r.data?.error?.code === "expired_token") {
    return { status: "expired" };
  }
  if (r.status === 400 && r.data?.error?.code === "access_denied") {
    return { status: "denied" };
  }
  if (r.ok && r.data?.access_token) {
    return {
      status: "approved",
      tokens: {
        access_token: r.data.access_token,
        refresh_token: r.data.refresh_token,
        expires_in: r.data.expires_in,
        email: r.data.email,
        plan: r.data.plan || "pro",
      },
    };
  }
  return {
    status: "error",
    error: r.data?.error?.message || r.data?.error || `poll ${r.status}`,
  };
}

export async function cloudMe(accessToken) {
  const r = await api("GET", "/v1/auth/me", { token: accessToken });
  if (!r.ok) return null;
  return r.data;
}

export async function cloudRevoke(accessToken, refreshToken) {
  try {
    await api("POST", "/v1/auth/revoke", {
      token: accessToken,
      body: refreshToken ? { refresh_token: refreshToken } : {},
    });
  } catch {
    /* best effort */
  }
}

export async function cloudListProjects(accessToken) {
  const r = await api("GET", "/v1/projects", { token: accessToken });
  if (!r.ok) {
    const err = new Error(
      r.data?.error?.message || `projects list failed (${r.status})`
    );
    err.code = -32003;
    throw err;
  }
  return r.data.projects || [];
}

export async function cloudCreateProject(accessToken, { name, description }) {
  const r = await api("POST", "/v1/projects", {
    token: accessToken,
    body: { name, description },
  });
  if (!r.ok) {
    const err = new Error(
      r.data?.error?.message || `project create failed (${r.status})`
    );
    err.code = -32003;
    throw err;
  }
  return r.data.project;
}

export async function cloudEntitlement(accessToken) {
  const r = await api("GET", "/v1/entitlement", { token: accessToken });
  if (!r.ok) return null;
  return r.data;
}

export async function cloudRefresh(refreshToken) {
  const r = await api("POST", "/v1/auth/refresh", {
    body: { refresh_token: refreshToken },
  });
  if (!r.ok || !r.data?.access_token) return null;
  return {
    access_token: r.data.access_token,
    refresh_token: r.data.refresh_token,
    expires_in: r.data.expires_in,
    email: r.data.email,
    plan: r.data.plan || "pro",
  };
}
