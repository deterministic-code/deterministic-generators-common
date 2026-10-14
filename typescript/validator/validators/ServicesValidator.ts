import { SpecValidator } from "../SpecValidator.ts";
import {
  checkIncludeCycles,
  withIncludeFilePath,
} from "../includeSemantics.ts";
import { checkServiceModel } from "../serviceModelSemantics.ts";
import { checkIncludeFilters } from "../includeFilter.ts";

/**
 * Live engine for `services.yaml`: JSON Schema first, then unique service
 * names, then a walk of `file:` includes.
 */
export class ServicesValidator extends SpecValidator {
  constructor() {
    super(
      {
        subdir: "backend",
        name: "services.spec.yaml",
      },
      [checkServiceModel, checkIncludeFilters, checkIncludeCycles],
      withIncludeFilePath,
    );
  }
}
