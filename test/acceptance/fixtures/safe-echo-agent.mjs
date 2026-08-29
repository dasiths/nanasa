import { createInterface } from "node:readline";

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write(`\u001b[?1000h\u001b[?1006hSAFE_ECHO_READY:${process.pid}\n`);

process.stdin.on("data", (chunk) => {
  const input = Buffer.from(chunk).toString("utf8");
  if (input.includes("\u001b[5~")) process.stdout.write("SAFE_KEY:PageUp\n");
  if (input.includes("\u001b[6~")) process.stdout.write("SAFE_KEY:PageDown\n");
  if (input.includes("\u001b[<64;")) process.stdout.write("SAFE_MOUSE:WheelUp\n");
  if (input.includes("\u001b[<65;")) process.stdout.write("SAFE_MOUSE:WheelDown\n");
});

const lines = createInterface({ input: process.stdin, terminal: false });
lines.on("line", (line) => {
  if (line === "__ALT__") {
    process.stdout.write("\u001b[?1049hALTERNATE_SCREEN_READY\r\n");
    setTimeout(() => process.stdout.write("\u001b[?1049lALTERNATE_SCREEN_EXITED\n"), 250);
    return;
  }
  if (line === "__OSC52__") {
    process.stdout.write(
      `\u001b]52;c;${Buffer.from("clipboard 世界 🌍").toString("base64")}\u0007`,
    );
    return;
  }
  process.stdout.write(`SAFE_ECHO:${line}\n`);
});

const close = () => {
  process.stdout.write("\u001b[?1006l\u001b[?1000l");
  process.stdin.setRawMode?.(false);
  lines.close();
  process.exit(0);
};

process.once("SIGINT", close);
process.once("SIGTERM", close);
