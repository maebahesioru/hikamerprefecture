import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/realtime-api": {
        target: "https://search.yahoo.co.jp",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/realtime-api/, "/realtime/api"),
      },
      "/fxtwitter-api": {
        target: "https://api.fxtwitter.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/fxtwitter-api/, ""),
      },
    },
  },
});
