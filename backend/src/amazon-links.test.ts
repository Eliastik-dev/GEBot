import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAmazonLinksFromJson, resolveAmazonLinksDataDir } from "./amazon-links.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadAmazonLinksFromJson", () => {
  it("loads locale files from a data directory", () => {
    const dir = path.join(process.cwd(), `data-test-${Date.now()}`);
    tempDirs.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "amazon-links.fr.json"),
      JSON.stringify({ "geb test": "https://www.amazon.fr/dp/123", "ref_geb:42": "https://www.amazon.fr/dp/456" }),
    );
    writeFileSync(path.join(dir, "amazon-links.nl.json"), JSON.stringify({}));

    const links = loadAmazonLinksFromJson(dir);
    expect(links.fr["geb test"]).toBe("https://www.amazon.fr/dp/123");
    expect(links.fr["ref_geb:42"]).toBe("https://www.amazon.fr/dp/456");
    expect(links.nl).toEqual({});
  });

  it("returns empty maps when files are missing", () => {
    const dir = path.join(process.cwd(), `data-missing-${Date.now()}`);
    tempDirs.push(dir);
    mkdirSync(dir, { recursive: true });

    const links = loadAmazonLinksFromJson(dir);
    expect(links.fr).toEqual({});
    expect(links.nl).toEqual({});
  });
});

describe("resolveAmazonLinksDataDir", () => {
  it("defaults to backend/data when unset", () => {
    const resolved = resolveAmazonLinksDataDir("");
    expect(resolved.endsWith(path.join("backend", "data")) || resolved.endsWith(path.join("data"))).toBe(true);
  });
});
