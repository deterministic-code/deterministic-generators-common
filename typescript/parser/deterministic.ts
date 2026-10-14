import type {
  DatasourceTable,
  ParsedRoutes,
  ParsedServices,
  SeedRow,
  Type,
} from "./specification.ts";

/** Parsed deterministic YAML. One parse, then properties for each document. */
export type IDeterministic = {
  types: Type[];
  expandedTypes: Type[];
  datasource: DatasourceTable[];
  datasourceSeeds: Map<string, SeedRow[]>;
  services: ParsedServices;
  routes: ParsedRoutes;
};

export class Deterministic implements IDeterministic {
  readonly types: Type[];
  readonly expandedTypes: Type[];
  readonly datasource: DatasourceTable[];
  readonly datasourceSeeds: Map<string, SeedRow[]>;
  readonly services: ParsedServices;
  readonly routes: ParsedRoutes;

  constructor(args: IDeterministic) {
    this.types = args.types;
    this.expandedTypes = args.expandedTypes;
    this.datasource = args.datasource;
    this.datasourceSeeds = args.datasourceSeeds;
    this.services = args.services;
    this.routes = args.routes;
  }
}
