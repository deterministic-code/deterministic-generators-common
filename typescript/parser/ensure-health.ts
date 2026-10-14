import { Deterministic, type IDeterministic } from "./deterministic.ts";
import type {
  CustomRouteEntry,
  CustomServiceEntry,
} from "./specification.ts";

export const HEALTH_SERVICE_NAME = "HealthCheckService";
export const HEALTH_SERVICE_METHOD = "check";
export const HEALTH_ROUTE_NAME = "getHealth";
export const HEALTH_ROUTE_PATH = "/api/health";

const seedService = (): CustomServiceEntry => ({
  name: HEALTH_SERVICE_NAME,
  methods: [HEALTH_SERVICE_METHOD],
});

const seedRoute = (): CustomRouteEntry => ({
  name: HEALTH_ROUTE_NAME,
  path: HEALTH_ROUTE_PATH,
  method: "GET",
  entity: null,
});

const prepend = <T>(
  list: T[],
  match: (item: T) => boolean,
  seed: T,
): T[] => {
  const idx = list.findIndex(match);
  if (idx === 0) return [...list];
  if (idx > 0) {
    return [list[idx]!, ...list.slice(0, idx), ...list.slice(idx + 1)];
  }
  return [seed, ...list];
};

/** Product default: HealthCheckService + GET /api/health first in customs. */
export const ensureHealth = (deterministic: IDeterministic): IDeterministic =>
  new Deterministic({
    ...deterministic,
    services: {
      ...deterministic.services,
      customs: prepend(
        deterministic.services.customs,
        (s) => s.name === HEALTH_SERVICE_NAME,
        seedService(),
      ),
    },
    routes: {
      ...deterministic.routes,
      customs: prepend(
        deterministic.routes.customs,
        (r) => r.path === HEALTH_ROUTE_PATH,
        seedRoute(),
      ),
    },
  });
