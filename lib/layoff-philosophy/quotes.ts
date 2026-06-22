export type QuoteStatus = "published" | "ready" | "draft";

export type QuoteCategory =
  | "existentialist"
  | "classical"
  | "nietzsche"
  | "eastern"
  | "political"
  | "russian_lit";

export type BackgroundCategory = "emptiness" | "machine" | "exit" | "contemplation";

export interface Quote {
  id: string;
  text: string;
  author: string;
  original: string;
  category: QuoteCategory;
  backgroundCategory: BackgroundCategory;
  status: QuoteStatus;
}

export const quotes: Quote[] = [
  // === PUBLISHED (from original Instagram page) ===
  {
    id: "dostoevsky-definition",
    text: "The best definition of man is: a being that goes on two legs and is laid off",
    author: "Fyodor Dostoevsky",
    original: "The best definition of man is: a being that goes on two legs and is ungrateful",
    category: "russian_lit",
    backgroundCategory: "contemplation",
    status: "published",
  },
  {
    id: "socrates-unexamined",
    text: "The unexamined employee is not worth paying",
    author: "Socrates",
    original: "The unexamined life is not worth living",
    category: "classical",
    backgroundCategory: "machine",
    status: "published",
  },
  {
    id: "nietzsche-abyss",
    text: "If you gaze long into a layoff, the layoff also gazes into you",
    author: "Friedrich Nietzsche",
    original: "If you gaze long into an abyss, the abyss also gazes into you",
    category: "nietzsche",
    backgroundCategory: "emptiness",
    status: "published",
  },
  {
    id: "lennon-plans",
    text: "Layoffs are what happen when you're busy making other plans",
    author: "John Lennon",
    original: "Life is what happens when you're busy making other plans",
    category: "classical",
    backgroundCategory: "exit",
    status: "published",
  },
  {
    id: "pierce-employee",
    text: "By an employee, I mean anything that we can fire, i.e. anything we can layoff",
    author: "Charles Sanders Pierce",
    original: "By a sign, I mean anything that communicates a definite notion of an object",
    category: "classical",
    backgroundCategory: "machine",
    status: "published",
  },
  {
    id: "nietzsche-close",
    text: "A layoff is close enough at hand so we do not need to be afraid of work",
    author: "Friedrich Nietzsche",
    original: "Death is close enough at hand so we do not need to be afraid of life",
    category: "nietzsche",
    backgroundCategory: "contemplation",
    status: "published",
  },
  {
    id: "sartre-three-oclock",
    text: "Three o'clock is always too late or too early for any layoff you want to do",
    author: "Jean-Paul Sartre",
    original: "Three o'clock is always too late or too early for anything you want to do",
    category: "existentialist",
    backgroundCategory: "emptiness",
    status: "published",
  },
  {
    id: "shuson-fire",
    text: "I fire a man and realize my three other ICs have been watching",
    author: "Kato Shuson",
    original: "I kill an ant and realize my three children have been watching",
    category: "eastern",
    backgroundCategory: "machine",
    status: "published",
  },
  {
    id: "erasmus-blind",
    text: "In the land of the blind the one-eyed man is laid off",
    author: "Desiderius Erasmus",
    original: "In the land of the blind the one-eyed man is king",
    category: "classical",
    backgroundCategory: "exit",
    status: "published",
  },
  {
    id: "camus-sisyphus",
    text: "One must imagine Sisyphus laid off",
    author: "Albert Camus",
    original: "One must imagine Sisyphus happy",
    category: "existentialist",
    backgroundCategory: "emptiness",
    status: "published",
  },
  {
    id: "dostoevsky-sick",
    text: "I am a sick man... I am a wicked man. A laid off man.",
    author: "Fyodor Dostoevsky",
    original: "I am a sick man... I am a wicked man. An unattractive man.",
    category: "russian_lit",
    backgroundCategory: "contemplation",
    status: "published",
  },
  {
    id: "milman-layoffs",
    text: "Layoffs: too fair to worship, too divine to love",
    author: "Henry Hart Milman",
    original: "Too fair to worship, too divine to love",
    category: "classical",
    backgroundCategory: "contemplation",
    status: "published",
  },

  // === NEW — READY TO POST ===
  {
    id: "sartre-severance",
    text: "Severance precedes existence",
    author: "Jean-Paul Sartre",
    original: "Existence precedes essence",
    category: "existentialist",
    backgroundCategory: "emptiness",
    status: "ready",
  },
  {
    id: "nietzsche-role-dead",
    text: "My role is dead. My role will remain dead. And we have killed it",
    author: "Friedrich Nietzsche",
    original: "God is dead. God remains dead. And we have killed him",
    category: "nietzsche",
    backgroundCategory: "machine",
    status: "ready",
  },
  {
    id: "stalin-tragedy",
    text: "One layoff is a tragedy. Ten thousand is a restructuring",
    author: "Joseph Stalin",
    original: "One death is a tragedy. A million deaths is a statistic",
    category: "political",
    backgroundCategory: "machine",
    status: "ready",
  },
  {
    id: "zen-enlightenment",
    text: "Before enlightenment: chop wood, carry water. After layoff: update LinkedIn, carry box",
    author: "Zen Proverb",
    original:
      "Before enlightenment: chop wood, carry water. After enlightenment: chop wood, carry water",
    category: "eastern",
    backgroundCategory: "contemplation",
    status: "ready",
  },

  // === DRAFTS ===
  {
    id: "sartre-hell",
    text: "Hell is other people's calendar invites",
    author: "Jean-Paul Sartre",
    original: "Hell is other people",
    category: "existentialist",
    backgroundCategory: "machine",
    status: "draft",
  },
  {
    id: "sartre-condemned",
    text: "Man is condemned to be free. And also to reapply on the careers page",
    author: "Jean-Paul Sartre",
    original: "Man is condemned to be free",
    category: "existentialist",
    backgroundCategory: "exit",
    status: "draft",
  },
  {
    id: "socrates-badge",
    text: "The only thing I know is that my badge no longer works",
    author: "Socrates",
    original: "I know that I know nothing",
    category: "classical",
    backgroundCategory: "exit",
    status: "draft",
  },
  {
    id: "aristotle-habit",
    text: "We are what we repeatedly do. Getting laid off, then, is not an act but a habit",
    author: "Aristotle",
    original: "We are what we repeatedly do. Excellence, then, is not an act but a habit",
    category: "classical",
    backgroundCategory: "machine",
    status: "draft",
  },
  {
    id: "nietzsche-backfilled",
    text: "God is dead. And His role has not been backfilled",
    author: "Friedrich Nietzsche",
    original: "God is dead",
    category: "nietzsche",
    backgroundCategory: "emptiness",
    status: "draft",
  },
  {
    id: "nietzsche-linkedin",
    text: "What does not kill me makes me a stronger LinkedIn poster",
    author: "Friedrich Nietzsche",
    original: "What does not kill me makes me stronger",
    category: "nietzsche",
    backgroundCategory: "exit",
    status: "draft",
  },
  {
    id: "nietzsche-why",
    text: "He who has a why to layoff can bear almost any how",
    author: "Friedrich Nietzsche",
    original: "He who has a why to live can bear almost any how",
    category: "nietzsche",
    backgroundCategory: "contemplation",
    status: "draft",
  },
  {
    id: "lao-tzu-pip",
    text: "The Tao that can be spoken is not the true Tao. The PIP that can be appealed is not the true PIP",
    author: "Lao Tzu",
    original: "The Tao that can be spoken is not the true Tao",
    category: "eastern",
    backgroundCategory: "contemplation",
    status: "draft",
  },
  {
    id: "zen-vp",
    text: "If you meet the VP on the road, update your resume",
    author: "Zen Proverb",
    original: "If you meet the Buddha on the road, kill him",
    category: "eastern",
    backgroundCategory: "exit",
    status: "draft",
  },
  {
    id: "marx-history",
    text: "The history of all hitherto existing society is the history of workforce reductions",
    author: "Karl Marx",
    original: "The history of all hitherto existing society is the history of class struggles",
    category: "political",
    backgroundCategory: "machine",
    status: "draft",
  },
  {
    id: "mcluhan-medium",
    text: "The medium is the mass layoff email",
    author: "Marshall McLuhan",
    original: "The medium is the message",
    category: "political",
    backgroundCategory: "machine",
    status: "draft",
  },
  {
    id: "tolstoy-employees",
    text: "All happy employees resemble one another. Each laid-off employee is laid off in their own way",
    author: "Leo Tolstoy",
    original: "All happy families are alike; each unhappy family is unhappy in its own way",
    category: "russian_lit",
    backgroundCategory: "contemplation",
    status: "draft",
  },
  {
    id: "dostoevsky-headcount",
    text: "Pain and suffering are always inevitable for a large headcount",
    author: "Fyodor Dostoevsky",
    original:
      "Pain and suffering are always inevitable for a large intelligence and a deep heart",
    category: "russian_lit",
    backgroundCategory: "contemplation",
    status: "draft",
  },
];

