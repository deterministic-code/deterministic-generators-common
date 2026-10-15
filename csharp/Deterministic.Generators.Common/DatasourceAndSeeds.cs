namespace Deterministic.Generators.Common;

static class DatasourceModel
{
    public static async Task<ValidateOptions?> WithSiblingTypes(string path, ValidateOptions? options)
    {
        var included = await IncludeCycles.WithIncludeFilePath(path, options);
        string? types;
        if (included!.Types is not null) types = included.Types;
        else if (included.TypesPath is not null) types = await File.ReadAllTextAsync(included.TypesPath);
        else types = await ReadIfPresent(Path.Combine(Path.GetDirectoryName(path) ?? "", "types.yaml"));
        return new ValidateOptions
        {
            Types = types,
            TypesPath = included.TypesPath,
            Datasource = included.Datasource,
            DatasourcePath = included.DatasourcePath,
            IncludeFilePath = included.IncludeFilePath,
            IncludeBasePath = included.IncludeBasePath,
        };
    }

    public static Task<SpecValidationResult> Check(ParsedYaml parsed, ValidateOptions? options)
    {
        object? companion = null;
        if (options?.Types is not null)
            companion = YamlData.Plain(YamlDocuments.Parse(options.Types).Root);
        return Task.FromResult(CheckModel(parsed, options?.Types is not null ? companion : null, options?.Types is not null));
    }

    public static SpecValidationResult CheckModel(ParsedYaml parsed, object? companion, bool hasCompanion)
    {
        var (tables, errors) = Collect(parsed);
        var companionFields = hasCompanion ? TypeModelSemantics.IndexTypeFields(companion) : null;
        errors.AddRange(CheckIndexes(parsed, tables, companionFields));
        if (hasCompanion)
        {
            errors.AddRange(CheckCompanion(parsed, companion!));
            errors.AddRange(CheckOcc(parsed, companion!));
        }
        return errors.Count == 0 ? SpecValidationResult.Ok() : SpecValidationResult.Fail(errors);
    }

    static async Task<string?> ReadIfPresent(string path)
    {
        try { return await File.ReadAllTextAsync(path); }
        catch { return null; }
    }

    sealed class TableInfo
    {
        public required string Path { get; init; }
        public Dictionary<string, string> Fields { get; init; } = new(StringComparer.Ordinal);
    }

