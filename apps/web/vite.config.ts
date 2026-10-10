import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ mode }) => {
  // Read only PORT from the root .env, to know where the API is. Nothing from
  // that file reaches the browser bundle: the web app has no env variables.
  const { PORT = "3000" } = loadEnv(mode, repoRoot, "PORT");

  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: { "/api": `http://localhost:${PORT}` },
    },
  };
});
