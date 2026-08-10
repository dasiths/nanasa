import { createInterface } from "node:readline";

process.stdout.write(`SAFE_ECHO_READY:${process.pid}\n`);

const lines = createInterface({ input: process.stdin, terminal: false });
lines.on("line", (line) => {
  process.stdout.write(`SAFE_ECHO:${line}\n`);
});

const close = () => {
  lines.close();
  process.exit(0);
};

process.once("SIGINT", close);
process.once("SIGTERM", close);