    static (Dictionary<string, TableInfo> Tables, List<SpecValidationError> Errors) Collect(ParsedYaml parsed)
    {
        var errors = new List<SpecValidationError>();
        var tables = new Dictionary<string, TableInfo>(StringComparer.Ordinal);
        var types = YamlData.AsList(YamlData.AsRecord(parsed.Data)?.GetValueOrDefault("types"));
        if (types is null) return (tables, errors);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var ti = 0; ti < types.Count; ti++)
        {
            var pair = YamlData.SingleKey(types[ti]);
            if (pair is null) continue;
            var tablePath = $"/types/{ti}/{pair.Value.Key}";
            if (!YamlData.PushUnique(seen, pair.Value.Key, errors, parsed, tablePath, $"duplicate type '{pair.Value.Key}'"))
                continue;
            var def = YamlData.AsRecord(pair.Value.Body) ?? [];
            var fields = new Dictionary<string, string>(StringComparer.Ordinal);
            var occ = 0;
            var fieldList = YamlData.AsList(def.GetValueOrDefault("fields"));
            if (fieldList is not null)
            {
                var seenFields = new HashSet<string>(StringComparer.Ordinal);
                for (var fi = 0; fi < fieldList.Count; fi++)
                {
                    var fp = YamlData.SingleKey(fieldList[fi]);
                    if (fp is null) continue;
                    var fieldPath = $"{tablePath}/fields/{fi}/{fp.Value.Key}";
                    if (!YamlData.PushUnique(seenFields, fp.Value.Key, errors, parsed, fieldPath, $"duplicate field '{fp.Value.Key}' on {pair.Value.Key}"))
                        continue;
                    var fdef = YamlData.AsRecord(fp.Value.Body) ?? [];
                    if (fdef.GetValueOrDefault("is_fixed_id") is true && fdef.GetValueOrDefault("is_readonly") is not true)
                        errors.Add(YamlData.Err(parsed, $"{fieldPath}/is_fixed_id", $"is_fixed_id on '{fp.Value.Key}' requires is_readonly: true"));
                    if (fdef.GetValueOrDefault("use_native_row_version") is true && fdef.GetValueOrDefault("is_optimistic_concurrency") is not true)
                        errors.Add(YamlData.Err(parsed, $"{fieldPath}/use_native_row_version", $"use_native_row_version on '{fp.Value.Key}' requires is_optimistic_concurrency: true"));
                    if (fdef.GetValueOrDefault("is_optimistic_concurrency") is true) occ++;
                    fields[fp.Value.Key] = fieldPath;
                }
            }
            if (occ > 1)
                errors.Add(YamlData.Err(parsed, tablePath, $"at most one is_optimistic_concurrency field on {pair.Value.Key}"));
            tables[pair.Value.Key] = new TableInfo { Path = tablePath, Fields = fields };
        }
        return (tables, errors);
    }

    static List<SpecValidationError> CheckIndexes(
        ParsedYaml parsed,
        Dictionary<string, TableInfo> tables,
        Dictionary<string, Dictionary<string, Dictionary<string, object?>>>? companion)
    {
        var errors = new List<SpecValidationError>();
        var types = YamlData.AsList(YamlData.AsRecord(parsed.Data)?.GetValueOrDefault("types"));
        if (types is null) return errors;
        for (var ti = 0; ti < types.Count; ti++)
        {
            var pair = YamlData.SingleKey(types[ti]);
            if (pair is null || !tables.TryGetValue(pair.Value.Key, out var table)) continue;
            var def = YamlData.AsRecord(pair.Value.Body);
            var indexes = YamlData.AsList(def?.GetValueOrDefault("indexes"));
            if (indexes is null) continue;
            var known = table.Fields.Keys.ToHashSet(StringComparer.Ordinal);
            if (companion is not null && companion.TryGetValue(pair.Value.Key, out var extra))
                foreach (var name in extra.Keys) known.Add(name);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (var ii = 0; ii < indexes.Count; ii++)
            {
                var ip = YamlData.SingleKey(indexes[ii]);
                if (ip is null) continue;
                var indexPath = $"/types/{ti}/{pair.Value.Key}/indexes/{ii}/{ip.Value.Key}";
                if (!YamlData.PushUnique(seen, ip.Value.Key, errors, parsed, indexPath, $"duplicate index '{ip.Value.Key}' on {pair.Value.Key}"))
                    continue;
                var cols = YamlData.AsList(YamlData.AsRecord(ip.Value.Body)?.GetValueOrDefault("fields"));
                if (cols is null) continue;
                for (var ci = 0; ci < cols.Count; ci++)
                {
                    if (cols[ci] is not string col || known.Contains(col)) continue;
                    errors.Add(YamlData.Err(parsed, $"{indexPath}/fields/{ci}", $"unknown field '{col}' on {pair.Value.Key} in index '{ip.Value.Key}'"));
                }
            }
        }
        return errors;
    }

    static List<SpecValidationError> CheckCompanion(ParsedYaml parsed, object companion)
    {
        var errors = new List<SpecValidationError>();
        var typeFields = TypeModelSemantics.IndexTypeFields(companion);
        var types = YamlData.AsList(YamlData.AsRecord(parsed.Data)?.GetValueOrDefault("types"));
        if (types is null) return errors;
        for (var ti = 0; ti < types.Count; ti++)
        {
            var pair = YamlData.SingleKey(types[ti]);
            if (pair is null) continue;
            var tablePath = $"/types/{ti}/{pair.Value.Key}";
            if (!typeFields.ContainsKey(pair.Value.Key))
            {
                errors.Add(YamlData.Err(parsed, tablePath, $"unknown type '{pair.Value.Key}' (not in types.yaml)"));
                continue;
            }
            var known = typeFields[pair.Value.Key];
            var fields = YamlData.AsList(YamlData.AsRecord(pair.Value.Body)?.GetValueOrDefault("fields"));
            if (fields is null) continue;
            for (var fi = 0; fi < fields.Count; fi++)
            {
                var fp = YamlData.SingleKey(fields[fi]);
                if (fp is null || known.ContainsKey(fp.Value.Key)) continue;
                errors.Add(YamlData.Err(parsed, $"{tablePath}/fields/{fi}/{fp.Value.Key}", $"unknown field '{fp.Value.Key}' on {pair.Value.Key} (not in types.yaml)"));
            }
        }
        return errors;
    }

    static List<SpecValidationError> CheckOcc(ParsedYaml parsed, object companion)
    {
        var errors = new List<SpecValidationError>();
        var fieldsByType = TypeModelSemantics.IndexTypeFields(companion);
        var inherits = InheritByType(companion);
        var types = YamlData.AsList(YamlData.AsRecord(parsed.Data)?.GetValueOrDefault("types"));
        if (types is null) return errors;
        for (var ti = 0; ti < types.Count; ti++)
        {
            var pair = YamlData.SingleKey(types[ti]);
            if (pair is null) continue;
            var fieldList = YamlData.AsList(YamlData.AsRecord(pair.Value.Body)?.GetValueOrDefault("fields"));
            if (fieldList is null) continue;
            fieldsByType.TryGetValue(pair.Value.Key, out var known);
            for (var fi = 0; fi < fieldList.Count; fi++)
            {
                var fp = YamlData.SingleKey(fieldList[fi]);
                if (fp is null) continue;
                var fdef = YamlData.AsRecord(fp.Value.Body) ?? [];
                if (fdef.GetValueOrDefault("is_optimistic_concurrency") is not true) continue;
                var fieldPath = $"/types/{ti}/{pair.Value.Key}/fields/{fi}/{fp.Value.Key}";
                if (known is null || !known.ContainsKey(fp.Value.Key))
                {
                    errors.Add(YamlData.Err(parsed, fieldPath, $"unknown field '{fp.Value.Key}' on {pair.Value.Key} (not in types.yaml)"));
                    continue;
                }
                var fieldType = CompanionFieldType(fieldsByType, inherits, pair.Value.Key, fp.Value.Key);
                if (fieldType is not null && !TypeModelSemantics.IsOccType(fieldType))
                    errors.Add(YamlData.Err(parsed, fieldPath, $"is_optimistic_concurrency field '{fp.Value.Key}' on {pair.Value.Key} must be integer, number, datetime, or binary"));
                if (fdef.GetValueOrDefault("use_native_row_version") is true && fieldType != "binary")
                    errors.Add(YamlData.Err(parsed, $"{fieldPath}/use_native_row_version", $"use_native_row_version on '{fp.Value.Key}' requires a binary field"));
            }
        }
        return errors;
    }

    static Dictionary<string, string> InheritByType(object? companion)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        var list = YamlData.AsList(YamlData.AsRecord(companion)?.GetValueOrDefault("types"));
        if (list is null) return map;
        foreach (var entry in list)
        {
            var pair = YamlData.SingleKey(entry);
            if (pair is null) continue;
            if (YamlData.AsRecord(pair.Value.Body)?.GetValueOrDefault("inherits") is string inherits)
                map[pair.Value.Key] = inherits;
        }
        return map;
    }

    static string? CompanionFieldType(
        Dictionary<string, Dictionary<string, Dictionary<string, object?>>> fields,
        Dictionary<string, string> inherits,
        string typeName,
        string fieldName)
    {
        var current = typeName;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        while (!string.IsNullOrEmpty(current) && seen.Add(current))
        {
            if (fields.TryGetValue(current, out var table) && table.TryGetValue(fieldName, out var rec) && rec.GetValueOrDefault("type") is string type)
                return type;
            inherits.TryGetValue(current, out current!);
        }
        return null;
    }
}

