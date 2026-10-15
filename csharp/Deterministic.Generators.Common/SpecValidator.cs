using System.Text.Json.Nodes;

namespace Deterministic.Generators.Common;

public sealed record SpecRef(string Subdir, string Name);

public delegate Task<SpecValidationResult> AfterSchemaFn(ParsedYaml parsed, ValidateOptions? options);

public delegate Task<ValidateOptions?> FileOptionsFn(string path, ValidateOptions? options);

public class SpecValidator
{
    readonly SpecRef? _ref;
    readonly Func<Task<string>>? _fixedPath;
    readonly List<AfterSchemaFn> _after = [];
    readonly FileOptionsFn? _fileOptions;
    readonly Dictionary<string, Json.Schema.JsonSchema> _compiled = new(StringComparer.Ordinal);

    public SpecValidator(SpecRef spec, AfterSchemaFn? after = null, FileOptionsFn? fileOptions = null)
        : this(spec, after is null ? [] : [after], fileOptions)
    {
    }

    public SpecValidator(SpecRef spec, IEnumerable<AfterSchemaFn> after, FileOptionsFn? fileOptions = null)
    {
        _ref = spec;
        _after.AddRange(after);
        _fileOptions = fileOptions;
    }

    public SpecValidator(string specPath, AfterSchemaFn? after = null, FileOptionsFn? fileOptions = null)
        : this(() => Task.FromResult(specPath), after, fileOptions)
    {
    }

    public SpecValidator(Func<Task<string>> specPath, AfterSchemaFn? after = null, FileOptionsFn? fileOptions = null)
    {
        _fixedPath = specPath;
        if (after is not null) _after.Add(after);
        _fileOptions = fileOptions;
    }

    public async Task<SpecValidationResult> Validate(string text, ValidateOptions? options = null)
    {
        var parsed = YamlDocuments.Parse(text);
        if (parsed.Errors.Count > 0)
        {
            var error = parsed.Errors[0];
            return SpecValidationResult.Fail(
            [
                new SpecValidationError
                {
                    Line = error.Line,
                    Col = error.Col,
                    InstancePath = "",
                    Message = error.Message,
                },
            ]);
        }
        var data = YamlData.Plain(parsed.Root);
        var doc = new ParsedYaml { Root = parsed.Root, Data = data };
        return await Check(doc, options);
    }

    public async Task<SpecValidationResult> ValidateFile(string path, ValidateOptions? options = null)
    {
        var text = await File.ReadAllTextAsync(path);
        var fileOptions = _fileOptions is null ? options : await _fileOptions(path, options);
        return await Validate(text, fileOptions);
    }

    async Task<SpecValidationResult> Check(ParsedYaml parsed, ValidateOptions? options)
    {
        var resolved = await ResolvePath(parsed);
        if (resolved.Error is not null) return resolved.Error;
        var schema = await Compiled(resolved.Path!);
        var instance = parsed.Root?.ToJson();
        var issues = SchemaEngine.Evaluate(schema, instance);
        if (issues.Count == 0)
            return await FirstFailure(parsed, options);
        return SpecValidationResult.Fail(issues.Select(issue => YamlData.Err(
            parsed,
            issue.InstancePath,
            AjvErrors.FormatAjvError(issue))).ToList());
    }

    async Task<SpecValidationResult> FirstFailure(ParsedYaml parsed, ValidateOptions? options)
    {
        foreach (var check in _after)
        {
            var result = await check(parsed, options);
            if (!result.Valid) return result;
        }
        return SpecValidationResult.Ok();
    }

    async Task<(string? Path, SpecValidationResult? Error)> ResolvePath(ParsedYaml parsed)
    {
        if (_fixedPath is not null) return (await _fixedPath(), null);
        try
        {
            return (await SpecPaths.ResolveSpecPath(_ref!.Subdir, _ref.Name), null);
        }
        catch (Exception ex)
        {
            return (null, SpecValidationResult.Fail([YamlData.Err(parsed, "/version", ex.Message)]));
        }
    }

    async Task<Json.Schema.JsonSchema> Compiled(string path)
    {
        if (_compiled.TryGetValue(path, out var hit)) return hit;
        var schema = await SchemaEngine.Load(path);
        _compiled[path] = schema;
        return schema;
    }
}

public sealed class TypesValidator : SpecValidator
{
    public TypesValidator() : base(
        new SpecRef("backend", "types.spec.yaml"),
        [
            (parsed, _) => FieldDefaults.Check(parsed),
            (parsed, _) => Task.FromResult(TypeModelSemantics.Check(parsed)),
            (parsed, _) => Task.FromResult(IncludeFilters.Check(parsed)),
            IncludeCycles.Check,
        ],
        IncludeCycles.WithIncludeFilePath)
    {
    }
}

public sealed class DatasourceValidator : SpecValidator
{
    public DatasourceValidator() : base(
        new SpecRef("backend", "datasource.spec.yaml"),
        [
            DatasourceModel.Check,
            (parsed, _) => Task.FromResult(IncludeFilters.Check(parsed)),
            IncludeCycles.Check,
        ],
        DatasourceModel.WithSiblingTypes)
    {
    }
}

public sealed class DatasourceSeedsValidator : SpecValidator
{
    public DatasourceSeedsValidator() : base(
        new SpecRef("backend", "datasource-seeds.spec.yaml"),
        [SeedSemantics.CheckSeeds],
        SeedSemantics.WithSiblingCompanions)
    {
    }
}

public sealed class RoutesValidator : SpecValidator
{
    public RoutesValidator() : base(
        new SpecRef("backend", "routes.spec.yaml"),
        [
            (parsed, _) => Task.FromResult(RouteModel.Check(parsed)),
            (parsed, _) => Task.FromResult(IncludeFilters.Check(parsed)),
            IncludeCycles.Check,
        ],
        IncludeCycles.WithIncludeFilePath)
    {
    }
}

public sealed class RoutesApiValidator : SpecValidator
{
    public RoutesApiValidator() : base(
        new SpecRef("backend", "routes-api.spec.yaml"),
        (parsed, _) => Task.FromResult(RouteModel.Check(parsed)))
    {
    }
}

public sealed class ServicesValidator : SpecValidator
{
    public ServicesValidator() : base(
        new SpecRef("backend", "services.spec.yaml"),
        [
            (parsed, _) => Task.FromResult(ServiceModel.Check(parsed)),
            (parsed, _) => Task.FromResult(IncludeFilters.Check(parsed)),
            IncludeCycles.Check,
        ],
        IncludeCycles.WithIncludeFilePath)
    {
    }
}

public sealed class FrontendBindingsValidator : SpecValidator
{
    public FrontendBindingsValidator() : base(new SpecRef("frontend", "bindings.spec.yaml"))
    {
    }
}
