/** Minimal env so modules that import config/env.ts load during tests. */
process.env.MISTRAL_API_KEY ??= "test-mistral-key";
process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-supabase-service-role";
process.env.WP_URL ??= "https://www.geb.fr";
process.env.NODE_ENV ??= "test";
export {};
//# sourceMappingURL=vitest.setup.js.map