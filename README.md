# deterministic-generators-common

Parser and validators for the [deterministic-specifications](https://github.com/deterministic-code/deterministic-specifications) contract. Each language is its own library. Specs and samples stay in the specifications repo; these libraries only read them.

- [`typescript/`](typescript) — npm package `@deterministic-code/deterministic-generators-common` (`DeterministicParser` and `VersionSnapshot` on the `./parser` export, validators on the package root)
- [`rust/`](rust) — crate `deterministic_generators_common` (path/git dependency)
- [`csharp/`](csharp) — `Deterministic.Generators.Common` (`net10.0` class library)

```toml
# Cargo.toml
deterministic_generators_common = { git = "https://github.com/deterministic-code/deterministic-generators-common", subdirectory = "rust" }
```

```xml
<ProjectReference Include="path/to/deterministic-generators-common/csharp/Deterministic.Generators.Common/Deterministic.Generators.Common.csproj" />
```

TypeScript packs pin `#main`:

```json
"@deterministic-code/deterministic-generators-common": "github:deterministic-code/deterministic-generators-common#main"
```

C# first-party consumers use that `ProjectReference`, not a NuGet `PackageReference`.

```text
npm test                         # TypeScript parser + validator (100% coverage)
sh rust/coverage.sh              # cargo llvm-cov, 100% lines + functions
dotnet test csharp/Deterministic.Generators.Common.slnx --settings csharp/coverlet.runsettings
```

## VersionSnapshot

`VersionSnapshot` reconstructs specification YAML by folding every `deterministic/version-*/diff.yaml` in name order. Documents are the library YAML AST (`YamlValue` / `YamlMap` / `YamlSeq` / `YamlScalar`), not compiled `IDeterministic` and not `DeterministicParser` output.

| API | Role |
| --- | --- |
| `Combine` / `combine` | Fold already-parsed diff trees (mappings), in order |
| `Read` / `read` | Scan a `deterministic/` directory and fold matching version dirs |
| `Documents` / `documents` | Reconstructed file path → tree |
| `Yaml` / `yaml(path)` | Serialize one reconstructed file with the library serializer |

Apply helpers are private instance methods. Version directories must match `^version-\d{8}T\d{6}Z-\d{3}$`. Missing or empty `diff.yaml` is skipped. A non-mapping diff throws `expected a mapping`. TypeScript `read` is async; C# and Rust `Read` are sync.

```csharp
var snapshot = VersionSnapshot.Read(deterministicRoot);
var types = snapshot.Yaml("types.yaml");
var datasource = snapshot.Yaml("datasource.yaml");
```

```typescript
import { VersionSnapshot } from "@deterministic-code/deterministic-generators-common/parser";

const snapshot = await VersionSnapshot.read(deterministicRoot);
const types = snapshot.yaml("types.yaml");
```

```rust
let snapshot = VersionSnapshot::read(deterministic_root)?;
let types = snapshot.yaml("types.yaml")?;
```

`Combine` takes an ordered list of parsed mappings, not YAML strings. To compare a fold to a live file, wrap the live tree as `{ added: true, content }` and compare `Yaml` strings from the same serializer — do not string-compare authored YAML (comments and flow sequences differ).

Per file key in a diff:

- `{ added: true, content }` inserts `content` (`true` or the strings `"true"` / `"True"`).
- `{ removed: true }` deletes the file.
- Object merge: nested apply, `removed:` string list deletes keys, new keys are appended.
- Keyed collections (sequence of single-key maps): `{ added, changed, removed }`. Added entries are prepended.
- Otherwise the next value replaces.

`Read` does not grow `IDeterministicReader`.
