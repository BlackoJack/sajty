/**
 * ─────────────────────────────────────────────────────────────
 *  ВСЁ ЛИЧНОЕ И ВСЕ ЦЕНЫ — ЗДЕСЬ.
 *  Меняете тут — меняется по всему сайту, включая калькулятор.
 * ─────────────────────────────────────────────────────────────
 */

export const config = {
  // Бренд: слово в шапке и футере
  brand: {
    wordmark: "сайты",
    tagline: "сайты для небольших дел",
  },

  name: "Иван Раенко",
  shortName: "Иван",
  role: "Сайты для небольших дел",
  city: "Новосибирск",

  // TODO: домен после покупки (и в astro.config.mjs тоже)
  siteUrl: "https://blackojack.github.io/sajty",

  contacts: {
    // TODO: проверьте ссылку — сейчас взята из резюме
    telegram: { label: "@devopsnsk", url: "https://t.me/devopsnsk" },
    // TODO: проверьте ссылку Max — сейчас взята из резюме
    max: {
      label: "профиль",
      short: "Max",
      url: "https://max.ru/u/f9LHodD0cOJRMeqwry1H3VOwIUXQYiUHdfjxw4NfCPLSptlnNq9DlD3CL60",
    },
    // TODO: проверьте номер для WhatsApp (сейчас — номер из резюме)
    whatsapp: { label: "+7 913 019-71-99", short: "WhatsApp", url: "https://wa.me/79130197199" },
    // TODO: проверьте почту
    email: { label: "devopsnskru@gmail.com", url: "mailto:devopsnskru@gmail.com" },
  },

  // Ссылка на рабочий пример — первый проект в портфолио
  example: {
    label: "sайт инженера-визитка",
    url: "https://blackojack.github.io",
  },

  formAction: "/api/lead",

  /**
   * ЦЕНЫ. Всё, что видит посетитель, считается из этих чисел.
   * Ставьте реальные — это первое, о чём спросят.
   */
  price: {
    visitka: 9000, // сайт-визитка, одна страница
    landing: 12000, // лендинг под услугу
    catalog: 28000, // каталог с фото, ценами и фильтрами
    texts: 4000, // помощь с текстами
    setup: 3500, // домен, хостинг, почта, аналитика, поиск
    support: 2000, // поддержка, ₽/мес
  },

  meta: {
    title: "Сайт вместо переписки — визитка, каталог, лендинг за 2–3 дня",
    description:
      "Сделаю сайт, на который просто дают ссылку: цены, работы и запись на одной странице. Для мастерской, салона, автосервиса, репетитора. За 2–3 дня, без конструктора и абонплаты.",
    ogImage: "/og.png",
  },
} as const;

/** 9000 → «9 000» (узкий пробел для вёрстки и обычный для текста) */
export function money(value: number): string {
  return value.toLocaleString("ru-RU").replace(/\u00A0/g, " ");
}

export function from(value: number): string {
  return `от ${money(value)} ₽`;
}

export type Config = typeof config;

/**
 * Ссылка на файл из public/ с учётом базового пути сборки.
 * Работает и на своём домене ("/"), и в подпапке GitHub Pages ("/repo/").
 */
export function asset(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");
  return base + path.replace(/^\//, "");
}
