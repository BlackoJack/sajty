import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";

/**
 * site и base приходят из окружения, чтобы один и тот же код работал
 * и на своём домене (base = "/"), и в подпапке GitHub Pages / GitLab Pages.
 *
 *   SITE_URL=https://blackojack.github.io BASE_PATH=/sajty npm run build
 *
 * Без переменных собирается обычная корневая версия.
 */
const site = process.env.SITE_URL || "https://sitly.ru";
const base = process.env.BASE_PATH || "/";

export default defineConfig({
  site,
  base,
  integrations: [sitemap()],
  vite: {
    plugins: [
      tailwindcss(),
      {
        name: "admin-index",
        configureServer(server) {
          server.middlewares.use((req, _res, next) => {
            const url = req.url?.split("?")[0];
            if (url === "/admin" || url === "/admin/") req.url = "/admin/index.html";
            next();
          });
        },
      },
    ],
    server: {
      proxy: {
        "/api": process.env.ADMIN_API || "http://127.0.0.1:8787",
      },
    },
  },
});
