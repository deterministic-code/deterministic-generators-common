# deterministic-generators-common

Parser and validators for the [deterministic-specifications](https://github.com/deterministic-code/deterministic-specifications) contract. Each language is its own library. Specs and samples stay in the specifications repo; these libraries only read them.

- [`typescript/`](typescript) — npm package `@deterministic-code/deterministic-generators-common` (`DeterministicParser` on the `./parser` export, validators on the package root)
- [`rust/`](rust) — crate `deterministic_generators_common` (path/git dependency)
- [`csharp/`](csharp) — `Deterministic.Generators.Common` (`net10.0` class library)

```toml
# Cargo.toml
deterministic_generators_common = { git = "https://github.com/deterministic-code/deterministic-generators-common", subdirectory = "rust" }
```

```xml
<ProjectReference Include="path/to/deterministic-generators-common/csharp/Deterministic.Generators.Common/Deterministic.Generators.Common.csproj" />
```

```text
npm test                         # TypeScript parser + validator (100% coverage)
sh rust/coverage.sh              # cargo llvm-cov, 100% lines + functions
dotnet test csharp/Deterministic.Generators.Common.slnx --settings csharp/coverlet.runsettings
```