static class SeedSemantics
{
    static readonly HashSet<string> Auto = new(StringComparer.Ordinal) { "id", "created", "updated" };
    static readonly HashSet<string> Strings = new(StringComparer.Ordinal) { "string", "character", "datetime", "uuid", "binary" };
    static readonly HashSet<string> Numbers = new(StringComparer.Ordinal) { "number", "integer", "unsignedinteger", "smallinteger", "unsignedsmallinteger", "float" };
    static readonly HashSet<string> StringOrNumber = new(StringComparer.Ordinal) { "biginteger", "unsignedbiginteger", "decimal" };
    static readonly HashSet<string> Integers = new(StringComparer.Ordinal) { "integer", "unsignedinteger", "smallinteger", "unsignedsmallinteger" };
    static readonly HashSet<string> Unsigned = new(StringComparer.Ordinal) { "unsignedinteger", "unsignedbiginteger", "unsignedsmallinteger" };
    const string MissingTypes = "types.yaml is required to validate seeds (pass types, or place types.yaml next to the seeds file)";

    public static async Task<ValidateOptions?> WithSiblingCompanions(string path, ValidateOptions? options)
    {
        var dir = Path.GetDirectoryName(path) ?? "";
        var types = options?.Types ?? (options?.TypesPath is not null
            ? await File.ReadAllTextAsync(options.TypesPath)
            : await ReadIfPresent(Path.Combine(dir, "types.yaml")));
        var datasource = options?.Datasource ?? (options?.DatasourcePath is not null
            ? await File.ReadAllTextAsync(options.DatasourcePath)
            : await ReadIfPresent(Path.Combine(dir, "datasource.yaml")));
        return new ValidateOptions
        {
            Types = types,
            TypesPath = options?.TypesPath,
            Datasource = datasource,
            DatasourcePath = options?.DatasourcePath,
            IncludeFilePath = options?.IncludeFilePath,
            IncludeBasePath = options?.IncludeBasePath,
        };
    }

