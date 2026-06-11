import type { Audience, ProductTheme } from "../types/index.js";

export type RetrievalRegressionCase = {
  id: string;
  locale: "fr" | "nl" | "pl";
  theme: ProductTheme | null;
  query: string;
  /** Session profile — filters DIY-only SKUs for pros. */
  audience?: Audience | null;
  /** Override metadata.fluid for routing tests. */
  fluid?: string | null;
  /** At least one must appear in top results (rank order). */
  expectedSlugs: string[];
  /** Must NOT appear in top results. */
  forbiddenSlugs?: string[];
  /** When true, routing must return zero products (hors catalogue). */
  expectNoProducts?: boolean;
  intent?: string;
};

/** Golden routing cases — extend when new misroutes are reported via feedback. */
export const RETRIEVAL_REGRESSION_CASES: RetrievalRegressionCase[] = [
  {
    id: "automobile-exhaust-seal",
    locale: "fr",
    theme: "automobile",
    query: "pot d echappement etancheite",
    expectedSlugs: ["pate-de-montage-echappement-collex", "mastic-de-reparation-echappement-collex"],
    forbiddenSlugs: ["startex", "kit-etancheite-eau-potable", "demarre-moteur"],
    intent: "sealing_assembly",
  },
  {
    id: "automobile-exhaust-repair",
    locale: "fr",
    theme: "automobile",
    query: "reparer fuite pot echappement",
    expectedSlugs: ["mastic-de-reparation-echappement-collex", "pate-de-montage-echappement-collex"],
    forbiddenSlugs: ["startex", "eau-potable"],
  },
  {
    id: "plomberie-eau-potable",
    locale: "fr",
    theme: "plomberie",
    query: "etancheite raccord eau potable",
    expectedSlugs: ["kit-etancheite-eau-potable"],
    forbiddenSlugs: ["echappement", "startex"],
    intent: "sealing_assembly",
  },
  {
    id: "bande-reparation-pvc-fuite",
    locale: "fr",
    theme: "plomberie",
    audience: "particulier",
    query:
      "est-ce que je peux réparer une fuite sur une canalisation PVC avec la bande réparation sous pression",
    expectedSlugs: ["bande-de-reparation"],
    forbiddenSlugs: ["gebetanche", "gebsoplast", "colle-haute-performance"],
    intent: "product_info",
  },
  {
    id: "plomberie-abs-colle-pro",
    locale: "fr",
    theme: "plomberie",
    audience: "professional",
    query: "quelle colle pour l abs",
    expectedSlugs: ["gebsoplast"],
    forbiddenSlugs: ["colle-haute-performance", "pool-filet"],
    intent: "product_info",
  },
  {
    id: "plomberie-abs-colle-particulier",
    locale: "fr",
    theme: "plomberie",
    audience: "particulier",
    query: "quelle colle pour l abs eau potable",
    fluid: "eau",
    expectedSlugs: ["colle-haute-performance"],
    forbiddenSlugs: ["gebsoplast", "decapant-gebsoplast"],
    intent: "product_info",
  },
  {
    id: "pate-joint-metal-gaz",
    locale: "fr",
    theme: "plomberie",
    audience: "professional",
    query: "Quelle pâte à joint pour le métal ? (milieu au contact: gaz)\ngaz",
    fluid: "gaz",
    expectedSlugs: ["gebetanche-gaz"],
    forbiddenSlugs: ["detecteur-gaz", "graisse-robinet-gaz", "gebsoplast"],
    intent: "sealing_assembly",
  },
  {
    id: "pate-joint-metal-evacuation-pression",
    locale: "fr",
    theme: "piscine",
    audience: "professional",
    query: "Quelle pâte à joint pour le métal ? (milieu au contact: évacuation sous pression)\névacuation sous pression",
    fluid: "eau",
    expectedSlugs: ["gebetanche"],
    forbiddenSlugs: ["gebsoplast", "detecteur", "colle"],
    intent: "sealing_assembly",
  },
  {
    id: "silicone-seche-rapide-chrono",
    locale: "fr",
    theme: "plomberie",
    audience: "professional",
    query: "Quel silicone est le plus rapide à sécher\nil existe chez geb des silicone 60 chrono",
    expectedSlugs: ["silicone-60min-chrono"],
    forbiddenSlugs: ["silicone-bain-cuisine", "graisse-silicone"],
    intent: "product_info",
  },
  {
    id: "gouttiere-fissure-zinc-ms-zinc",
    locale: "fr",
    theme: "batiment",
    audience: "professional",
    query:
      "fissure sur gouttiere qui fuit 5cm zinc quel produit et le MS ZINC t'en penses quoi",
    expectedSlugs: ["ms-zinc"],
    forbiddenSlugs: ["geborizon-silicone-sanitaire"],
    intent: "leak_repair",
  },
  {
    id: "raccord-filete-inaccessible-eau-potable-particulier",
    locale: "fr",
    theme: "plomberie",
    audience: "particulier",
    query:
      "j'ai un raccord fileté difficilement accessible quel produit me recommandes tu pour faire mon raccord facilement eau potable",
    fluid: "eau",
    expectedSlugs: ["gebetanche-eau-potable", "resine-detancheite-tous-fluides"],
    forbiddenSlugs: ["pool-filetplast", "pool-gebsoblue", "colle-haute-performance"],
    intent: "sealing_assembly",
  },
  {
    id: "robinet-mousseur-fuite",
    locale: "fr",
    theme: "plomberie",
    audience: "particulier",
    query: "mon robinet fuit au niveau du mousseur",
    expectedSlugs: ["filasse", "ptfe", "graisse-robinet", "olifan"],
    forbiddenSlugs: ["g80-degraissant-bruleur-2", "suif", "nettoyant-mousse-pu-2en1"],
    intent: "leak_repair",
  },
  {
    id: "plomberie-odeur-canalisation-nl",
    locale: "nl",
    theme: "plomberie",
    audience: "particulier",
    query: "mijn afvoeren ruiken slecht welk product kan ik gebruiken",
    expectedSlugs: ["ontstopper-geurverwijderaar", "ontstopper-universeel", "universele-ontstopper"],
    forbiddenSlugs: ["pool-bande-abrasive", "pistolet-stop-goutte"],
    intent: "general_technical",
  },
  {
    id: "chauffage-descaling-plate-exchanger",
    locale: "fr",
    theme: "chauffage",
    audience: "professional",
    query:
      "detartrer echangeur a plaque eau sanitaire aluminium detartrans g60 ou g61 sous pression",
    expectedSlugs: ["g60-detartrant-2", "g61-detartrant-s-emploie-avec-pompe"],
    forbiddenSlugs: ["collafeu-2", "propfeu-tresse-extensible-fibre-de-verre", "calorygeb"],
    intent: "general_technical",
  },
  {
    id: "chauffage-inhibiteur-universel-followup",
    locale: "fr",
    theme: "chauffage",
    audience: "professional",
    query:
      "je souhaite proteger mon plancher chauffant apres un desembouage\nje cherche un produit plus universel",
    fluid: "chauffage",
    expectedSlugs: ["g110-inhibiteur-universel"],
    forbiddenSlugs: ["inhibiteur-g1", "filasse", "gebetanche"],
    intent: "product_info",
  },
  {
    id: "chauffage-fiche-technique-g110-inhibiteur",
    locale: "fr",
    theme: "chauffage",
    audience: "professional",
    query: "je veux la fiche technique du g110 inhibiteur universel",
    expectedSlugs: ["g110-inhibiteur-universel"],
    forbiddenSlugs: ["collafeu-2", "propfeu-plaque-isolante-alu", "propfeu-colle-refractaire-isolant-cheminee"],
    intent: "product_info",
  },
  {
    id: "chauffage-fiche-technique-g30-desembouant",
    locale: "fr",
    theme: "chauffage",
    audience: "professional",
    query: "fiche technique g30 desembouant",
    expectedSlugs: ["g30-desembouant-2"],
    forbiddenSlugs: ["collafeu-2", "g110-inhibiteur-universel"],
    intent: "product_info",
  },
  {
    id: "plomberie-fiche-technique-gebsoplast",
    locale: "fr",
    theme: "plomberie",
    audience: "professional",
    query: "je veux la fiche technique gebsoplast",
    expectedSlugs: ["gebsoplast"],
    forbiddenSlugs: ["colle-haute-performance"],
    intent: "product_info",
  },
  {
    id: "plomberie-fiche-technique-silicone-chrono",
    locale: "fr",
    theme: "plomberie",
    audience: "professional",
    query: "fiche technique silicone 60 chrono",
    expectedSlugs: ["silicone-60min-chrono"],
    forbiddenSlugs: ["silicone-bain-cuisine", "graisse-silicone"],
    intent: "product_info",
  },
  {
    id: "batiment-fiche-technique-ms-zinc",
    locale: "fr",
    theme: "batiment",
    audience: "professional",
    query: "je veux la fiche technique du ms zinc",
    expectedSlugs: ["ms-zinc"],
    forbiddenSlugs: ["geborizon-silicone-sanitaire", "collafeu-2"],
    intent: "product_info",
  },
  {
    id: "automobile-fiche-technique-collex-echappement",
    locale: "fr",
    theme: "automobile",
    audience: "professional",
    query: "fiche technique pate montage echappement collex",
    expectedSlugs: ["pate-de-montage-echappement-collex"],
    forbiddenSlugs: ["startex-demarre-moteur-collex", "kit-etancheite-eau-potable"],
    intent: "product_info",
  },
  {
    id: "piscine-kit-reparation-liner-explicite",
    locale: "fr",
    theme: "piscine",
    audience: "particulier",
    query:
      "mon chat a griffé ma piscine autoportée micro fuite\net que pense tu du kit réparation liner\nje veux le pool kit réparation liner",
    expectedSlugs: ["pool-kit-de-reparation-liner"],
    forbiddenSlugs: ["detection-fuite-piscine", "pool-gebsoblue"],
    intent: "leak_repair",
  },
  {
    id: "piscine-fuite-canalisation-enterree-colmateur",
    locale: "fr",
    theme: "piscine",
    audience: "particulier",
    query:
      "ma piscine perd de l'eau fuite canalisation enterrée je n'ai pas acces aux canalisations je pensais au POOL COLMATEUR DE FUITES",
    expectedSlugs: ["pool-colmateur-de-fuites", "pool-lekdichter", "g41-colmateur-universel-des-micro-fuites"],
    forbiddenSlugs: ["pool-mastic-piscine", "gebetanche-eau-potable-rt1-geb", "pool-gebsoblue-pro-2"],
    intent: "inaccessible_leak",
  },
  {
    id: "pate-joint-eau-potable-nom-produit",
    locale: "fr",
    theme: "maintenance",
    audience: "particulier",
    query: "je cherche une pate a joint pour eau potable",
    fluid: "eau",
    expectedSlugs: ["pate-a-joint-eau-potable"],
    forbiddenSlugs: ["gebsoplast", "detecteur-gaz", "colle-haute-performance"],
    intent: "sealing_assembly",
  },
  {
    id: "gourde-fuite-hors-plomberie",
    locale: "fr",
    theme: "plomberie",
    audience: "particulier",
    query: "ma gourde pour boire fuit fissure plastique dur exterieur uniquement eau potable",
    expectNoProducts: true,
    expectedSlugs: [],
    forbiddenSlugs: [
      "gebetanche-eau-potable-rt1-geb",
      "pate-a-joint-eau-potable",
      "resine-detancheite-tous-fluides-special-eau-potable",
    ],
    intent: "general_technical",
  },
];

