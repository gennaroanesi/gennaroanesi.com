/** @type {import('next-i18next').UserConfig} */
module.exports = {
  debug: process.env.NODE_ENV === "development",
  i18n: {
    defaultLocale: "pt-BR",
    locales: ["en", "pt-BR"],
  },
  react: {
    bindI18n: "loaded languageChanged",
    bindI18nStore: "added",
    useSuspense: true,
  },
};