    public static async Task<SpecValidationResult> CheckSeeds(ParsedYaml parsed, ValidateOptions? options)
    {
        if (options?.Types is null)
        {
            if (!Needs(parsed.Data)) return SpecValidationResult.Ok();
            return Companion(parsed, MissingTypes);
        }
        var typesValidator = new SpecValidator(new SpecRef("backend", "types.spec.yaml"));
        var typesResult = await typesValidator.Validate(options.Types);
        if (!typesResult.Valid)
            return Companion(parsed, $"companion types.yaml is invalid: {typesResult.Errors[0].Message}");
        if (options.Datasource is not null)
        {
            var datasourceValidator = new SpecValidator(new SpecRef("backend", "datasource.spec.yaml"));
            var datasourceResult = await datasourceValidator.Validate(options.Datasource);
            if (!datasourceResult.Valid)
                return Companion(parsed, $"companion datasource.yaml is invalid: {datasourceResult.Errors[0].Message}");
        }
        var typesData = YamlData.Plain(YamlDocuments.Parse(options.Types).Root);
        object? datasourceData = options.Datasource is null
            ? null
            : YamlData.Plain(YamlDocuments.Parse(options.Datasource).Root);
        return Check(parsed, typesData, datasourceData, options.Datasource is not null);
    }

    public static bool Needs(object? data)
    {
        var seeds = YamlData.AsList(YamlData.AsRecord(data)?.GetValueOrDefault("seeds"));
        return seeds is { Count: > 0 };
    }

    public static SpecValidationResult Companion(ParsedYaml parsed, string message) =>
        SpecValidationResult.Fail([YamlData.Err(parsed, "/seeds", message)]);

