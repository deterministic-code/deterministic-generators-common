import { SpecValidator, type ParsedYaml } from "../SpecValidator.ts";
import type { SpecValidationResult, ValidateOptions } from "../types.ts";
import { parseYamlWithPositions } from "../yamlPositions.ts";
import {
  checkSeedSemantics,
  companionError,
  seedsNeedCompanions,
  withSiblingCompanions,
} from "../seedSemantics.ts";

const MISSING_TYPES =
  "types.yaml is required to validate seeds (pass types, or place types.yaml next to the seeds file)";

async function checkSeeds(
  parsed: ParsedYaml,
  options?: ValidateOptions,
): Promise<SpecValidationResult> {
  const typesText = options?.types;
  const datasourceText = options?.datasource;
  if (typesText === undefined) {
    if (!seedsNeedCompanions(parsed.data)) return { valid: true, errors: [] };
    return companionError(parsed, MISSING_TYPES);
  }

  const typesValidator = new SpecValidator({
    subdir: "backend",
    name: "types.spec.yaml",
  });
  const typesResult = await typesValidator.validate(typesText);
  if (!typesResult.valid) {
    return companionError(
      parsed,
      `companion types.yaml is invalid: ${typesResult.errors[0]?.message}`,
    );
  }

  if (datasourceText !== undefined) {
    const datasourceValidator = new SpecValidator({
      subdir: "backend",
      name: "datasource.spec.yaml",
    });
    const datasourceResult = await datasourceValidator.validate(datasourceText);
    if (!datasourceResult.valid) {
      return companionError(
        parsed,
        `companion datasource.yaml is invalid: ${datasourceResult.errors[0]?.message}`,
      );
    }
  }

  return checkSeedSemantics(
    parsed,
    parseYamlWithPositions(typesText).doc.toJS(),
    datasourceText !== undefined
      ? parseYamlWithPositions(datasourceText).doc.toJS()
      : undefined,
  );
}

/**
 * Live engine for `datasource_seeds.yaml`: JSON Schema first, then
 * semantic checks against companion `types.yaml` and `datasource.yaml`.
 */
export class DatasourceSeedsValidator extends SpecValidator {
  constructor() {
    super(
      {
        subdir: "backend",
        name: "datasource-seeds.spec.yaml",
      },
      checkSeeds,
      withSiblingCompanions,
    );
  }
}
