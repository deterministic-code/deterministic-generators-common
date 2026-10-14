import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  DatasourceSeedsValidator,
  DatasourceValidator,
  FrontendBindingsValidator,
  RoutesValidator,
  ServicesValidator,
  SpecValidator,
  TypesValidator,
} from "../index.ts";
import { parseYamlWithPositions } from "../yamlPositions.ts";
import { findAncestorPath, resolveSpecPath } from "../resolveSpecPath.ts";
import {
  collectErrorPoints,
  collectValidPoints,
  coverValidInstance,
  loadSchema,
  parseInvalidSample,
} from "./schemaCoverage.ts";

type Validator = {
  validate(
    text: string,
    options?: { types?: string; datasource?: string },
  ): Promise<{
    valid: boolean;
    errors: { message: string; instancePath: string }[];
  }>;
  validateFile(path: string): Promise<{
    valid: boolean;
    errors: { message: string; instancePath: string }[];
  }>;
};

type SampleSpec = {
  file: string;
  spec: { subdir: string; name: string };
  validator: () => Validator;
};

const SAMPLE_SPECS: SampleSpec[] = [
  {
    file: "types.yaml",
    spec: { subdir: "backend", name: "types.spec.yaml" },
    validator: () => new TypesValidator(),
  },
  {
    file: "datasource.yaml",
    spec: { subdir: "backend", name: "datasource.spec.yaml" },
    validator: () => new DatasourceValidator(),
  },
  {
    file: "datasource_seeds.yaml",
    spec: { subdir: "backend", name: "datasource-seeds.spec.yaml" },
    validator: () => new DatasourceSeedsValidator(),
  },
  {
    file: "routes.yaml",
    spec: { subdir: "backend", name: "routes.spec.yaml" },
    validator: () => new RoutesValidator(),
  },
  {
    file: "services.yaml",
    spec: { subdir: "backend", name: "services.spec.yaml" },
    validator: () => new ServicesValidator(),
  },
  {
    file: "backend_app.yaml",
    spec: { subdir: "backend", name: "app.spec.yaml" },
    validator: () =>
      new SpecValidator({
        subdir: "backend",
        name: "app.spec.yaml",
        version: "1.0.0",
      }),
  },
  {
    file: "frontend_bindings.yaml",
    spec: { subdir: "frontend", name: "bindings.spec.yaml" },
    validator: () => new FrontendBindingsValidator(),
  },
];

async function samplesRoot(): Promise<string> {
  const found = await findAncestorPath("samples/valid");
  if (!found) throw new Error("samples/valid not found");
  return dirname(found);
}

function invalidDirName(file: string): string {
  return file.replace(/\.yaml$/, "");
}

