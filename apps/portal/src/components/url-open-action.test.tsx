import type { UrlOpenRequest } from "@nanasa/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UrlOpenAttentionItem } from "../attention-items.js";
import { UrlOpenAction } from "./url-open-action.js";

const request: UrlOpenRequest = {
  id: "url-open-one",
  groupId: "group-one",
  memberId: "member-one",
  runId: "run-one",
  generation: 1,
  url: "https://example.com/login?token=private",
  requestedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};
const item = {
  id: "attention:one",
  runId: request.runId,
  generation: 1,
  request,
} as UrlOpenAttentionItem;
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const navigate = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const tab = {
    opener: {},
    document: document.implementation.createHTMLDocument(),
    closed: false,
    close: vi.fn(),
  };
  const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  const client = { getUrlOpenRequest: vi.fn().mockResolvedValue(request) };
  const dismiss = vi.fn().mockResolvedValue(true);
  return { tab, open, client, dismiss, navigate };
}

describe("URL open action", () => {
  it("opens only after a user gesture and server revalidation, without an opener or referrer", async () => {
    const { tab, open, client, dismiss, navigate } = fixture();
    let resolveRequest!: (value: UrlOpenRequest) => void;
    client.getUrlOpenRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    render(<UrlOpenAction item={item} client={client} onDismiss={dismiss} />);
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open URL" }));
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(tab.opener).toBeNull();
    expect(tab.document.querySelector('meta[name="referrer"]')?.getAttribute("content")).toBe(
      "no-referrer",
    );
    expect(navigate).not.toHaveBeenCalled();
    resolveRequest(request);
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(tab.document.querySelector("a")?.href).toBe(request.url);
    expect(tab.document.querySelector("a")?.referrerPolicy).toBe("no-referrer");
    expect(dismiss).toHaveBeenCalledWith([item.id]);
  });

  it("closes the blank tab when the run stopped or the daemon is unavailable", async () => {
    const { tab, client, dismiss, navigate } = fixture();
    client.getUrlOpenRequest.mockRejectedValue(new Error("gone"));
    render(<UrlOpenAction item={item} client={client} onDismiss={dismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Open URL" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer available");
    expect(tab.close).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("reports blocked popups without dismissing the request", async () => {
    const { open, client, dismiss } = fixture();
    open.mockReturnValue(null);
    render(<UrlOpenAction item={item} client={client} onDismiss={dismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Open URL" }));
    expect(screen.getByRole("alert")).toHaveTextContent("blocked");
    expect(client.getUrlOpenRequest).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("does not open expired requests", () => {
    const { open, client, dismiss } = fixture();
    render(
      <UrlOpenAction
        item={{ ...item, request: { ...request, expiresAt: "2020-01-01T00:00:00.000Z" } }}
        client={client}
        onDismiss={dismiss}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open URL" }));
    expect(screen.getByRole("alert")).toHaveTextContent("expired");
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects a changed URL", async () => {
    const { tab, client, dismiss, navigate } = fixture();
    client.getUrlOpenRequest.mockResolvedValue({ ...request, url: "https://different.example" });
    render(<UrlOpenAction item={item} client={client} onDismiss={dismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Open URL" }));
    await screen.findByRole("alert");
    expect(navigate).not.toHaveBeenCalled();
    expect(tab.close).toHaveBeenCalledOnce();
  });
});
