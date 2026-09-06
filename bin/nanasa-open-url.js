import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function requestBrowserOpen(args, environment = process.env) {
  if (args.length !== 1) throw new Error("Usage: nanasa open-url <http-or-https-url>");
  let url;
  let endpoint;
  try {
    url = new URL(args[0]);
    endpoint = new URL(environment.NANASA_BROWSER_URL);
  } catch {
    throw new Error("A valid URL and managed agent browser environment are required");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    args[0].length > 8_192 ||
    !/^https?:\/\//i.test(args[0]) ||
    args[0].includes("\\") ||
    [...args[0]].some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("Only HTTP and HTTPS URLs without credentials are supported");
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
    endpoint.pathname !== "/api/v1/agent-url-requests" ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password ||
    !environment.NANASA_MCP_TOKEN
  )
    throw new Error("A managed agent browser environment is required");
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${environment.NANASA_MCP_TOKEN}`,
      },
      body: JSON.stringify({ url: args[0] }),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new Error("Unable to deliver browser request to the portal");
  }
  if (response.status !== 202) throw new Error(`Browser request was rejected (${response.status})`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  requestBrowserOpen(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