    public static SpecValidationResult Check(ParsedYaml parsed, object? typesData, object? datasourceData, bool hasDatasource)
    {
        var tables = TypeModelSemantics.IndexTypeFields(typesData);
        HashSet<string>? allowed = hasDatasource ? Allowed(typesData, datasourceData) : null;
        var seeds = YamlData.AsList(YamlData.AsRecord(parsed.Data)?.GetValueOrDefault("seeds"));
        if (seeds is null) return SpecValidationResult.Ok();
        var errors = new List<SpecValidationError>();
        var seenTables = new HashSet<string>(StringComparer.Ordinal);
        for (var tableIndex = 0; tableIndex < seeds.Count; tableIndex++)
        {
            var obj = YamlData.AsRecord(seeds[tableIndex]);
            if (obj is null || obj.Count == 0) continue;
            var tableName = obj.Keys.First();
            var tablePath = $"/seeds/{tableIndex}/{tableName}";
            if (!seenTables.Add(tableName))
            {
                errors.Add(YamlData.Err(parsed, tablePath, $"duplicate seed table '{tableName}'"));
                continue;
            }
            if (allowed is not null && !allowed.Contains(tableName))
            {
                errors.Add(YamlData.Err(parsed, tablePath, $"unknown type '{tableName}' (not in datasource.yaml)"));
                continue;
            }
            if (!tables.TryGetValue(tableName, out var fields))
            {
                errors.Add(YamlData.Err(parsed, tablePath, $"unknown type '{tableName}' (not in types.yaml)"));
                continue;
            }
            if (obj[tableName] is not List<object?> rows) continue;
            var seenIds = new HashSet<string>(StringComparer.Ordinal);
            for (var rowIndex = 0; rowIndex < rows.Count; rowIndex++)
            {
                var rowObj = YamlData.AsRecord(rows[rowIndex]);
                if (rowObj is null || rowObj.Count == 0) continue;
                var rowId = rowObj.Keys.First();
                var rowPath = $"{tablePath}/{rowIndex}/{rowId}";
                if (!seenIds.Add(rowId))
                {
                    errors.Add(YamlData.Err(parsed, rowPath, $"duplicate seed id '{rowId}'"));
                    continue;
                }
                var row = YamlData.AsRecord(rowObj[rowId]) ?? [];
                foreach (var key in row.Keys)
                {
                    var fieldPath = $"{rowPath}/{key}";
                    if (Auto.Contains(key))
                    {
                        errors.Add(YamlData.Err(parsed, fieldPath, $"'{key}' is auto-injected and is not seeded here"));
                        continue;
                    }
                    if (!fields.TryGetValue(key, out var def))
                    {
                        errors.Add(YamlData.Err(parsed, fieldPath, $"unknown field '{key}' on {tableName}"));
                        continue;
                    }
                    var value = row[key];
                    if (value is null)
                    {
                        if (def.GetValueOrDefault("is_nullable") is not true)
                            errors.Add(YamlData.Err(parsed, fieldPath, $"'{key}' is not nullable"));
                        continue;
                    }
                    var declared = FieldTypeOf(def, tables);
                    if (declared is not null && !Matches(value, declared))
                        errors.Add(YamlData.Err(parsed, fieldPath, $"'{key}' must be {TypeMessage(declared)}"));
                }
                foreach (var (name, def) in fields)
                {
                    if (Auto.Contains(name) || row.ContainsKey(name) || Omittable(def) || def.Count == 0) continue;
                    errors.Add(YamlData.Err(parsed, rowPath, $"missing required field '{name}' on {tableName} (not nullable and has no default)"));
                }
            }
        }
        return errors.Count == 0 ? SpecValidationResult.Ok() : SpecValidationResult.Fail(errors);
    }

    static async Task<string?> ReadIfPresent(string path)
    {
        try { return await File.ReadAllTextAsync(path); }
        catch { return null; }
    }

    static HashSet<string> Allowed(object? typesData, object? datasourceData)
    {
        var filter = TypesFilter(datasourceData);
        if (string.IsNullOrEmpty(filter)) return TableNames(datasourceData);
        return TypeCandidates(typesData)
            .Where(cand => IncludeFilters.Match(filter, cand))
            .Select(cand => cand.Name)
            .ToHashSet(StringComparer.Ordinal);
    }

