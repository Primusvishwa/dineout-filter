import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { swiggyProxy } from "./swiggy-proxy.js";

export default defineConfig({
  plugins: [react(), swiggyProxy()],
  server: { port: 5173 },
});
