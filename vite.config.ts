import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  // One three.js: IWER's DevUI asks for r184, and its copy landed in the eagerly loaded core chunk.
  resolve: { dedupe: ["three"] },
  server: { port: 5421, strictPort: true, open: false },
  preview: { port: 5420, strictPort: true, open: false },
  build: {
    target: "es2022",
    sourcemap: false,
    rolldownOptions: {
      output: {
        // three ships as core + WebGL module + addons; separate vendor chunks load in parallel and cache.
        codeSplitting: {
          groups: [
            { name: "three-core", test: /node_modules[\\/].*three[\\/]build[\\/]three\.core/, priority: 2 },
            { name: "three", test: /node_modules[\\/].*three[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
});
