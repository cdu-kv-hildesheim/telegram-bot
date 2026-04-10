export interface Env {
  // GitHub App credentials (shared across all sites on this worker)
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_INSTALLATION_ID: string;
  // Webhook secret: shared for the Telegram setWebhook secret_token,
  // the GitHub-App webhook HMAC signature and the workflow callback
  // Authorization header.
  WEBHOOK_SECRET: string;
  // OpenAI API key — only used for Whisper voice transcription.
  OPENAI_API_KEY: string;
  // KV namespace for authorized users, pending join requests,
  // thread/issue mappings and media-group buffering.
  USERS: KVNamespace;
  // Telegram bot tokens. Name them whatever you like in the Cloudflare
  // dashboard (e.g. TELEGRAM_TOKEN, TELEGRAM_TOKEN_BAR) and reference
  // the name in `SiteConfig.tokenKey`.
  [key: string]: string | KVNamespace;
}

export const GITHUB_API = "https://api.github.com";

export interface SiteConfig {
  /** Stable identifier used in URL paths, KV keys and issue labels. */
  id: string;
  /** Human-readable name shown in Telegram messages. */
  name: string;
  /** Public domain of the managed site (e.g. example.com). */
  domain: string;
  /** npm workspace name — used by the GitHub Actions workflow to build. */
  workspace: string;
  /** Path to the content directory inside the GitHub repo. */
  contentDir: string;
  /** Login of the GitHub App installation that posts as this bot. */
  botUsername: string;
  /**
   * Name of the Cloudflare environment variable that holds the Telegram
   * bot token for this site. The variable must be set in the CF dashboard.
   */
  tokenKey: string;
}

export interface TelegramChatLabel {
  name: string;
}

/** Resolve a site from a SITES map by id, throw if unknown. */
export function getSiteFromMap(
  sites: Record<string, SiteConfig>,
  siteId: string,
): SiteConfig {
  const site = sites[siteId];
  if (!site) {
    throw new Error(
      `Unknown site: ${siteId}. Expected one of: ${Object.keys(sites).join(", ")}`,
    );
  }
  return site;
}

/** Find a site by reading a `site:{id}` label from a list of issue labels. */
export function siteFromLabelsInMap(
  sites: Record<string, SiteConfig>,
  labels: TelegramChatLabel[] | undefined,
): SiteConfig | null {
  if (!labels) return null;
  for (const label of labels) {
    const match = label.name.match(/^site:(.+)$/);
    if (match && sites[match[1]]) return sites[match[1]];
  }
  return null;
}

/**
 * Check whether a GitHub user login belongs to one of our own bots.
 *
 * Used to skip the bot's own issue comments when relaying Claude replies
 * back to Telegram — otherwise the bot forwards its own "please implement"
 * instructions to the user as if Claude had written them. The check
 * matches against ALL SITES' botUsername values, so it still works when
 * several sites share a single GitHub App installation.
 */
export function isOwnBotLoginInMap(
  sites: Record<string, SiteConfig>,
  login: string | undefined,
): boolean {
  if (!login) return false;
  for (const site of Object.values(sites)) {
    if (site.botUsername === login) return true;
  }
  return false;
}

/**
 * Should the pull_request.opened webhook fire its own Telegram notification?
 *
 * No, if the PR is linked to an issue that came from the Telegram workflow
 * (label `telegram`). In that case the workflow callback already sends a
 * notification with preview links, which is far more useful for board
 * members without a GitHub account than a bare PR link.
 */
export function shouldNotifyOnPrOpened(
  linkedIssueLabels: TelegramChatLabel[] | undefined,
): boolean {
  if (!linkedIssueLabels) return true;
  return !linkedIssueLabels.some((l) => l.name === "telegram");
}

/**
 * What should happen with a message that arrives inside a thread?
 * Pure function over the two KV lookups a handler does first — so the
 * decision is easy to unit-test.
 */
export type ThreadAction =
  | { kind: "reply"; issueNumber: number }
  | { kind: "newTask"; thema: string }
  | { kind: "unknownThread" };

export function decideThreadAction(
  issueNumber: number | null,
  pendingThema: string | null,
): ThreadAction {
  if (issueNumber !== null) return { kind: "reply", issueNumber };
  if (pendingThema !== null) return { kind: "newTask", thema: pendingThema };
  return { kind: "unknownThread" };
}

/** Read the Telegram bot token for a given site from the Env. */
export function getTelegramToken(env: Env, site: SiteConfig): string {
  const value = env[site.tokenKey];
  if (typeof value !== "string") {
    throw new Error(
      `Missing Telegram token: env.${site.tokenKey} is not set for site ${site.id}`,
    );
  }
  return value;
}

/**
 * Check whether a Telegram message contains user content (text, caption,
 * voice, audio, photo or document). Service messages like
 * `forum_topic_created` or `new_chat_members` have none of these and should
 * be silently ignored by the bot.
 */
export function hasUserContent(
  // biome-ignore lint/suspicious/noExplicitAny: raw Telegram message
  message: any,
): boolean {
  return Boolean(
    message.text ||
      message.caption ||
      message.voice ||
      message.audio ||
      message.photo ||
      message.document,
  );
}

/**
 * Parse a `/new_task THEMA` command and return the thema. Supports the
 * `/new_task@botname THEMA` variant. Returns `null` if no thema is given.
 */
export function parseNewTaskCommand(text: string | undefined): string | null {
  if (!text) return null;
  const match = text.match(/^\/new_task(?:@\S+)?(?:\s+(.+))?$/s);
  if (!match) return null;
  const thema = match[1]?.trim();
  if (!thema) return null;
  return thema;
}

// KV key helpers. Keys are scoped by site so users authorized for one
// site are not automatically allowed on another.

export function userKey(siteId: string, userId: number): string {
  return `user:${siteId}:${userId}`;
}

export function pendingKey(siteId: string, userId: number): string {
  return `pending:${siteId}:${userId}`;
}

export function userListPrefix(siteId: string): string {
  return `user:${siteId}:`;
}

// Types exchanged with the GitHub webhook.

export interface GitHubWebhookEvent {
  action: string;
  issue?: GitHubIssue;
  comment?: GitHubComment;
  pull_request?: GitHubPullRequest;
  sender: { login: string; type: string };
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: { name: string }[];
  pull_request?: { url: string };
}

export interface GitHubComment {
  id: number;
  body: string;
  user: { login: string; type: string };
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  html_url: string;
  body: string;
  state: string;
}
