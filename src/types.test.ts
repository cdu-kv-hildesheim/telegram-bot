import { describe, expect, it } from "vitest";
import {
  decideThreadAction,
  type Env,
  getSiteFromMap,
  getTelegramToken,
  hasUserContent,
  isOwnBotLoginInMap,
  parseNewTaskCommand,
  pendingKey,
  type SiteConfig,
  shouldNotifyOnPrOpened,
  siteFromLabelsInMap,
  userKey,
  userListPrefix,
} from "./types";

const fixtureSites: Record<string, SiteConfig> = {
  foo: {
    id: "foo",
    name: "Foo Site",
    domain: "foo.example",
    workspace: "foo",
    contentDir: "websites/foo",
    botUsername: "foo-bot[bot]",
    tokenKey: "TELEGRAM_TOKEN_FOO",
  },
  bar: {
    id: "bar",
    name: "Bar Site",
    domain: "bar.example",
    workspace: "bar",
    contentDir: "websites/bar",
    botUsername: "bar-bot[bot]",
    tokenKey: "TELEGRAM_TOKEN_BAR",
  },
};

describe("getSiteFromMap", () => {
  it("returns the matching SiteConfig", () => {
    expect(getSiteFromMap(fixtureSites, "foo")).toBe(fixtureSites.foo);
    expect(getSiteFromMap(fixtureSites, "bar")).toBe(fixtureSites.bar);
  });

  it("throws with a helpful message listing valid sites for unknown ids", () => {
    expect(() => getSiteFromMap(fixtureSites, "baz")).toThrowError(
      /Unknown site: baz/,
    );
    expect(() => getSiteFromMap(fixtureSites, "baz")).toThrowError(/foo/);
    expect(() => getSiteFromMap(fixtureSites, "baz")).toThrowError(/bar/);
  });
});

describe("siteFromLabelsInMap", () => {
  it("returns the site matching a site:{id} label", () => {
    expect(
      siteFromLabelsInMap(fixtureSites, [
        { name: "telegram" },
        { name: "site:foo" },
      ]),
    ).toBe(fixtureSites.foo);
    expect(siteFromLabelsInMap(fixtureSites, [{ name: "site:bar" }])).toBe(
      fixtureSites.bar,
    );
  });

  it("returns null when no site: label is present", () => {
    expect(
      siteFromLabelsInMap(fixtureSites, [{ name: "telegram" }]),
    ).toBeNull();
  });

  it("returns null when the site: label references an unknown site", () => {
    expect(
      siteFromLabelsInMap(fixtureSites, [{ name: "site:nonsense" }]),
    ).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(siteFromLabelsInMap(fixtureSites, undefined)).toBeNull();
  });
});

describe("getTelegramToken", () => {
  const env = {
    GITHUB_APP_ID: "app-id",
    GITHUB_APP_PRIVATE_KEY: "pk",
    GITHUB_APP_INSTALLATION_ID: "inst",
    WEBHOOK_SECRET: "secret",
    OPENAI_API_KEY: "openai",
    USERS: {} as KVNamespace,
    TELEGRAM_TOKEN_FOO: "foo-token",
    TELEGRAM_TOKEN_BAR: "bar-token",
  } as unknown as Env;

  it("reads the env variable named by site.tokenKey", () => {
    expect(getTelegramToken(env, fixtureSites.foo)).toBe("foo-token");
    expect(getTelegramToken(env, fixtureSites.bar)).toBe("bar-token");
  });

  it("throws when the configured env variable is missing", () => {
    const siteWithMissing: SiteConfig = {
      ...fixtureSites.foo,
      tokenKey: "TELEGRAM_TOKEN_DOES_NOT_EXIST",
    };
    expect(() => getTelegramToken(env, siteWithMissing)).toThrowError(
      /Missing Telegram token/,
    );
  });
});

describe("hasUserContent", () => {
  it("returns true for a text message", () => {
    expect(hasUserContent({ text: "hi" })).toBe(true);
  });

  it("returns true for a caption", () => {
    expect(hasUserContent({ caption: "a photo caption" })).toBe(true);
  });

  it("returns true for a voice message", () => {
    expect(hasUserContent({ voice: { file_id: "x" } })).toBe(true);
  });

  it("returns true for an audio file", () => {
    expect(hasUserContent({ audio: { file_id: "x" } })).toBe(true);
  });

  it("returns true for photos", () => {
    expect(hasUserContent({ photo: [{ file_id: "x" }] })).toBe(true);
  });

  it("returns true for documents", () => {
    expect(hasUserContent({ document: { file_id: "x" } })).toBe(true);
  });

  it("returns false for a forum_topic_created service message", () => {
    const serviceMessage = {
      message_id: 1,
      chat: { id: 1, type: "private" },
      from: { id: 1, first_name: "x" },
      forum_topic_created: { name: "Neuer Auftrag", icon_color: 0 },
    };
    expect(hasUserContent(serviceMessage)).toBe(false);
  });

  it("returns false for a bare message object without any content", () => {
    expect(hasUserContent({})).toBe(false);
  });
});

