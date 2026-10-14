# @deterministic-code/deterministic-specifications

Shared TypeScript validation engine for the deterministic YAML contract. AJV
(draft 2020-12) compilation and source-position mapping live here so every
error reports `{ line, col }`. One live engine per spec lives in
[`validators/`](./validators/). Documents still declare a semver `version:`
because the JSON Schema requires it; that field is not used to pick an
engine.

```ts
import { TypesValidator } from "@deterministic-code/deterministic-specifications";

const validator = new TypesValidator();

const fromText = await validator.validate(yamlString);
const fromFile = await validator.validateFile("deterministic/types.yaml");

// { valid: boolean, errors: [{ line, col, instancePath, message }] }
```

Integration samples live in the [deterministic-specifications](https://github.com/deterministic-code/deterministic-specifications) repo under [`samples/`](https://github.com/deterministic-code/deterministic-specifications/tree/main/samples). Valid
kitchen-sink documents must exercise every spec property, enum, const, oneOf
branch, and pattern. Invalid documents (regenerated with
`npm run generate:invalid-samples`) must fail `validate()` and together hit
every independently observable schema constraint. Readable apps and a small
error gallery live under [`examples/`](https://github.com/deterministic-code/deterministic-specifications/tree/main/examples).

## Validators

| Class                       | Contract file                  |
| --------------------------- | ------------------------------ |
| `TypesValidator`            | `backend/types.spec.yaml` |
| `DatasourceValidator`       | `backend/datasource.spec.yaml` |
| `DatasourceSeedsValidator`  | `backend/datasource-seeds.spec.yaml` |
| `RoutesValidator`           | `backend/routes.spec.yaml`     |
| `RoutesApiValidator`        | `backend/routes-api.spec.yaml` |
| `ServicesValidator`         | `backend/services.spec.yaml`   |
| `FrontendBindingsValidator` | `frontend/bindings.spec.yaml`  |

Each exposes two methods:

- `validate(text: string)` — validate an in-memory YAML string.
- `validateFile(path: string)` — read a file from disk, then validate it.

Construct `SpecValidator` with `{ subdir, name }` to resolve the live spec,
or with an absolute path to validate against a spec that lives outside this
package.

This package validates **schema shape** first. `TypesValidator` then
checks `default_value` tokens and integer ranges against
[`backend/types.yaml`](https://github.com/deterministic-code/deterministic-specifications/blob/main/backend/types.yaml). `DatasourceSeedsValidator`
checks seed rows against companion `types.yaml` (field types) and
`datasource.yaml` (which types are tables). Other
cross-document rules (foreign-key resolution, merged includes) stay in the
consuming generator.
