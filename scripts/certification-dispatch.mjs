const MODES = new Set(["provider", "webkit", "arm64", "node24", "ubuntu", "systemd", "ssh"]);
const PROVIDERS = new Set(["copilot", "claude-code", "opencode", "pi"]);

export function validateCertificationDispatch(mode, providerId = "") {
  if (!MODES.has(mode)) throw new Error("Unknown certification mode");
  if (mode === "provider") {
    if (!PROVIDERS.has(providerId)) {
      throw new Error("provider_id is required for provider mode and must use a closed profile");
    }
    return { mode, providerId };
  }
  if (providerId.length > 0) throw new Error("provider_id is accepted only in provider mode");
  return { mode };
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  validateCertificationDispatch(
    process.env.NANASA_CERT_MODE ?? "",
    process.env.NANASA_CERT_PROVIDER_ID ?? "",
  );
}
