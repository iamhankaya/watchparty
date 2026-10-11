import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const backend = env.BACKEND_URL || "http://localhost:5205";

  return {
    plugins: [react()],
    server: {
      port: 5173,
      // Geliştirmede /api ve /hubs istekleri .NET backend'e gider.
      // Prod'da CloudFront aynı yolları EC2'ye yönlendirecek, bu yüzden CORS gerekmez.
      proxy: {
        "/api": { target: backend, changeOrigin: true },
        "/hubs": { target: backend, changeOrigin: true, ws: true },
      },
    },
  };
});
