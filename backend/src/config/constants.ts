import { loadAmazonLinksFromJson } from "../amazon-links.js";
import { env } from "./env.js";
import type { CacheEntry, Locale, ProductTheme } from "../types/index.js";

export const answerCache = new Map<string, CacheEntry>();

export const ONBOARDING_QUESTION =
  "Bonjour ! Je suis GEBot... Pouvez-vous me dire si vous êtes un professionnel ou un particulier ?";
export const ONBOARDING_QUESTION_BY_LOCALE: Record<Locale, string> = {
  fr: ONBOARDING_QUESTION,
  en: "Hello! I'm GEBot. Please tell me if you are a professional or an individual customer.",
  nl: "Hallo! Ik ben GEBot. Kunt u aangeven of u een professional of particulier bent?",
  pl: "Czesc! Jestem GEBot. Czy jestes profesjonalista czy klientem indywidualnym?",
};

export const NO_CONTEXT_FALLBACK =
  "Désolé, je ne trouve pas d'info technique pour ce produit dans mes fiches GEB.";
export const NO_MATCH_USAGE_FALLBACK = "Désolé, je ne trouve pas de fiche technique GEB spécifique pour cet usage.";
export const TTFT_TARGET_MS = 1200;
export const FULL_RESPONSE_BUDGET_MS = 10_000;
export const VECTOR_SEARCH_TIMEOUT_MS = 10_000;

export const VALID_THEMES: ProductTheme[] = [
  "plomberie", "piscine", "chauffage", "batiment", "maintenance", "automobile", "eco-conception",
];

export const THEME_QUESTION_BY_LOCALE: Record<Locale, string> = {
  fr: "Dans quel domaine se situe votre problème ?",
  en: "What area does your problem relate to?",
  nl: "Op welk gebied heeft uw probleem betrekking?",
  pl: "Jakiego obszaru dotyczy Twoj problem?",
};

export const NEXT_QUESTION_AFTER_THEME: Record<Locale, string> = {
  fr: "Parfait ! Quelle est votre question technique ?",
  en: "Great! What is your technical question?",
  nl: "Perfect! Wat is uw technische vraag?",
  pl: "Swietnie! Jakie jest Twoje pytanie techniczne?",
};

export const RESELLER_CACHE_TTL_MS = 15 * 60 * 1000;
export const GEO_TIMEOUT_MS = 1500;
export const AMAZON_LINKS_BY_LOCALE = loadAmazonLinksFromJson(env.AMAZON_LINKS_DATA_DIR);
export const RESELLER_DIRECTORY_URL = "https://www.geb.fr/revendeurs";
export const ANSWER_CACHE_VERSION = "v5_9_cited_product_format";

export const COMPLEMENTARY_HINTS: Array<{
  id: string;
  /** When set, extra context checks apply before suggesting this product. */
  context?: "plumbing_thread";
  keywords: string[];
  product: Record<Locale, string>;
}> = [
  {
    id: "ptfe",
    context: "plumbing_thread",
    keywords: ["raccord", "filetage", "filete", "ptfe", "filasse", "pate a joint", "pate joint", "plomberie", "canalisation", "tube"],
    product: {
      fr: "ruban PTFE GEB",
      en: "GEB PTFE tape",
      nl: "GEB PTFE-tape",
      pl: "tasma PTFE GEB",
    },
  },
  {
    id: "surface_cleaner",
    keywords: ["colle", "adhesif", "mastic"],
    product: {
      fr: "nettoyant de surface GEB",
      en: "GEB surface cleaner",
      nl: "GEB-oppervlaktereiniger",
      pl: "srodek do czyszczenia powierzchni GEB",
    },
  },
  {
    id: "plumbing_seal",
    keywords: ["canalisation", "raccord", "plomberie", "tube"],
    product: {
      fr: "solution d'etancheite GEB",
      en: "GEB sealing solution",
      nl: "GEB-afdichtingsoplossing",
      pl: "rozwiazanie uszczelniajace GEB",
    },
  },
];

