/**
 * Migration script: re-tag vector chunks with theme from metadata + PDF heuristics / WP gamme.
 * Usage: npx tsx src/cli/migrate-themes.ts
 */

import { env } from "../config/env.js";
import { supabase } from "../config/supabase.js";
import { resolveProductTheme } from "../services/wp-catalog-theme.service.js";

async function run(): Promise<void> {
  const BATCH_SIZE = 500;
  let offset = 0;
  let totalUpdated = 0;
  const themeCounts: Record<string, number> = {};
  const sourceCounts: Record<string, number> = {};

  console.log(`Starting theme migration on table: ${env.SUPABASE_TABLE}`);

  while (true) {
    const { data: rows, error } = await supabase
      .from(env.SUPABASE_TABLE)
      .select("id, content, metadata")
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) {
      console.error("Error fetching rows:", error);
      break;
    }

    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      const metadata = (row.metadata ?? {}) as Record<string, unknown>;
      const title = (metadata.title as string) ?? "";
      const content = (row.content as string) ?? "";
      const wpSlugs = Array.isArray(metadata.wp_product_cat_slugs)
        ? (metadata.wp_product_cat_slugs as string[])
        : [];
      const wpNames = Array.isArray(metadata.wp_product_cat_names)
        ? (metadata.wp_product_cat_names as string[])
        : [];

      const resolved = resolveProductTheme({
        title,
        content,
        gamme_officielle: (metadata.gamme_officielle as string) ?? null,
        wp_product_cat_slugs: wpSlugs,
        wp_product_cat_names: wpNames,
      });

      const updatedMetadata = {
        ...metadata,
        theme: resolved.theme,
        theme_source: resolved.theme_source,
        gamme_officielle: resolved.gamme_officielle ?? metadata.gamme_officielle ?? "",
        wp_product_cat_slugs: resolved.wp_product_cat_slugs.length > 0
          ? resolved.wp_product_cat_slugs
          : wpSlugs,
      };

      const { error: updateError } = await supabase
        .from(env.SUPABASE_TABLE)
        .update({ metadata: updatedMetadata })
        .eq("id", row.id);

      if (updateError) {
        console.warn(`Failed to update row ${row.id}:`, updateError.message);
        continue;
      }

      totalUpdated += 1;
      themeCounts[resolved.theme] = (themeCounts[resolved.theme] ?? 0) + 1;
      sourceCounts[resolved.theme_source] = (sourceCounts[resolved.theme_source] ?? 0) + 1;
    }

    console.log(`Processed ${offset + rows.length} rows (${totalUpdated} updated so far)...`);
    if (rows.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }

  console.log("\nMigration complete!");
  console.log(`Total documents updated: ${totalUpdated}`);
  console.log("Distribution by theme:");
  for (const [theme, count] of Object.entries(themeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${theme}: ${count}`);
  }
  console.log("Theme source:");
  for (const [src, count] of Object.entries(sourceCounts)) {
    console.log(`  ${src}: ${count}`);
  }
}

run().catch((error: unknown) => {
  console.error("Migration error:", error);
  process.exitCode = 1;
});
