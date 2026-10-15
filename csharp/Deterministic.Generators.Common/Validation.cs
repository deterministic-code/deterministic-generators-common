namespace Deterministic.Generators.Common;

public sealed class SpecValidationError
{
    public required int Line { get; init; }
    public required int Col { get; init; }
    public required string InstancePath { get; init; }
    public required string Message { get; init; }
}

public sealed class SpecValidationResult
{
    public required bool Valid { get; init; }
    public required IReadOnlyList<SpecValidationError> Errors { get; init; }

    public static SpecValidationResult Ok() => new() { Valid = true, Errors = [] };

    public static SpecValidationResult Fail(IReadOnlyList<SpecValidationError> errors) =>
        new() { Valid = false, Errors = errors };
}

public sealed class ValidateOptions
{
    public string? Types { get; init; }
    public string? TypesPath { get; init; }
    public string? Datasource { get; init; }
    public string? DatasourcePath { get; init; }
    public string? IncludeFilePath { get; init; }
    public string? IncludeBasePath { get; init; }

    public bool HasTypes => Types is not null;
    public bool HasDatasource => Datasource is not null;

    public ValidateOptions With(
        string? types = null,
        bool setTypes = false,
        string? datasource = null,
        bool setDatasource = false,
        string? includeFilePath = null,
        string? includeBasePath = null) => new()
    {
        Types = setTypes ? types : Types,
        TypesPath = TypesPath,
        Datasource = setDatasource ? datasource : Datasource,
        DatasourcePath = DatasourcePath,
        IncludeFilePath = includeFilePath ?? IncludeFilePath,
        IncludeBasePath = includeBasePath ?? IncludeBasePath,
    };
}

public sealed class ParsedYaml
{
    public required YamlValue? Root { get; init; }
    public required object? Data { get; init; }
}

public readonly record struct SchemaIssue(
    string Keyword,
    string InstancePath,
    string Message,
    string? AdditionalProperty,
    string? MissingProperty,
    IReadOnlyList<string>? AllowedValues);

public static class AjvErrors
{
    public static string FormatAjvError(SchemaIssue error)
    {
        var where = error.InstancePath.Length == 0 ? "(root)" : error.InstancePath;
        if (error.Keyword == "not" && error.InstancePath.EndsWith("/is_id", StringComparison.Ordinal))
            return $"{where} ids and is_id are mutually exclusive";
        return $"{where} {AjvMessage(error)}{Suffix(error)}";
    }

    public static int YamlErrorOffset(IReadOnlyList<int>? pos) =>
        pos is { Count: > 0 } ? pos[0] : 0;

    static string AjvMessage(SchemaIssue error)
    {
        var raw = error.Message;
        return error.Keyword switch
        {
            "type" => TypeMessage(raw),
            "required" => RequiredMessage(error),
            "additionalProperties" or "false" => "must NOT have additional properties",
            "enum" => "must be equal to one of the allowed values",
            "pattern" => PatternMessage(raw),
            "oneOf" => "must match exactly one schema in oneOf",
            "anyOf" => "must match a schema in anyOf",
            "not" => "must NOT be valid",
            "const" => "must be equal to constant",
            "minLength" => raw.StartsWith("must", StringComparison.Ordinal) ? raw : "must NOT have fewer than 1 characters",
            "maxLength" => raw.StartsWith("must", StringComparison.Ordinal) ? raw : "must NOT have more than 1 characters",
            "minItems" => raw.StartsWith("must", StringComparison.Ordinal) ? raw : "must NOT have fewer than 1 items",
            "maxItems" => raw.StartsWith("must", StringComparison.Ordinal) ? raw : "must NOT have more than 1 items",
            "minimum" => raw.StartsWith("must", StringComparison.Ordinal) ? raw : "must be >= 0",
            "maximum" => raw.StartsWith("must", StringComparison.Ordinal) ? raw : "must be <= 0",
            "uniqueItems" => "must NOT have duplicate items",
            "minProperties" => raw.StartsWith("must", StringComparison.Ordinal) ? raw : "must NOT have fewer than 1 properties",
            "maxProperties" => raw.StartsWith("must", StringComparison.Ordinal) ? raw : "must NOT have more than 1 properties",
            _ when raw.StartsWith("must", StringComparison.Ordinal) => raw,
            _ => string.IsNullOrEmpty(raw) ? "must be valid" : raw,
        };
    }

    static string PatternMessage(string raw)
    {
        if (raw.Contains("must match", StringComparison.OrdinalIgnoreCase)) return raw;
        var pattern = raw.Trim().Trim('"');
        return pattern.Length == 0 || pattern.StartsWith("The string", StringComparison.Ordinal)
            ? "must match pattern"
            : $"must match pattern \"{pattern}\"";
    }

    static string TypeMessage(string raw)
    {
        var match = System.Text.RegularExpressions.Regex.Match(raw, "should be \"(\\w+)\"");
        if (match.Success) return $"must be {match.Groups[1].Value}";
        var expected = raw.Trim().Trim('"');
        foreach (var kind in new[] { "object", "array", "string", "number", "integer", "boolean", "null" })
        {
            if (expected.Equals(kind, StringComparison.OrdinalIgnoreCase))
                return $"must be {kind}";
        }
        foreach (var kind in new[] { "object", "array", "string", "number", "integer", "boolean", "null" })
        {
            if (raw.Contains(kind, StringComparison.OrdinalIgnoreCase))
                return $"must be {kind}";
        }
        return raw.Contains("must", StringComparison.Ordinal) ? raw : "must be object";
    }

    public static string ErrorFromUnknown(Exception? err) => err?.Message ?? "";

    public static string ErrorFromUnknown(object? err)
    {
        if (err is Exception ex) return ex.Message;
        if (err is null) return "";
        return err.ToString() ?? "";
    }

    static string RequiredMessage(SchemaIssue error)
    {
        var name = error.MissingProperty;
        if (string.IsNullOrEmpty(name))
        {
            var match = System.Text.RegularExpressions.Regex.Match(error.Message, @"'([^']+)'");
            if (match.Success) name = match.Groups[1].Value;
        }
        return string.IsNullOrEmpty(name)
            ? "must have required property"
            : $"must have required property '{name}'";
    }

    static string Suffix(SchemaIssue error)
    {
        if (!string.IsNullOrEmpty(error.AdditionalProperty))
            return $" (property: {error.AdditionalProperty})";
        if (!string.IsNullOrEmpty(error.MissingProperty) && error.Keyword == "required")
            return $" (missing: {error.MissingProperty})";
        if (error.AllowedValues is not null)
            return $" (allowed: {string.Join(", ", error.AllowedValues)})";
        return "";
    }
}
