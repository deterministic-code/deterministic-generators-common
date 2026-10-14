import { SpecValidator } from "../SpecValidator.ts";
import {
  checkIncludeCycles,
  withIncludeFilePath,
} from "../includeSemantics.ts";
import { checkRouteModel } from "../routeModelSemantics.ts";
import { checkIncludeFilters } from "../includeFilter.ts";

/**
 * Live engine for `routes.yaml`: JSON Schema first, then unique route names
 * and exclusive custom-route dispatch, then a walk of `file:` includes.
 */
export class RoutesValidator extends SpecValidator {
  constructor() {
    super(
      {
        subdir: "backend",
        name: "routes.spec.yaml",
      },
      [checkRouteModel, checkIncludeFilters, checkIncludeCycles],
      withIncludeFilePath,
    );
  }
}
