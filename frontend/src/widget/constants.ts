import type { ProductTheme } from "./types.js";

export const THEME_KEYS = [
  "plomberie",
  "piscine",
  "chauffage",
  "batiment",
  "maintenance",
  "automobile",
  "eco-conception",
] as const satisfies readonly Exclude<ProductTheme, null>[];
