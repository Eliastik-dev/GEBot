import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { getHealth } from "./health.controller.js";

function mockRes(): Response {
  const res = {
    body: undefined as unknown,
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response;
}

describe("getHealth", () => {
  it("returns minimal liveness payload without DB access", () => {
    const res = mockRes();
    getHealth({} as Request, res);
    expect(res.body).toMatchObject({ status: "ok", version: expect.any(String) });
    expect(res.body).not.toHaveProperty("commit");
    expect(res.body).not.toHaveProperty("productKnowledgeFr");
  });
});
