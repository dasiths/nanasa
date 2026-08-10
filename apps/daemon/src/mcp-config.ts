import { isIP } from "node:net";

export function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    (isIP(host) === 4 && host.startsWith("127."))
  );
}

export function validateMcpEndpointConfiguration(options: {
  enabled: boolean;
  endpointUrl: string;
  operatorToken?: string;
}): URL {
  const endpoint = new URL(options.endpointUrl);
  if (!options.enabled) {
    return endpoint;
  }
  if (!isLoopbackHost(endpoint.hostname) && endpoint.protocol !== "https:") {
    throw new Error("External MCP endpoint URLs must use HTTPS");
  }
  if (!isLoopbackHost(endpoint.hostname) && options.operatorToken === undefined) {
    throw new Error("An MCP operator token is required for external access");
  }
  if (options.operatorToken !== undefined && options.operatorToken.length < 32) {
    throw new Error("The MCP operator token must contain at least 32 characters");
  }
  return endpoint;
}
