import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const daemonTarget = process.env.VITE_DAEMON_URL ?? "http://127.0.0.1:3210";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: daemonTarget,
        changeOrigin: true,
        ws: true,
      },
      "/terminals": {
        target: daemonTarget,
        ws: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
