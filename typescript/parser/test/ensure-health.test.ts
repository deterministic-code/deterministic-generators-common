import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  ensureHealth,
  HEALTH_ROUTE_NAME,
  HEALTH_ROUTE_PATH,
  HEALTH_SERVICE_METHOD,
  HEALTH_SERVICE_NAME,
} from "../ensure-health.ts";
import { Deterministic, type IDeterministic } from "../deterministic.ts";

const empty = (): IDeterministic =>
  new Deterministic({
    types: [],
    expandedTypes: [],
    datasource: [],
    datasourceSeeds: new Map(),
    services: { generics: [], customs: [] },
    routes: {
      candidates: [],
      customs: [],
      nested: [],
      childrenOnly: new Set(),
      datasource: [],
    },
  });

describe("ensureHealth", () => {
  it("seeds HealthCheckService and GET /api/health without a module", () => {
    const seeded = ensureHealth(empty());
    assert.deepEqual(seeded.services.customs, [
      { name: HEALTH_SERVICE_NAME, methods: [HEALTH_SERVICE_METHOD] },
    ]);
    assert.equal(seeded.services.customs[0]?.module, undefined);
    assert.deepEqual(seeded.routes.customs, [
      {
        name: HEALTH_ROUTE_NAME,
        path: HEALTH_ROUTE_PATH,
        method: "GET",
        entity: null,
      },
    ]);
  });

  it("moves an authored health service and path to the front", () => {
    const base = empty();
    const authored = new Deterministic({
      ...base,
      services: {
        generics: [],
        customs: [
          { name: "ReportService", methods: ["run"] },
          {
            name: HEALTH_SERVICE_NAME,
            module: "./services/custom/mine",
            methods: ["probe"],
          },
        ],
      },
      routes: {
        ...base.routes,
        customs: [
          {
            name: "getReport",
            path: "/api/report",
            method: "GET",
            entity: null,
          },
          {
            name: "ready",
            path: HEALTH_ROUTE_PATH,
            method: "GET",
            entity: null,
          },
        ],
      },
    });
    const seeded = ensureHealth(authored);
    assert.deepEqual(
      seeded.services.customs.map((c) => c.name),
      [HEALTH_SERVICE_NAME, "ReportService"],
    );
    assert.equal(seeded.services.customs[0]?.module, "./services/custom/mine");
    assert.deepEqual(seeded.services.customs[0]?.methods, ["probe"]);
    assert.equal(seeded.routes.customs[0]?.name, "ready");
    assert.equal(seeded.routes.customs[1]?.name, "getReport");
  });

  it("is idempotent when health is already first", () => {
    const once = ensureHealth(empty());
    const twice = ensureHealth(once);
    assert.deepEqual(twice.services.customs, once.services.customs);
    assert.deepEqual(twice.routes.customs, once.routes.customs);
  });
});
