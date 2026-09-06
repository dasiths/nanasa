import { BrowserUrlSchema } from "@nanasa/contracts";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import type { PortalClient } from "../api.js";
import type { UrlOpenAttentionItem } from "../attention-items.js";

export function UrlOpenAction({
  item,
  client,
  onDismiss,
}: {
  item: UrlOpenAttentionItem;
  client: Pick<PortalClient, "getUrlOpenRequest">;
  onDismiss(itemIds: readonly string[]): Promise<boolean>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const open = async () => {
    if (pending) return;
    if (Date.parse(item.request.expiresAt) <= Date.now()) {
      setError("This browser request has expired.");
      return;
    }
    const tab = window.open("about:blank", "_blank");
    if (tab === null) {
      setError("The browser blocked the new tab. Allow popups for this portal and try again.");
      return;
    }
    tab.opener = null;
    const referrer = tab.document.createElement("meta");
    referrer.name = "referrer";
    referrer.content = "no-referrer";
    tab.document.head.append(referrer);
    setPending(true);
    setError(undefined);
    try {
      const request = await client.getUrlOpenRequest(item.request.id);
      const url = BrowserUrlSchema.parse(request.url);
      if (
        request.id !== item.request.id ||
        request.runId !== item.runId ||
        request.generation !== item.generation ||
        url !== item.request.url ||
        Date.parse(request.expiresAt) <= Date.now()
      )
        throw new Error("Request changed");
      if (tab.closed) return;
      const link = tab.document.createElement("a");
      link.href = url;
      link.rel = "noopener noreferrer";
      link.referrerPolicy = "no-referrer";
      tab.document.body.append(link);
      link.click();
      await onDismiss([item.id]);
    } catch {
      tab.close();
      setError("This browser request is no longer available, or the daemon could not be reached.");
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className="compact-button"
        onClick={() => void open()}
        disabled={pending}
      >
        <ExternalLink aria-hidden="true" size={14} />
        {pending ? "Opening URL" : "Open URL"}
      </button>
      {error !== undefined && <span role="alert">{error}</span>}
    </>
  );
}
