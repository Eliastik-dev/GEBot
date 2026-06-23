import {
  loadAmazonLinksFromJson,
  type AmazonLinksByLocale,
} from "../modules/commerce/amazon-links.js";
import { env } from "./env.js";

let cachedAmazonLinks: AmazonLinksByLocale | null = null;

/** Lazy-loaded Amazon product URL map (JSON read on first access or at startup). */
export function getAmazonLinksByLocale(): AmazonLinksByLocale {
  if (!cachedAmazonLinks) {
    cachedAmazonLinks = loadAmazonLinksFromJson(env.AMAZON_LINKS_DATA_DIR);
  }
  return cachedAmazonLinks;
}

/** Warm the Amazon links cache during server bootstrap (non-blocking for module graph). */
export function initAmazonLinks(): void {
  getAmazonLinksByLocale();
}
