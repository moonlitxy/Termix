import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  plugins: [react()],
  // 版本号以 package.json 为准注入，前端「关于」等场景读取，避免硬编码
  define: {
    __TERMIX_VERSION__: JSON.stringify(pkg.version),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // xterm 体积较大（~280K），独立 chunk 便于缓存且避免单 chunk 超限
          xterm: ["@xterm/xterm", "@xterm/addon-fit", "@xterm/addon-search"],
          // 框架层 vendor
          vendor: ["react", "react-dom", "zustand", "@tauri-apps/api"],
        },
      },
    },
  },
});