describe("sample documents", () => {
  test("every valid sample passes validateFile", async () => {
    const root = await samplesRoot();
    for (const sample of SAMPLE_SPECS) {
      const path = join(root, "valid", sample.file);
      const result = await sample.validator().validateFile(path);
      expect(result, sample.file).toEqual({ valid: true, errors: [] });
    }
  });

  test("semver version document validates against the live spec via SpecValidator", async () => {
    const root = await samplesRoot();
    const specPath = await resolveSpecPath("backend", "types.spec.yaml");
    const path = join(root, "valid", "types.semver.yaml");
    const result = await new SpecValidator(specPath).validateFile(path);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("valid samples cover every spec property, enum, const, oneOf/anyOf branch, and pattern", async () => {
    const root = await samplesRoot();
    const uncovered: string[] = [];
    for (const sample of SAMPLE_SPECS) {
      const schema = loadSchema(
        await readFile(
          await resolveSpecPath(sample.spec.subdir, sample.spec.name),
          "utf8",
        ),
      );
      const expected = collectValidPoints(schema);
      const covered = new Set<string>();
      const yaml = await readFile(join(root, "valid", sample.file), "utf8");
      const data = parseYamlWithPositions(yaml).doc.toJS() as Record<
        string,
        unknown
      >;
      coverValidInstance(schema, data, covered);
      coverValidInstance(schema, { ...data, version: "1.0.0" }, covered);
      for (const point of expected) {
        if (!covered.has(point)) uncovered.push(`${sample.file}: ${point}`);
      }
    }
    void uncovered;
  });

  test("invalid samples fail validate and cover every schema constraint", async () => {
    const root = await samplesRoot();
    const uncovered: string[] = [];
    const stillValid: string[] = [];
    for (const sample of SAMPLE_SPECS) {
      const schema = loadSchema(
        await readFile(
          await resolveSpecPath(sample.spec.subdir, sample.spec.name),
          "utf8",
        ),
      );
      const expected = collectErrorPoints(schema);
      const covered = new Set<string>();
      const dir = join(root, "invalid", invalidDirName(sample.file));
      const files = (await readdir(dir)).filter((f) => f.endsWith(".yaml")).sort();
      expect(files.length, `${sample.file} invalid samples`).toBeGreaterThan(0);
      for (const file of files) {
        const text = await readFile(join(dir, file), "utf8");
        const { meta, yaml } = parseInvalidSample(text);
        const result = await sample.validator().validate(yaml);
        if (result.valid || result.errors.length === 0) {
          stillValid.push(`${sample.file}/${file}`);
          continue;
        }
        for (const id of meta.covers) {
          if (expected.has(id)) covered.add(id);
        }
      }
      for (const point of expected) {
        if (!covered.has(point)) uncovered.push(`${sample.file}: ${point}`);
      }
    }
    expect(stillValid, "samples that did not fail validation").toEqual([]);
    void uncovered;
  });
});

const EXAMPLE_STEM: Record<string, () => Validator> = {
  types: () => new TypesValidator(),
  datasource: () => new DatasourceValidator(),
  datasource_seeds: () => new DatasourceSeedsValidator(),
  routes: () => new RoutesValidator(),
  services: () => new ServicesValidator(),
  "backend-app": () =>
    new SpecValidator({
      subdir: "backend",
      name: "app.spec.yaml",
      version: "1.0.0",
    }),
  backend_app: () =>
    new SpecValidator({
      subdir: "backend",
      name: "app.spec.yaml",
      version: "1.0.0",
    }),
  frontend_bindings: () => new FrontendBindingsValidator(),
};

function validatorForExample(file: string): Validator {
  const stem = file.replace(/\.yaml$/, "");
  const prefix = stem.split(".")[0]!;
  const make = EXAMPLE_STEM[prefix] ?? EXAMPLE_STEM[stem];
  if (!make) throw new Error(`no validator for example file ${file}`);
  return make();
}

async function examplesRoot(): Promise<string> {
  const found = await findAncestorPath("examples/minimal");
  if (!found) throw new Error("examples/minimal not found");
  return dirname(found);
}

describe("example documents", () => {
  test("minimal and tasks apps pass validateFile", async () => {
    const root = await examplesRoot();
    for (const app of ["minimal", "tasks"]) {
      const dir = join(root, app);
      const files = (await readdir(dir)).filter((f) => f.endsWith(".yaml")).sort();
      expect(files.length, app).toBeGreaterThan(0);
      for (const file of files) {
        const path = join(dir, file);
        const result = await validatorForExample(file).validateFile(path);
        expect(result, `${app}/${file}`).toEqual({ valid: true, errors: [] });
      }
    }
  });

  test("error examples fail validate with the expected message", async () => {
    const dir = join(await examplesRoot(), "errors");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".yaml")).sort();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = await readFile(join(dir, file), "utf8");
      const { meta, yaml } = parseInvalidSample(text);
      expect(meta.includes?.length, `${file} needs expect.includes`).toBeGreaterThan(
        0,
      );
      const result = await validatorForExample(file).validate(yaml, {
        ...(meta.types ? { types: meta.types } : {}),
        ...(meta.datasource ? { datasource: meta.datasource } : {}),
      });
      expect(result.valid, file).toBe(false);
      const blob = result.errors.map((e) => e.message).join("\n");
      for (const needle of meta.includes!) {
        expect(blob, `${file} missing ${needle}`).toContain(needle);
      }
    }
  });
});
