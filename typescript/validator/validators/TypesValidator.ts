import { SpecValidator } from "../SpecValidator.ts";
import { checkFieldDefaultSemantics } from "../fieldDefaultSemantics.ts";
import { checkTypeModel } from "../typeModelSemantics.ts";
import {
  checkIncludeCycles,
  withIncludeFilePath,
} from "../includeSemantics.ts";
import { checkIncludeFilters } from "../includeFilter.ts";

/**
 * Live engine for `types.yaml`: JSON Schema first, then default_value
 * tokens/ranges, then inherit/union/reference checks, then include
 * filters and `file:` cycles.
 */
export class TypesValidator extends SpecValidator {
  constructor() {
    super(
      {
        subdir: "backend",
        name: "types.spec.yaml",
      },
      [
        checkFieldDefaultSemantics,
        checkTypeModel,
        checkIncludeFilters,
        checkIncludeCycles,
      ],
      withIncludeFilePath,
    );
  }
}
