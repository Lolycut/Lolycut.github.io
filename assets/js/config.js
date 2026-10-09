/* ─────────────────────────────────────────────────────────────
   Настройки сайта. Всё, что помечено REPLACE, заменить своими данными.
   ───────────────────────────────────────────────────────────── */
window.AVES_CONFIG = {
  site: "https://microcosmos-bio.me",

  // Факультеты = боты. api — адрес сервиса бота на Render (без слэша в конце).
  faculties: {
    bio: {
      bird: "AvesBio",
      title: "Биологический факультет",
      short: "Биофак",
      bot: "schedulebiobot",
      api: "https://biobotm.onrender.com",
    },
    fsk: {
      bird: "AvesFlow",
      title: "Факультет социокультурных коммуникаций",
      short: "ФСК",
      bot: "schedulefskbot",
      api: "https://mambafsk.onrender.com",
    },
    fmo: {
      bird: "AvesGlobe",
      title: "Факультет международных отношений",
      short: "ФМО",
      bot: "schedulefirbot",              // REPLACE: username бота ФМО без @
      api: "https://mambafmo.onrender.com", // REPLACE, если сервис на Render называется иначе
    },
  },

  // Бот, через которого идёт вход на сайте (у него в BotFather настроен Login Widget)
  loginFaculty: "bio",
  // Client ID из @BotFather → бот → Login Widget
  telegramClientId: "8380079376",
  // Разрешения: профиль + право боту писать в личку (нужно для утренней рассылки)
  telegramScope: "openid profile telegram:bot_access",
  
  // Конспекты и фото дня — один бот на все факультеты, лента у каждого факультета своя
  study: {
    api: "https://avesst.onrender.com",
    bot: "Aves_Studybot",
  },

  channelUrl: "https://t.me/AvesBY",
  studyBot: "Aves_Studybot",
};
