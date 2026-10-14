export const FRONTEND_FRAMEWORKS = [
  "vite",
  "next",
  "svelte",
  "angular",
] as const;

export type FrontendFramework = (typeof FRONTEND_FRAMEWORKS)[number];

export type ISettings = {
  readonly applicationName: string;
  readonly frontendFramework: FrontendFramework;
  readonly fullStack: boolean;
  readonly schemaVersion: string;
  readonly simpleDoc: boolean;
  readonly descriptionDoc: boolean;
  readonly createIndex: boolean;
  readonly libraryReferenceMode: string | undefined;
};

const isFrontendFramework = (raw: string): raw is FrontendFramework =>
  (FRONTEND_FRAMEWORKS as readonly string[]).includes(raw);

export const fromSettings = (raw: Record<string, string>): ISettings => {
  const comments = raw["comments"];
  const frontendFramework = raw["frontend_generate_framework"];
  if (
    frontendFramework !== undefined &&
    frontendFramework !== "" &&
    !isFrontendFramework(frontendFramework)
  ) {
    throw new Error(
      `settings.frontend_generate_framework must be ${FRONTEND_FRAMEWORKS.map((name) => JSON.stringify(name)).join(", ")}, got ${JSON.stringify(frontendFramework)}`,
    );
  }
  return {
    applicationName: raw["application_name"] || "generated-frontend",
    frontendFramework:
      frontendFramework === undefined || frontendFramework === ""
        ? "vite"
        : frontendFramework,
    fullStack: raw["application_tier"] === "full-stack",
    schemaVersion: raw["codegen.schema_version"] ?? "1.0",
    simpleDoc: comments !== "none" && comments !== "description",
    descriptionDoc: comments === "description",
    createIndex: raw["codegen.create_index"] !== "false",
    libraryReferenceMode: raw["languages.typescript.library_reference_mode"],
  };
};
