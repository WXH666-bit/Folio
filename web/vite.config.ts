import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL("./client", import.meta.url)), plugins: [react()],
  build: { outDir: fileURLToPath(new URL("./dist", import.meta.url)), emptyOutDir: true },
  server: { host: "127.0.0.1", port: 5173, proxy: { "/api": { target: "http://127.0.0.1:3210", changeOrigin: false } } },
});
