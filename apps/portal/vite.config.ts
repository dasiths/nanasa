import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const daemonTarget = process.env.VITE_DAEMON_URL ?? "http://127.0.0.1:3210";

export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@xterm")) return "vendor-xterm";
          if (id.includes("lucide-react")) return "vendor-icons";
          if (id.includes("react") || id.includes("scheduler")) return "vendor-react";
          if (id.includes("zod") || id.includes("@nanasa")) return "vendor-control";
          return "vendor";
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": {
        target: daemonTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
