import type { DaemonContext } from "../src/server.js";

export async function authenticateTestDaemon(
  daemon: DaemonContext,
): Promise<{ cookie: string; csrfToken: string }> {
  const rawInject = daemon.app.inject.bind(daemon.app);
  const token = daemon.bootstrapFragment.slice("nanasa-bootstrap=".length);
  const exchange = await rawInject({
    method: "POST",
    url: "/api/v1/auth/bootstrap",
    payload: { token },
  });
  const cookie = exchange.headers["set-cookie"]?.split(";", 1)[0];
  const csrfToken = exchange.json<{ csrfToken: string }>().csrfToken;
  daemon.app.inject = ((optionsOrUrl: Parameters<typeof rawInject>[0]) => {
    if (typeof optionsOrUrl === "string") {
      return rawInject({
        method: "GET",
        url:
          optionsOrUrl.startsWith("/api/") && !optionsOrUrl.startsWith("/api/v1/")
            ? optionsOrUrl.replace("/api/", "/api/v1/")
            : optionsOrUrl,
        headers: cookie === undefined ? {} : { cookie },
      });
    }
    return rawInject({
      ...optionsOrUrl,
      url:
        optionsOrUrl.url.startsWith("/api/") && !optionsOrUrl.url.startsWith("/api/v1/")
          ? optionsOrUrl.url.replace("/api/", "/api/v1/")
          : optionsOrUrl.url,
      headers: {
        ...optionsOrUrl.headers,
        ...(cookie === undefined ? {} : { cookie }),
        "x-nanasa-csrf": csrfToken,
      },
    });
  }) as typeof daemon.app.inject;
  if (cookie === undefined) throw new Error("Operator bootstrap did not issue a session cookie");
  return { cookie, csrfToken };
}
