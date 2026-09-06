import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function browserOpenerEnvironment(
  runtimePath: string,
  packageRoot: string,
  endpoint: string,
): Record<string, string> {
  const directory = join(runtimePath, "browser-bin");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const script = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(packageRoot, "bin", "nanasa-open-url.js"))} "$@"\n`;
  for (const name of ["open-url", "xdg-open"]) {
    writeFileSync(join(directory, name), script, { mode: 0o700 });
  }
  return {
    BROWSER: join(directory, "open-url"),
    NANASA_BROWSER_URL: endpoint,
    NANASA_BROWSER_BIN: directory,
  };
}
