import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  accountId: "73d901a62883a2338be9fc9f14b61035",
  worker: {
    name: "yc-proxy",
    compatibilityDate: "2025-11-01",
    entrypoint: "./src/index.js",
    domains: [
      "sitly.ru",
      "www.sitly.ru",
      "gipsplamya.ru",
      "www.gipsplamya.ru",
    ],
    env: {
      ORIGIN_SITLY: bindings.text(
        "https://d5dtj8vd79u87svcao1i.764nr5vy.apigw.yandexcloud.net",
      ),
      ORIGIN_GIPS: bindings.text(
        "https://d5d5sag4v80r468p7tnr.4kscn31j.apigw.yandexcloud.net",
      ),
    },
  },
});
