using Xunit;
using Xunit.Abstractions;

namespace Deterministic.Generators.Common.Tests;

public class SampleAcceptanceTests(ITestOutputHelper output)
{
    static readonly (string File, Func<SpecValidator> Make)[] Specs =
    [
        ("types.yaml", () => new TypesValidator()),
        ("datasource.yaml", () => new DatasourceValidator()),
        ("datasource_seeds.yaml", () => new DatasourceSeedsValidator()),
        ("routes.yaml", () => new RoutesValidator()),
        ("services.yaml", () => new ServicesValidator()),
        ("backend_app.yaml", () => new SpecValidator(new SpecRef("backend", "app.spec.yaml"))),
        ("frontend_bindings.yaml", () => new FrontendBindingsValidator()),
    ];

    [Fact]
    public async Task ValidSamplesAndExamples()
    {
        var samples = await SpecPaths.FindAncestorPath("samples/valid");
        Assert.NotNull(samples);
        var root = Path.GetDirectoryName(samples)!;
        var failures = new List<string>();
        foreach (var (file, make) in Specs)
        {
            var path = Path.Combine(root, "valid", file);
            var result = await make().ValidateFile(path);
            if (!result.Valid)
                failures.Add(file + ": " + string.Join(" | ", result.Errors.Select(e => e.Message)));
        }
        var semver = Path.Combine(root, "valid", "types.semver.yaml");
        var spec = await SpecPaths.ResolveSpecPath("backend", "types.spec.yaml");
        var semverResult = await new SpecValidator(spec).ValidateFile(semver);
        if (!semverResult.Valid)
            failures.Add("semver: " + semverResult.Errors[0].Message);

        var examples = Path.GetDirectoryName(await SpecPaths.FindAncestorPath("examples/minimal"))!;
        foreach (var app in new[] { "minimal", "tasks" })
        {
            foreach (var file in Directory.GetFiles(Path.Combine(examples, app), "*.yaml"))
            {
                var result = await ValidatorFor(Path.GetFileName(file)).ValidateFile(file);
                if (!result.Valid)
                    failures.Add($"{app}/{Path.GetFileName(file)}: " + string.Join(" | ", result.Errors.Take(3).Select(e => e.Message)));
            }
        }
        foreach (var line in failures) output.WriteLine(line);
        Assert.Empty(failures);
    }

    [Fact]
    public async Task InvalidSamplesFail()
    {
        var samples = await SpecPaths.FindAncestorPath("samples/valid");
        var root = Path.GetDirectoryName(samples)!;
        var still = new List<string>();
        foreach (var (file, make) in Specs)
        {
            var dir = Path.Combine(root, "invalid", Path.GetFileNameWithoutExtension(file));
            foreach (var path in Directory.GetFiles(dir, "*.yaml"))
            {
                var text = await File.ReadAllTextAsync(path);
                var yaml = SplitSample(text).Yaml;
                var result = await make().Validate(yaml);
                if (result.Valid || result.Errors.Count == 0)
                    still.Add($"{file}/{Path.GetFileName(path)}");
            }
        }
        foreach (var line in still) output.WriteLine(line);
        Assert.Empty(still);
    }

    [Fact]
    public async Task ErrorExamplesContainNeedles()
    {
        var examples = Path.GetDirectoryName(await SpecPaths.FindAncestorPath("examples/minimal"))!;
        var dir = Path.Combine(examples, "errors");
        var misses = new List<string>();
        foreach (var path in Directory.GetFiles(dir, "*.yaml"))
        {
            var text = await File.ReadAllTextAsync(path);
            var (includes, types, datasource, yaml) = SplitSample(text);
            var result = await ValidatorFor(Path.GetFileName(path)).Validate(yaml, new ValidateOptions
            {
                Types = types,
                Datasource = datasource,
            });
            var blob = string.Join("\n", result.Errors.Select(e => e.Message));
            if (result.Valid) misses.Add(Path.GetFileName(path) + " was valid");
            foreach (var needle in includes)
            {
                if (!blob.Contains(needle, StringComparison.Ordinal))
                    misses.Add($"{Path.GetFileName(path)} missing [{needle}] blob={blob}");
            }
        }
        foreach (var line in misses) output.WriteLine(line);
        Assert.Empty(misses);
    }

    static SpecValidator ValidatorFor(string file)
    {
        var stem = Path.GetFileNameWithoutExtension(file);
        var prefix = stem.Split('.')[0];
        return prefix switch
        {
            "types" => new TypesValidator(),
            "datasource" => new DatasourceValidator(),
            "datasource_seeds" => new DatasourceSeedsValidator(),
            "routes" => new RoutesValidator(),
            "services" => new ServicesValidator(),
            "backend-app" or "backend_app" => new SpecValidator(new SpecRef("backend", "app.spec.yaml")),
            "frontend_bindings" => new FrontendBindingsValidator(),
            _ => throw new InvalidOperationException(file),
        };
    }

    static (List<string> Includes, string? Types, string? Datasource, string Yaml) SplitSample(string text)
    {
        var parts = text.Split(["\n---\n", "\n---\r\n"], StringSplitOptions.None);
        var meta = parts[0];
        var yaml = string.Join("\n---\n", parts.Skip(1)).Trim();
        var data = YamlData.Plain(YamlDocuments.Parse(meta).Root);
        var expect = YamlData.AsRecord(YamlData.AsRecord(data)?.GetValueOrDefault("expect"));
        var includes = new List<string>();
        if (expect?.GetValueOrDefault("includes") is string one) includes.Add(one);
        if (expect?.GetValueOrDefault("includes") is List<object?> many)
            includes.AddRange(many.Select(item => item?.ToString() ?? ""));
        var types = expect?.GetValueOrDefault("types") as string;
        var datasource = expect?.GetValueOrDefault("datasource") as string;
        return (includes, types, datasource, yaml);
    }
}