/** Conversational product citations (e.g. « que pensez-vous du G110 ? ») — lookupCatalogProductsByCitation. */
export const CITATION_REGRESSION_CASES: Array<{
  id: string;
  locale: "fr" | "nl" | "pl";
  query: string;
  expectedSlugs: string[];
  forbiddenSlugs?: string[];
  audience?: Audience | null;
}> = [
  {
    id: "chauffage-citation-g110-opinion",
    locale: "fr",
    query: "et que pense tu du g110",
    expectedSlugs: ["g110-inhibiteur-universel"],
    forbiddenSlugs: ["inhibiteur-g1"],
    audience: "particulier",
  },
  {
    id: "chauffage-citation-g110-inhibiteur",
    locale: "fr",
    query: "le g110 inhibiteur universel c est bien pour un plancher chauffant ?",
    expectedSlugs: ["g110-inhibiteur-universel"],
    forbiddenSlugs: ["inhibiteur-g1", "g10-inhibitor"],
    audience: "particulier",
  },
  {
    id: "plomberie-citation-deboucheur-universel-nl",
    locale: "nl",
    query: "bestaat er een deboucheur universel?",
    expectedSlugs: ["ontstopper-universeel", "universele-ontstopper"],
    forbiddenSlugs: ["g110-inhibiteur-universel"],
    audience: "particulier",
  },
];
