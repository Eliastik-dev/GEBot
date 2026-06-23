import fs from "node:fs";
const fp = "c:/Projets/geb-chatbot/backend/src/modules/chat/run-retrieval-pipeline.ts";
let text = fs.readFileSync(fp, "utf8");
const fixed = `    ctx.fullQuery = \`\${buildSystemPrompt(
      locale,
      ctx.audience,
      ctx.history,
      ctx.disallowFrenchStandards,
      ctx.extractedMeta,
      ctx.retrievalPath,
      ctx.goldenExamples,
      { geoCountry: ctx.effectiveGeoCountry, geoConsent: ctx.effectiveGeoConsent },
      ctx.negativeExamples,
      ctx.ongoingConversation,
      ctx.productFollowUp && ctx.priorRecommendedProduct ? { priorProduct: ctx.priorRecommendedProduct } : null,
      ctx.comparisonEligible
        ? { eligible: true, productCount: ctx.pkResolvedProducts.length }
        : null,
    )}\${ctx.catalogAnchorReminder}

METADATA_PROFIL: \${toAudienceLabel(ctx.audience)}
LOCALE_SESSION: \${locale}
FLUID_TYPE: \${ctx.fluid ?? "inconnu"}
SEARCH_QUERY: \${ctx.searchQuery}
RETRIEVAL_PATH: \${ctx.retrievalPath}
FICHES_TECHNIQUES_PDF (use ONLY in "Documentation Officielle" section, NEVER as purchase/availability links):
\${ctx.sourceUrls.length > 0 ? ctx.sourceUrls.map((url) => \`- \${url}\`).join("\\n") : "- aucune"}

QUESTION UTILISATEUR: \${ctx.queryForRetrieval}
\${ctx.productFollowUp && ctx.priorRecommendedProduct ? \`\\nTYPE_QUESTION: product_follow_up — MODE 1 OBLIGATOIRE. Produit déjà conseillé : \${ctx.priorRecommendedProduct}. Réponds UNIQUEMENT à la nouvelle question en prose courte ; ne répète PAS la fiche produit ni les liens FT/FDS.\` : ""}
\${isFactualProductQuestion(ctx.citationScanText) && ctx.hasCatalogCitation ? "\\nTYPE_QUESTION: factual_product — MODE 1: répondez factuellement (oui/non, limites) depuis FT/FDS du produit identifié. Ne pivotez pas vers un autre SKU." : ""}
\${!ctx.productFollowUp && !isFactualProductQuestion(ctx.citationScanText) && !ctx.hasCatalogCitation && isInformationalProductQuestion(ctx.queryForRetrieval) ? "\\nTYPE_QUESTION: informational_faq — MODE 1: réponds DIRECTEMENT à la question en prose naturelle avec les faits de la fiche." : ""}
\${ctx.hasCatalogCitation && !isFactualProductQuestion(ctx.citationScanText) ? "\\nTYPE_QUESTION: cited_product — MODE 2 sur le produit catalogue identifié (profil/domaine ignorés si la fiche correspond)." : ""}
\${ctx.comparisonEligible ? \`\\nTYPE_QUESTION: open_recommendation_comparison — MODE 3 OBLIGATOIRE. \${ctx.pkResolvedProducts.length} produits catalogue récupérés : comparez-les (Option A/B\${ctx.pkResolvedProducts.length >= 3 ? "/C" : ""}) avec Avantages et Limites issus des champs catalogue ; ne recommandez pas un seul SKU.\` : ""}
\${formatNamedProductCitationPrompt(ctx.citationScanText, ctx.catalogCitation.best?.canonical_name)}

RAPPEL_DIAGNOSTIC: Les extraits peuvent melanger fiches techniques (TDS / limites d'application: pression, fluides, temperatures) et fiches de securite (SDS ou FDS / compatibilite chimique, dangers). Croiser les deux familles de documents uniquement lorsque leurs contenus sont presents dans les extraits ci-dessous.

Instruction finale: reponse courte ; cite au plus une URL source du contexte si disponible (lien seul, sans paragraphe sur la citation).\`;`;

const start = text.indexOf("    ctx.fullQuery = ");
const end = text.indexOf("Instruction finale:", start);
if (start === -1 || end === -1) throw new Error("not found");
const endTick = text.indexOf("`;", end);
text = text.slice(0, start) + fixed + text.slice(endTick + 2);
fs.writeFileSync(fp, text);
console.log("patched fullQuery block");
