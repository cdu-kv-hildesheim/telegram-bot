import {
  type GitHubIssue,
  getSiteFromMap,
  isOwnBotLoginInMap,
  type SiteConfig,
  siteFromLabelsInMap,
  type TelegramChatLabel,
} from "./types";

// ─── EDIT THIS FILE WHEN ADOPTING THIS BOT ────────────────────
//
// Three things need to change per project:
//   1. ADMIN_ID    — the Telegram user ID of the super-admin
//   2. GITHUB_REPO — "owner/repo" of the content repo the bot writes to
//   3. SITES       — one entry per site/bot you want to manage
//
// Everything else in this repo is generic and should not need changes.

/** Telegram user ID that is always authorized on every bot. */
export const ADMIN_ID = 0;

/** GitHub repo where issues/PRs are created, e.g. "acme/website". */
export const GITHUB_REPO = "owner/repo";

/**
 * One entry per Telegram bot. A single Cloudflare Worker can serve
 * multiple bots — they are distinguished by the webhook path
 * `/webhook/{siteId}` and each has its own token in the Cloudflare
 * dashboard (named via `tokenKey`).
 */
export const SITES: Record<string, SiteConfig> = {
  example: {
    id: "example",
    name: "Example Site",
    domain: "example.com",
    workspace: "website",
    contentDir: "src/content",
    botUsername: "example-telegram-bot[bot]",
    tokenKey: "TELEGRAM_TOKEN",
  },
};

// ─── END USER CONFIG ──────────────────────────────────────────

/** Resolve a site by id using the project's SITES map. */
export const getSite = (siteId: string): SiteConfig =>
  getSiteFromMap(SITES, siteId);

/** Find a site by reading a `site:{id}` label from an issue. */
export const siteFromLabels = (
  labels: TelegramChatLabel[] | undefined,
): SiteConfig | null => siteFromLabelsInMap(SITES, labels);

/**
 * Check whether a GitHub login belongs to one of our own bots by
 * matching against every site's botUsername. Robust against several
 * sites sharing a single GitHub App installation.
 */
export const isOwnBotLogin = (login: string | undefined): boolean =>
  isOwnBotLoginInMap(SITES, login);

/**
 * Build the canonical issue body marker for a chat id + site.
 * Keeps the site id in the comment so cross-site PRs can be routed back
 * to the right bot.
 */
export function embedChatId(chatId: number, siteId: string): string {
  return `<!-- telegram:chat_id=${chatId} site=${siteId} -->`;
}

export function extractChatId(body: string): number | null {
  const match = body.match(/<!-- telegram:chat_id=(\d+)(?: site=[^ ]+)? -->/);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function extractSiteId(body: string): string | null {
  const match = body.match(/<!-- telegram:chat_id=\d+ site=([^ ]+) -->/);
  return match ? match[1] : null;
}

/** Re-export so consumers only need to import from config. */
export type { GitHubIssue };
