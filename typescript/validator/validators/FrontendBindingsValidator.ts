import { SpecValidator } from "../SpecValidator.ts";

/** Live engine for `frontend/bindings.yaml`. */
export class FrontendBindingsValidator extends SpecValidator {
  constructor() {
    super({
      subdir: "frontend",
      name: "bindings.spec.yaml",
    });
  }
}
