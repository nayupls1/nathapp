import stylex from "@stylexjs/unplugin";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  root: "src/renderer",
  plugins: [stylex.vite({ useCSSLayers: true }), solid()],
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
  },
});
