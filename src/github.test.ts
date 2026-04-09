import { describe, expect, it } from "vitest";
import { embedChatId, extractChatId, extractSiteId } from "./config";

describe("embedChatId", () => {
  it("produces a comment containing both the chat id and the site", () => {
    const marker = embedChatId(12345, "example");
    expect(marker).toContain("12345");
    expect(marker).toContain("example");
    expect(marker.startsWith("<!--")).toBe(true);
    expect(marker.endsWith("-->")).toBe(true);
  });
});

describe("extractChatId", () => {
  it("roundtrips a chat id embedded for any site", () => {
    expect(extractChatId(embedChatId(12345, "foo"))).toBe(12345);
    expect(extractChatId(embedChatId(987654, "bar-123"))).toBe(987654);
  });

  it("still works for the legacy format without a site", () => {
    expect(extractChatId("<!-- telegram:chat_id=999 -->")).toBe(999);
  });

  it("returns null when no marker is present", () => {
    expect(extractChatId("no marker here")).toBeNull();
  });
});

describe("extractSiteId", () => {
  it("roundtrips a site id through embedChatId", () => {
    expect(extractSiteId(embedChatId(12345, "foo"))).toBe("foo");
    expect(extractSiteId(embedChatId(42, "bar"))).toBe("bar");
  });

  it("returns null for the legacy format without a site", () => {
    expect(extractSiteId("<!-- telegram:chat_id=999 -->")).toBeNull();
  });

  it("returns null when no marker is present", () => {
    expect(extractSiteId("no marker here")).toBeNull();
  });
});
