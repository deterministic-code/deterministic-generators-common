import { SpecValidator } from "../SpecValidator.ts";
import { checkRouteModel } from "../routeModelSemantics.ts";

/**
 * Live engine for the routes-api IR: JSON Schema first, then unique
 * route names.
 */
export class RoutesApiValidator extends SpecValidator {
  constructor() {
    super(
      {
        subdir: "backend",
        name: "routes-api.spec.yaml",
      },
      checkRouteModel,
    );
  }
}
