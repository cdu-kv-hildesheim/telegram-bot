import { GITHUB_REPO } from "./config";
import { type Env, GITHUB_API, type GitHubIssue } from "./types";

// ─── JWT + Installation Token ─────────────────────────────────

async function createAppJwt(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 600, iss: env.GITHUB_APP_ID };

  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importPrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64url(signature)}`;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemBody = pem
    .replace(/-----BEGIN.*?-----/g, "")
    .replace(/-----END.*?-----/g, "")
    .replace(/\s/g, "");

  const pkcs1Der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const pkcs8Header = new Uint8Array([
    0x30, 0x82, 0x00, 0x00, 0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a,
    0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00, 0x04, 0x82,
    0x00, 0x00,
  ]);

  const pkcs8 = new Uint8Array(pkcs8Header.length + pkcs1Der.length);
  pkcs8.set(pkcs8Header);
  pkcs8.set(pkcs1Der, pkcs8Header.length);

  const totalLen = pkcs8.length - 4;
  pkcs8[2] = (totalLen >> 8) & 0xff;
  pkcs8[3] = totalLen & 0xff;
  pkcs8[24] = (pkcs1Der.length >> 8) & 0xff;
  pkcs8[25] = pkcs1Der.length & 0xff;

  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getToken(env: Env): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now) return tokenCache.token;

  const jwt = await createAppJwt(env);
  const response = await fetch(
    `${GITHUB_API}/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${jwt}`,
        "User-Agent": "telegram-bot",
      },
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub token error: ${response.status} – ${error}`);
  }

  const result = (await response.json()) as {
    token: string;
    expires_at: string;
  };
  tokenCache = {
    token: result.token,
    expiresAt: new Date(result.expires_at).getTime() - 10 * 60 * 1000,
  };
  return result.token;
}

async function ghApi(
  env: Env,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const token = await getToken(env);
  const response = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github.v3+json",
      Authorization: `token ${token}`,
      "User-Agent": "telegram-bot",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `GitHub API ${method} ${path}: ${response.status} – ${error}`,
    );
  }

  if (response.status === 204) return {};
  return (await response.json()) as Record<string, unknown>;
}

// ─── Issue + PR operations ────────────────────────────────────

export async function createIssue(
  env: Env,
  siteId: string,
  title: string,
  body: string,
): Promise<number> {
  const result = await ghApi(env, "POST", `/repos/${GITHUB_REPO}/issues`, {
    title,
    body,
    labels: ["telegram", `site:${siteId}`],
  });
  return result.number as number;
}

export async function commentOnIssue(
  env: Env,
  issueNumber: number,
  body: string,
): Promise<void> {
  await ghApi(
    env,
    "POST",
    `/repos/${GITHUB_REPO}/issues/${issueNumber}/comments`,
    { body },
  );
}

export async function triggerDispatch(
  env: Env,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await ghApi(env, "POST", `/repos/${GITHUB_REPO}/dispatches`, {
    event_type: eventType,
    client_payload: payload,
  });
}

export async function reactToComment(
  env: Env,
  commentId: number,
  reaction: string,
): Promise<void> {
  await ghApi(
    env,
    "POST",
    `/repos/${GITHUB_REPO}/issues/comments/${commentId}/reactions`,
    { content: reaction },
  );
}

export async function closeIssue(env: Env, issueNumber: number): Promise<void> {
  await ghApi(env, "PATCH", `/repos/${GITHUB_REPO}/issues/${issueNumber}`, {
    state: "closed",
  });
}

export async function getIssue(
  env: Env,
  issueNumber: number,
): Promise<GitHubIssue> {
  return (await ghApi(
    env,
    "GET",
    `/repos/${GITHUB_REPO}/issues/${issueNumber}`,
  )) as unknown as GitHubIssue;
}

export async function mergePullRequest(
  env: Env,
  prNumber: number,
): Promise<void> {
  await ghApi(env, "PUT", `/repos/${GITHUB_REPO}/pulls/${prNumber}/merge`, {
    merge_method: "squash",
  });
}

export async function closePullRequest(
  env: Env,
  prNumber: number,
): Promise<void> {
  await ghApi(env, "PATCH", `/repos/${GITHUB_REPO}/pulls/${prNumber}`, {
    state: "closed",
  });
}

// ─── Webhook verification ─────────────────────────────────────

export async function verifyGitHubWebhook(
  secret: string,
  signature: string,
  body: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  const expected = `sha256=${Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
  return expected === signature;
}

function base64url(input: string | ArrayBuffer): string {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : new Uint8Array(input);

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
