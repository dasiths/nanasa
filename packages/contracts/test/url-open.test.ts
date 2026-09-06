import { describe, expect, it } from "vitest";
import { BrowserUrlSchema, CreateUrlOpenRequestSchema } from "../src/url-open.js";

describe("browser URL requests", () => {
  it.each([
    "https://github.com/login/device?code=secret#fragment",
    "http://localhost:3000/callback",
    "http://127.0.0.1:8080/",
    "http://[::1]:8080/",
  ])("preserves the original URL %s", (url) => {
    expect(CreateUrlOpenRequestSchema.parse({ url })).toEqual({ url });
  });

  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,hello",
    "https://user:password@example.com",
    " https://example.com",
    "https://example.com\n",
    "https://example.com/a b",
    "not-a-url",
    `https://example.com/${"a".repeat(8_192)}`,
    "https:example.com",
    "http:/example.com",
    "https://example.com\\path",
  ])("rejects unsafe or malformed URLs", (url) => {
    expect(BrowserUrlSchema.safeParse(url).success).toBe(false);
  });

  it("does not accept caller-supplied run identity", () => {
    expect(
      CreateUrlOpenRequestSchema.safeParse({
        url: "https://example.com",
        runId: "another-run",
      }).success,
    ).toBe(false);
  });
});
