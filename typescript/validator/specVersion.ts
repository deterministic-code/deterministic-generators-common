export const VALIDATOR_ENGINES = [
  ["TypesValidator", "backend", "types.spec.yaml"],
  ["DatasourceValidator", "backend", "datasource.spec.yaml"],
  ["DatasourceSeedsValidator", "backend", "datasource-seeds.spec.yaml"],
  ["RoutesValidator", "backend", "routes.spec.yaml"],
  ["RoutesApiValidator", "backend", "routes-api.spec.yaml"],
  ["ServicesValidator", "backend", "services.spec.yaml"],
  ["FrontendBindingsValidator", "frontend", "bindings.spec.yaml"],
] as const;

export type EngineName = (typeof VALIDATOR_ENGINES)[number][0];

export const SPEC_FILES = [
  ...VALIDATOR_ENGINES.map(([, subdir, name]) => ({ subdir, name })),
  { subdir: "backend", name: "app.spec.yaml" },
  { subdir: "backend", name: "field-types.spec.yaml" },
];

export type SpecRef = {
  subdir: string;
  name: string;
};

export function isSpecRef(value: unknown): value is SpecRef {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.subdir === "string" && typeof rec.name === "string";
}