    static HashSet<string> TableNames(object? data)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        var types = YamlData.AsList(YamlData.AsRecord(data)?.GetValueOrDefault("types"));
        if (types is null) return names;
        foreach (var entry in types)
        {
            var obj = YamlData.AsRecord(entry);
            if (obj is null || obj.Count == 0) continue;
            names.Add(obj.Keys.First());
        }
        return names;
    }

    static string? TypesFilter(object? data)
    {
        var includes = YamlData.AsList(YamlData.AsRecord(data)?.GetValueOrDefault("includes"));
        if (includes is null) return null;
        foreach (var entry in includes)
        {
            if (YamlData.AsRecord(YamlData.AsRecord(entry)?.GetValueOrDefault("types"))?.GetValueOrDefault("filter") is string filter)
                return filter;
        }
        return null;
    }

    static List<FilterCandidate> TypeCandidates(object? data)
    {
        var result = new List<FilterCandidate>();
        var types = YamlData.AsList(YamlData.AsRecord(data)?.GetValueOrDefault("types"));
        if (types is null) return result;
        foreach (var entry in types)
        {
            var obj = YamlData.AsRecord(entry);
            if (obj is null || obj.Count == 0) continue;
            var name = obj.Keys.First();
            var def = YamlData.AsRecord(obj[name]) ?? [];
            result.Add(new FilterCandidate
            {
                Name = name,
                Tags = YamlData.StringList(def.GetValueOrDefault("tags")) ?? [],
                Inherits = def.GetValueOrDefault("inherits") as string,
            });
        }
        return result;
    }

    static bool Omittable(Dictionary<string, object?> def) =>
        def.GetValueOrDefault("is_nullable") is true || def.ContainsKey("default_value");

    static string? FieldTypeOf(
        Dictionary<string, object?> def,
        Dictionary<string, Dictionary<string, Dictionary<string, object?>>> tables)
    {
        if (def.GetValueOrDefault("type") is string type) return type;
        if (def.GetValueOrDefault("references") is not string references) return null;
        var parts = references.Split('.');
        if (parts.Length < 2 || parts[0].Length == 0 || parts[1].Length == 0) return null;
        if (parts[1] == "id") return "number";
        if (tables.TryGetValue(parts[0], out var table) && table.TryGetValue(parts[1], out var parent) && parent.GetValueOrDefault("type") is string parentType)
            return parentType;
        return "number";
    }

    static string TypeMessage(string type)
    {
        if (Strings.Contains(type)) return "string";
        if (type == "boolean") return "boolean";
        if (StringOrNumber.Contains(type)) return "string or number";
        if (Integers.Contains(type)) return "integer";
        return "number";
    }

    static bool Matches(object value, string type)
    {
        if (Strings.Contains(type)) return value is string;
        if (type == "boolean") return value is bool;
        if (StringOrNumber.Contains(type))
        {
            if (value is string) return true;
            if (!YamlData.TryFinite(value, out var number)) return false;
            return !Unsigned.Contains(type) || number >= 0;
        }
        if (!Numbers.Contains(type)) return true;
        if (!YamlData.TryFinite(value, out var n)) return false;
        if (Integers.Contains(type) && n != Math.Truncate(n)) return false;
        if (Unsigned.Contains(type) && n < 0) return false;
        return true;
    }
}

static class RouteModel
{
    public static SpecValidationResult Check(ParsedYaml parsed)
    {
        var errors = new List<SpecValidationError>();
        var routes = YamlData.AsList(YamlData.AsRecord(parsed.Data)?.GetValueOrDefault("routes"));
        if (routes is null) return SpecValidationResult.Ok();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < routes.Count; i++)
        {
            var entry = routes[i];
            string? name = entry is string text && text.Length > 0 ? text : null;
            var pathSuffix = "";
            if (name is null)
            {
                var pair = YamlData.SingleKey(entry);
                if (pair is null) continue;
                name = pair.Value.Key;
                pathSuffix = $"/{pair.Value.Key}";
            }
            var path = $"/routes/{i}{pathSuffix}";
            YamlData.PushUnique(seen, name, errors, parsed, path, $"duplicate route '{name}'");
            var pairBody = YamlData.SingleKey(entry);
            var shape = pairBody is null ? null : YamlData.AsRecord(pairBody.Value.Body);
            if (shape is null) continue;
            var kinds = new List<string>();
            if (shape.ContainsKey("service")) kinds.Add("service");
            if (shape.ContainsKey("services")) kinds.Add("services");
            if (shape.ContainsKey("routeClass") || shape.ContainsKey("module")) kinds.Add("routeClass/module");
            if (kinds.Count > 1)
                errors.Add(YamlData.Err(parsed, path, $"custom route cannot combine {string.Join(" and ", kinds)}"));
        }
        return errors.Count == 0 ? SpecValidationResult.Ok() : SpecValidationResult.Fail(errors);
    }
}

static class ServiceModel
{
    public static SpecValidationResult Check(ParsedYaml parsed)
    {
        var errors = new List<SpecValidationError>();
        var services = YamlData.AsList(YamlData.AsRecord(parsed.Data)?.GetValueOrDefault("services"));
        if (services is null) return SpecValidationResult.Ok();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < services.Count; i++)
        {
            if (YamlData.AsRecord(services[i])?.GetValueOrDefault("name") is not string name || name.Length == 0)
                continue;
            YamlData.PushUnique(seen, name, errors, parsed, $"/services/{i}/name", $"duplicate service '{name}'");
        }
        return errors.Count == 0 ? SpecValidationResult.Ok() : SpecValidationResult.Fail(errors);
    }
}
