/**
 * Технические константы и текст для поиска.
 * Имя, контакты, цены и ссылка на пример правятся в админке.
 * В репозитории этих данных нет: живые значения хранит админка.
 */

export const config = {
  formAction: "/api/lead",

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