export interface BackgroundCategoryMeta {
  label: string;
  description: string;
  hint: string;
  fallbackGradient: string;
}

export const backgroundCategories: Record<BackgroundCategory, BackgroundCategoryMeta> = {
  emptiness: {
    label: "Corporate Emptiness",
    description: "Empty offices, vacant desks, abandoned workstations",
    hint: "Try: empty office, vacant desk, foggy road",
    fallbackGradient:
      "linear-gradient(160deg, #1a1410 0%, #2c1f15 30%, #1a1a2e 70%, #0d0d0d 100%)",
  },
  machine: {
    label: "The Machine",
    description: "Corporate infrastructure, systems, impersonal architecture",
    hint: "Try: elevator, glass building, server room",
    fallbackGradient:
      "linear-gradient(145deg, #0a0e1a 0%, #1a2040 40%, #0d1525 70%, #060a12 100%)",
  },
  exit: {
    label: "The Exit",
    description: "Leaving, departing, walking away",
    hint: "Try: hallway, exit door, parking garage",
    fallbackGradient:
      "linear-gradient(155deg, #1a1a1a 0%, #2d2d3a 30%, #1f1f28 60%, #0f0f14 100%)",
  },
  contemplation: {
    label: "Contemplation",
    description: "Stillness, reflection, weight of thought",
    hint: "Try: rain on window, sunset silhouette",
    fallbackGradient:
      "linear-gradient(150deg, #0a1a10 0%, #152e1a 35%, #0e1a14 65%, #080f0a 100%)",
  },
};
