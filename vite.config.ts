import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  root: "src/renderer",
  plugins: [solid()],
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
  },
});