describe("parseNewTaskCommand", () => {
  it("returns the thema for /new_task THEMA", () => {
    expect(parseNewTaskCommand("/new_task Stammtisch am 25.4.")).toBe(
      "Stammtisch am 25.4.",
    );
  });

  it("trims leading and trailing whitespace from the thema", () => {
    expect(parseNewTaskCommand("/new_task   Termin eintragen   ")).toBe(
      "Termin eintragen",
    );
  });

  it("supports /new_task@botname syntax", () => {
    expect(parseNewTaskCommand("/new_task@example_bot Neuer Flyer")).toBe(
      "Neuer Flyer",
    );
  });

  it("returns null when the command has no argument", () => {
    expect(parseNewTaskCommand("/new_task")).toBeNull();
  });

  it("returns null when the command has only whitespace", () => {
    expect(parseNewTaskCommand("/new_task    ")).toBeNull();
  });

  it("returns null for an unrelated message", () => {
    expect(parseNewTaskCommand("Stammtisch am 25.4.")).toBeNull();
  });

  it("returns null for a different command", () => {
    expect(parseNewTaskCommand("/start")).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parseNewTaskCommand(undefined)).toBeNull();
  });

  it("handles multi-line themas by keeping the full body", () => {
    expect(parseNewTaskCommand("/new_task Titel\nZusatzinfo")).toBe(
      "Titel\nZusatzinfo",
    );
  });
});

describe("shouldNotifyOnPrOpened", () => {
  it("returns false when the linked issue has the telegram label (callback handles it)", () => {
    expect(
      shouldNotifyOnPrOpened([{ name: "telegram" }, { name: "site:foo" }]),
    ).toBe(false);
  });

  it("returns true for normal PRs not from the telegram workflow", () => {
    expect(shouldNotifyOnPrOpened([{ name: "bug" }])).toBe(true);
  });

  it("returns true when there are no labels at all", () => {
    expect(shouldNotifyOnPrOpened([])).toBe(true);
  });

  it("returns true when labels are undefined (PR has no linked issue)", () => {
    expect(shouldNotifyOnPrOpened(undefined)).toBe(true);
  });

  it("REGRESSION: telegram label causes skip even with other labels around", () => {
    // This is the actual symptom: users got two notifications because
    // handlePullRequestOpened fired alongside the workflow callback.
    expect(
      shouldNotifyOnPrOpened([
        { name: "site:foo" },
        { name: "telegram" },
        { name: "enhancement" },
      ]),
    ).toBe(false);
  });
});

describe("isOwnBotLoginInMap", () => {
  it("returns true for a login matching site.botUsername", () => {
    expect(isOwnBotLoginInMap(fixtureSites, "foo-bot[bot]")).toBe(true);
    expect(isOwnBotLoginInMap(fixtureSites, "bar-bot[bot]")).toBe(true);
  });

  it("REGRESSION: matches across all SITES so a shared GitHub App is recognised as own bot for every site", () => {
    // Several sites may share a single GitHub App installation, so the
    // filter must recognise that login for any site, otherwise the bot's
    // own 'please implement' comment gets forwarded back into Telegram
    // as if it were a Claude reply.
    const sharedSites: Record<string, SiteConfig> = {
      alpha: { ...fixtureSites.foo, id: "alpha", botUsername: "shared[bot]" },
      beta: { ...fixtureSites.bar, id: "beta", botUsername: "shared[bot]" },
    };
    expect(isOwnBotLoginInMap(sharedSites, "shared[bot]")).toBe(true);
  });

  it("returns false for human users", () => {
    expect(isOwnBotLoginInMap(fixtureSites, "levino")).toBe(false);
    expect(isOwnBotLoginInMap(fixtureSites, "some-other-user")).toBe(false);
  });

  it("returns false for unrelated bots", () => {
    expect(isOwnBotLoginInMap(fixtureSites, "dependabot[bot]")).toBe(false);
    expect(isOwnBotLoginInMap(fixtureSites, "github-actions[bot]")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isOwnBotLoginInMap(fixtureSites, undefined)).toBe(false);
  });
});

describe("decideThreadAction", () => {
  it("returns reply when there is an existing issue", () => {
    expect(decideThreadAction(123, null)).toEqual({
      kind: "reply",
      issueNumber: 123,
    });
  });

  it("returns newTask when there is a pending thema", () => {
    expect(decideThreadAction(null, "Stammtisch am 25.4.")).toEqual({
      kind: "newTask",
      thema: "Stammtisch am 25.4.",
    });
  });

  it("REGRESSION: returns unknownThread instead of silently doing nothing when neither", () => {
    // This must NEVER be a bare null that the worker silently ignores —
    // the user needs to know that their message went nowhere.
    expect(decideThreadAction(null, null)).toEqual({ kind: "unknownThread" });
  });

  it("prefers an existing issue over a pending thema (shouldn't happen but be deterministic)", () => {
    expect(decideThreadAction(123, "leftover")).toEqual({
      kind: "reply",
      issueNumber: 123,
    });
  });

  it("treats issueNumber 0 as a real reply (defensive)", () => {
    expect(decideThreadAction(0, null)).toEqual({
      kind: "reply",
      issueNumber: 0,
    });
  });
});

describe("site-scoped auth KV keys", () => {
  it("userKey includes the site id", () => {
    expect(userKey("foo", 42)).toBe("user:foo:42");
    expect(userKey("bar", 42)).toBe("user:bar:42");
  });

  it("userKey produces different keys for the same user on different sites", () => {
    expect(userKey("foo", 42)).not.toBe(userKey("bar", 42));
  });

  it("pendingKey includes the site id", () => {
    expect(pendingKey("foo", 42)).toBe("pending:foo:42");
    expect(pendingKey("bar", 42)).toBe("pending:bar:42");
  });

  it("pendingKey produces different keys for the same user on different sites", () => {
    expect(pendingKey("foo", 42)).not.toBe(pendingKey("bar", 42));
  });

  it("userListPrefix matches only user keys of the given site", () => {
    const prefix = userListPrefix("foo");
    expect(userKey("foo", 1).startsWith(prefix)).toBe(true);
    expect(userKey("bar", 1).startsWith(prefix)).toBe(false);
  });

  it("userListPrefix can strip to get just the user id", () => {
    const prefix = userListPrefix("foo");
    const key = userKey("foo", 13627541);
    expect(key.replace(prefix, "")).toBe("13627541");
  });
});
