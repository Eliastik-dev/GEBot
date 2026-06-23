import { afterEach, describe, expect, it, vi } from "vitest";

describe("geolocateIp", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("returns null without calling ipapi.co when GEOLOCATION_ENABLED is false", async () => {
    vi.stubEnv("GEOLOCATION_ENABLED", "false");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const { geolocateIp } = await import("./geolocation.service.js");

    const result = await geolocateIp("8.8.8.8");

    expect(result).toEqual({ countryCode: null });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
