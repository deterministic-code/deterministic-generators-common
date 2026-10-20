namespace Deterministic.Generators.Common;

static class TypeModelSemantics
{
    static readonly Dictionary<string, string[]> BuiltIn = new(StringComparer.Ordinal)
    {
        ["set"] = ["id"],
        ["dictionary"] = [],
    };
    static readonly HashSet<string> Reserved = new(StringComparer.Ordinal) { "set", "dictionary" };
    static readonly HashSet<string> Primitives = new(StringComparer.Ordinal)
    {
        "string", "character", "number", "integer", "unsignedinteger", "biginteger",
        "unsignedbiginteger", "smallinteger", "unsignedsmallinteger", "float", "decimal",
        "boolean", "datetime", "binary", "uuid",
    };

    enum Kind { Inherit, Union, Shaped }

    sealed class TypeInfo
    {
        public required string Path { get; init; }
        public required Kind Kind { get; init; }
        public required List<string> Tags { get; init; }
        public string? Inherits { get; init; }
        public List<string>? Union { get; init; }
        public Dictionary<string, string>? Mapping { get; init; }
        public string? MappingPath { get; init; }
        public List<string>? Extract { get; init; }
        public string? ExtractPath { get; init; }
        public List<string>? RemoveFields { get; init; }
        public string? RemoveFieldsPath { get; init; }
        public List<string>? Ids { get; init; }
        public required List<string> IdFields { get; init; }
        public required Dictionary<string, string> Fields { get; init; }
        public required Dictionary<string, string> FieldTypes { get; init; }
        public required Dictionary<string, object> FieldReferences { get; init; }
    }

    readonly record struct Sourced(string Source, string Name, string Original);
    readonly record struct Cycle(string Name);
    readonly record struct FieldRef(string Type, string Field);

    public static SpecValidationResult Check(ParsedYaml parsed)
    {
        var (types, errors) = Collect(parsed);
        errors.AddRange(CheckComposition(parsed, types));
        errors.AddRange(CheckDictionary(parsed, types));
        errors.AddRange(CheckMapFields(parsed, types));
        errors.AddRange(CheckReferences(parsed, types));
        errors.AddRange(CheckDecimalSizes(parsed));
        errors.AddRange(CheckIdentity(parsed, types));
        return errors.Count == 0 ? SpecValidationResult.Ok() : SpecValidationResult.Fail(errors);
    }

    public static Dictionary<string, Dictionary<string, Dictionary<string, object?>>> IndexTypeFields(object? data) =>
        IndexFields(data);

    public static bool IsOccType(string type) =>
        type is "integer" or "number" or "datetime" or "binary";

    public static Dictionary<string, Dictionary<string, Dictionary<string, object?>>> IndexFields(object? data)
    {
        var outMap = new Dictionary<string, Dictionary<string, Dictionary<string, object?>>>(StringComparer.Ordinal);
        var list = YamlData.AsList(YamlData.AsRecord(data)?.GetValueOrDefault("types"));
        if (list is null) return outMap;
        var infos = new Dictionary<string, TypeInfo>(StringComparer.Ordinal);
        foreach (var entry in list)
        {
            var parsed = TypeInfoFromEntry(entry);
            if (parsed is not null) infos[parsed.Value.Name] = parsed.Value.Info;
        }
        foreach (var entry in list)
        {
            var pair = YamlData.SingleKey(entry);
            if (pair is null) continue;
            var def = YamlData.AsRecord(pair.Value.Body);
            var fields = new Dictionary<string, Dictionary<string, object?>>(StringComparer.Ordinal);
            foreach (var name in FieldNamesOf(pair.Value.Key, infos))
                fields[name] = new Dictionary<string, object?>(StringComparer.Ordinal);
            if (YamlData.AsList(def?.GetValueOrDefault("fields")) is { } authored)
            {
                foreach (var field in authored)
                {
                    var fp = YamlData.SingleKey(field);
                    if (fp is null) continue;
                    fields[fp.Value.Key] = YamlData.AsRecord(fp.Value.Body) ?? new Dictionary<string, object?>(StringComparer.Ordinal);
                }
            }
            outMap[pair.Value.Key] = fields;
        }
        return outMap;
    }

    static bool HasAuthoredIdentity(TypeInfo info) =>
        (info.Ids is not null && info.Ids.Count > 0) || info.IdFields.Count > 0;

    static Kind TypeKind(Dictionary<string, object?> def)
    {
        if (def.GetValueOrDefault("inherits") is string) return Kind.Inherit;
        if (YamlData.IsList(def.GetValueOrDefault("union"))) return Kind.Union;
        return Kind.Shaped;
    }

    static Dictionary<string, string>? MappingOf(Dictionary<string, object?> def)
    {
        var rec = YamlData.AsRecord(def.GetValueOrDefault("mapping"));
        if (rec is null) return null;
        var mapped = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (key, value) in rec)
        {
            if (value is string text) mapped[key] = text;
        }
        return mapped.Count > 0 ? mapped : null;
    }

    static List<string>? StringList(object? value)
    {
        if (value is not List<object?> list) return null;
        return list.OfType<string>().ToList();
    }

    static object? ReferencesOf(Dictionary<string, object?>? body)
    {
        var raw = body?.GetValueOrDefault("references");
        if (raw is string) return raw;
        if (raw is List<object?> list && list.Count == 2 && list.All(v => v is string))
            return list.Cast<string>().ToArray();
        return null;
    }

    static List<FieldRef> RefParts(object raw)
    {
        IEnumerable<string> items = raw is string text ? [text] : ((string[])raw);
        return items.Select(item =>
        {
            var split = SplitRemove(item);
            return new FieldRef(split.Source ?? "", split.Name);
        }).ToList();
    }

    static HashSet<string> IdentityNames(string name, Dictionary<string, TypeInfo> types, HashSet<string>? stack = null)
    {
        stack ??= new HashSet<string>(StringComparer.Ordinal);
        if (!stack.Add(name)) return new HashSet<string>(StringComparer.Ordinal);
        if (!types.TryGetValue(name, out var info)) return new HashSet<string>(StringComparer.Ordinal);
        if (info.Ids is { Count: > 0 }) return info.Ids.ToHashSet(StringComparer.Ordinal);
        if (info.IdFields.Count > 0) return info.IdFields.ToHashSet(StringComparer.Ordinal);
        if (info.Inherits == "set") return new HashSet<string>(StringComparer.Ordinal) { "id" };
        if (info.Inherits is not null && info.Inherits != "dictionary")
            return IdentityNames(info.Inherits, types, stack);
        return new HashSet<string>(StringComparer.Ordinal);
    }

    static bool IsOwnerIdentityRef(object raw, string self, Dictionary<string, TypeInfo> types)
    {
        var parts = RefParts(raw);
        var owner = parts[0].Type;
        if (owner.Length == 0 || owner == self || !types.ContainsKey(owner)) return false;
        var identity = IdentityNames(owner, types);
        return parts.All(p => p.Type == owner && identity.Contains(p.Field));
    }

    static (string? Source, string Name) SplitRemove(string entry)
    {
        var dot = entry.IndexOf('.');
        if (dot < 0) return (null, entry);
        return (entry[..dot], entry[(dot + 1)..]);
    }

    static (Dictionary<string, TypeInfo> Types, List<SpecValidationError> Errors) Collect(ParsedYaml parsed)
    {
        var errors = new List<SpecValidationError>();
        var types = new Dictionary<string, TypeInfo>(StringComparer.Ordinal);
        var list = YamlData.AsList(YamlData.AsRecord(parsed.Data)?.GetValueOrDefault("types"));
        if (list is null) return (types, errors);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var ti = 0; ti < list.Count; ti++)
        {
            var pair = YamlData.SingleKey(list[ti]);
            if (pair is null) continue;
            var path = $"/types/{ti}/{pair.Value.Key}";
            if (!YamlData.PushUnique(seen, pair.Value.Key, errors, parsed, path, $"duplicate type '{pair.Value.Key}'"))
                continue;
            if (Reserved.Contains(pair.Value.Key))
            {
                errors.Add(YamlData.Err(parsed, path, $"'{pair.Value.Key}' is a reserved type name"));
                continue;
            }
            var def = YamlData.AsRecord(pair.Value.Body);
            if (def is null) continue;
            var fields = new Dictionary<string, string>(StringComparer.Ordinal);
            var fieldTypes = new Dictionary<string, string>(StringComparer.Ordinal);
            var fieldReferences = new Dictionary<string, object>(StringComparer.Ordinal);
            var idFields = new List<string>();
            if (YamlData.AsList(def.GetValueOrDefault("fields")) is { } fieldList)
            {
                var seenFields = new HashSet<string>(StringComparer.Ordinal);
                for (var fi = 0; fi < fieldList.Count; fi++)
                {
                    var fp = YamlData.SingleKey(fieldList[fi]);
                    if (fp is null) continue;
                    var fieldPath = $"{path}/fields/{fi}/{fp.Value.Key}";
                    if (!YamlData.PushUnique(seenFields, fp.Value.Key, errors, parsed, fieldPath, $"duplicate field '{fp.Value.Key}' on {pair.Value.Key}"))
                        continue;
                    fields[fp.Value.Key] = fieldPath;
                    var body = YamlData.AsRecord(fp.Value.Body);
                    if (body?.GetValueOrDefault("type") is string typeName) fieldTypes[fp.Value.Key] = typeName;
                    if (body?.GetValueOrDefault("is_id") is true) idFields.Add(fp.Value.Key);
                    var references = ReferencesOf(body);
                    if (references is not null) fieldReferences[fp.Value.Key] = references;
                }
            }
            types[pair.Value.Key] = new TypeInfo
            {
                Path = path,
                Kind = TypeKind(def),
                Tags = StringList(def.GetValueOrDefault("tags")) ?? [],
                Inherits = def.GetValueOrDefault("inherits") as string,
                Union = StringList(def.GetValueOrDefault("union")),
                Mapping = MappingOf(def),
                MappingPath = def.ContainsKey("mapping") ? $"{path}/mapping" : null,
                Extract = StringList(def.GetValueOrDefault("extract")),
                ExtractPath = def.ContainsKey("extract") ? $"{path}/extract" : null,
                RemoveFields = StringList(def.GetValueOrDefault("remove_fields")),
                RemoveFieldsPath = def.ContainsKey("remove_fields") ? $"{path}/remove_fields" : null,
                Ids = StringList(def.GetValueOrDefault("ids")),
                IdFields = idFields,
                Fields = fields,
                FieldTypes = fieldTypes,
                FieldReferences = fieldReferences,
            };
        }
        return (types, errors);
    }

    static List<Sourced> ApplyExtract(List<Sourced> fields, List<string>? extract)
    {
        if (extract is null || extract.Count == 0) return fields;
        var allow = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        foreach (var item in extract)
        {
            var r = SplitRemove(item);
            if (r.Source is null) continue;
            if (!allow.TryGetValue(r.Source, out var set))
            {
                set = new HashSet<string>(StringComparer.Ordinal);
                allow[r.Source] = set;
            }
            set.Add(r.Name);
        }
        return fields.Where(f => !allow.TryGetValue(f.Source, out var keep) || keep.Contains(f.Name)).ToList();
    }

    static List<Sourced> ApplyMapping(List<Sourced> fields, Dictionary<string, string>? mapping)
    {
        if (mapping is null) return fields;
        return fields.Select(f =>
        {
            if (mapping.TryGetValue($"{f.Source}.{f.Name}", out var qualified))
                return f with { Name = qualified };
            if (mapping.TryGetValue(f.Name, out var bare))
                return f with { Name = bare };
            return f;
        }).ToList();
    }

    static List<Sourced> ApplyRemove(List<Sourced> fields, List<string>? remove)
    {
        if (remove is null || remove.Count == 0) return fields;
        return fields.Where(f =>
        {
            foreach (var item in remove)
            {
                var r = SplitRemove(item);
                if (r.Source is null)
                {
                    if (f.Name == r.Name) return false;
                    continue;
                }
                if (f.Source == r.Source && f.Name == r.Name) return false;
            }
            return true;
        }).ToList();
    }

    static object ParentFields(string name, Dictionary<string, TypeInfo> types, HashSet<string> stack)
    {
        var resolved = Compose(name, types, stack);
        if (resolved is Cycle cycle) return cycle;
        var fields = (List<Sourced>)resolved;
        types.TryGetValue(name, out var info);
        var nested = info?.Inherits == "dictionary"
            ? fields.Where(f =>
            {
                if (info.FieldReferences.TryGetValue(f.Original, out var reference))
                    return !IsOwnerIdentityRef(reference, name, types);
                return true;
            }).ToList()
            : fields;
        return nested.Select(f => new Sourced(name, f.Name, f.Name)).ToList();
    }

    static object Compose(string name, Dictionary<string, TypeInfo> types, HashSet<string> stack)
    {
        if (BuiltIn.TryGetValue(name, out var built))
            return built.Select(n => new Sourced(name, n, n)).ToList();
        if (stack.Contains(name)) return new Cycle(name);
        if (!types.TryGetValue(name, out var info)) return new List<Sourced>();
        stack.Add(name);
        var fields = new List<Sourced>();
        if (info.Inherits is not null)
        {
            if (!(info.Inherits == "set" && HasAuthoredIdentity(info)))
            {
                var parent = ParentFields(info.Inherits, types, stack);
                if (parent is Cycle cycle) return cycle;
                fields.AddRange((List<Sourced>)parent);
            }
        }
        foreach (var member in info.Union ?? [])
        {
            var part = ParentFields(member, types, stack);
            if (part is Cycle cycle) return cycle;
            fields.AddRange((List<Sourced>)part);
        }
        stack.Remove(name);
        var kept = ApplyRemove(ApplyMapping(ApplyExtract(fields, info.Extract), info.Mapping), info.RemoveFields);
        var result = kept.Select(f => new Sourced(name, f.Name, f.Name)).ToList();
        foreach (var local in info.Fields.Keys)
            result.Add(new Sourced(name, local, local));
        return result;
    }

    static object InheritedNames(string name, Dictionary<string, TypeInfo> types, HashSet<string> stack)
    {
        var resolved = Compose(name, types, stack);
        if (resolved is Cycle cycle) return cycle;
        return ((List<Sourced>)resolved).Select(f => f.Name).ToHashSet(StringComparer.Ordinal);
    }

    static List<SpecValidationError> CheckComposition(ParsedYaml parsed, Dictionary<string, TypeInfo> types)
    {
        var errors = new List<SpecValidationError>();
        foreach (var (name, info) in types)
        {
            _ = info.Kind;
            var sources = new List<string>();
            if (info.Inherits is not null)
            {
                if (!BuiltIn.ContainsKey(info.Inherits) && !types.ContainsKey(info.Inherits))
                    errors.Add(YamlData.Err(parsed, $"{info.Path}/inherits", $"unknown inherit target '{info.Inherits}' on {name}"));
                else
                    sources.Add(info.Inherits);
            }
            if (info.Union is not null)
            {
                for (var i = 0; i < info.Union.Count; i++)
                {
                    var member = info.Union[i];
                    if (BuiltIn.ContainsKey(member) || types.ContainsKey(member))
                    {
                        sources.Add(member);
                        continue;
                    }
                    errors.Add(YamlData.Err(parsed, $"{info.Path}/union/{i}", $"unknown type '{member}' in union on {name}"));
                }
            }
            var sourced = new List<Sourced>();
            var available = new HashSet<string>(StringComparer.Ordinal);
            foreach (var src in sources)
            {
                if (src == "set" && HasAuthoredIdentity(info)) continue;
                var part = ParentFields(src, types, new HashSet<string>(StringComparer.Ordinal) { name });
                if (part is Cycle cycle)
                {
                    errors.Add(YamlData.Err(parsed, info.Path, $"circular inherit/union involving '{cycle.Name}'"));
                    continue;
                }
                var list = (List<Sourced>)part;
                sourced.AddRange(list);
                foreach (var f in list) available.Add(f.Name);
            }
            var composeSources = new HashSet<string>(StringComparer.Ordinal);
            if (info.Inherits is not null) composeSources.Add(info.Inherits);
            foreach (var member in info.Union ?? []) composeSources.Add(member);

            bool CheckQualified(string field, string path, string label)
            {
                var r = SplitRemove(field);
                if (r.Source is null) return false;
                if (!BuiltIn.ContainsKey(r.Source) && !types.ContainsKey(r.Source))
                {
                    errors.Add(YamlData.Err(parsed, path, $"unknown type '{r.Source}' in {label} on {name}"));
                    return true;
                }
                if (!composeSources.Contains(r.Source))
                {
                    errors.Add(YamlData.Err(parsed, path, $"{label} '{field}' is not from an inherit or union source of {name}"));
                    return true;
                }
                var part = InheritedNames(r.Source, types, new HashSet<string>(StringComparer.Ordinal) { name });
                if (part is Cycle) return true;
                if (((HashSet<string>)part).Contains(r.Name)) return true;
                errors.Add(YamlData.Err(parsed, path, $"{label} '{field}' is not a field on {r.Source}"));
                return true;
            }

            if (info.Extract is not null)
            {
                for (var i = 0; i < info.Extract.Count; i++)
                {
                    var field = info.Extract[i];
                    var path = $"{info.ExtractPath}/{i}";
                    if (CheckQualified(field, path, "extract")) continue;
                    errors.Add(YamlData.Err(parsed, path, $"extract '{field}' is not a field on the inherited or unioned shape of {name}"));
                }
            }
            if (info.Mapping is not null)
            {
                foreach (var from in info.Mapping.Keys)
                {
                    var path = $"{info.MappingPath}/{from}";
                    if (CheckQualified(from, path, "mapping")) continue;
                    var matches = sourced.Where(f => f.Name == from).ToList();
                    if (matches.Count == 0)
                    {
                        errors.Add(YamlData.Err(parsed, path, $"mapping '{from}' is not a field on the inherited or unioned shape of {name}"));
                        continue;
                    }
                    if (matches.Count > 1)
                        errors.Add(YamlData.Err(parsed, path, $"mapping '{from}' matches more than one source on {name}; qualify it"));
                }
            }
            if (info.RemoveFields is not null)
            {
                for (var i = 0; i < info.RemoveFields.Count; i++)
                {
                    var field = info.RemoveFields[i];
                    var path = $"{info.RemoveFieldsPath}/{i}";
                    var r = SplitRemove(field);
                    if (r.Source is null)
                    {
                        if (available.Contains(r.Name)) continue;
                        errors.Add(YamlData.Err(parsed, path, $"remove_fields '{field}' is not a field on the inherited or unioned shape of {name}"));
                        continue;
                    }
                    CheckQualified(field, path, "remove_fields");
                }
            }
            var composed = ApplyRemove(ApplyMapping(ApplyExtract(sourced, info.Extract), info.Mapping), info.RemoveFields);
            var seenNames = new Dictionary<string, Sourced>(StringComparer.Ordinal);
            void ReportDup(Sourced field, string path)
            {
                if (seenNames.TryGetValue(field.Name, out var prev))
                {
                    errors.Add(YamlData.Err(parsed, path, $"{prev.Source}.{prev.Original} and {field.Source}.{field.Original} collide on the composed shape of {name}; use mapping or remove_fields and give new names"));
                    return;
                }
                seenNames[field.Name] = field;
            }
            foreach (var field in composed) ReportDup(field, info.Path);
            foreach (var (fieldName, fieldPath) in info.Fields)
                ReportDup(new Sourced(name, fieldName, fieldName), fieldPath);
        }
        return errors;
    }

    static HashSet<string> FieldNamesOf(string name, Dictionary<string, TypeInfo> types)
    {
        if (BuiltIn.TryGetValue(name, out var built)) return built.ToHashSet(StringComparer.Ordinal);
        var resolved = InheritedNames(name, types, new HashSet<string>(StringComparer.Ordinal));
        return resolved is Cycle ? new HashSet<string>(StringComparer.Ordinal) : (HashSet<string>)resolved;
    }

    static List<SpecValidationError> CheckReferences(ParsedYaml parsed, Dictionary<string, TypeInfo> types)
    {
        var errors = new List<SpecValidationError>();
        var list = YamlData.AsList(YamlData.AsRecord(parsed.Data)?.GetValueOrDefault("types"));
        if (list is null) return errors;
        void CheckRef(string reference, string refPath, bool checkField)
        {
            var parts = reference.Split('.');
            if (parts.Length < 2 || parts[0].Length == 0 || parts[1].Length == 0) return;
            var refType = parts[0];
            var refCol = parts[1];
            if (!types.ContainsKey(refType) && !BuiltIn.ContainsKey(refType))
            {
                errors.Add(YamlData.Err(parsed, refPath, $"unknown type '{refType}' in references"));
                return;
            }
            if (checkField && refCol != "id" && !FieldNamesOf(refType, types).Contains(refCol))
                errors.Add(YamlData.Err(parsed, refPath, $"unknown field '{refCol}' on {refType} in references"));
        }
        bool IsTypeName(object? raw)
        {
            if (raw is not string text) return false;
            var baseName = text.EndsWith("[]", StringComparison.Ordinal) || text.EndsWith("{}", StringComparison.Ordinal)
                ? text[..^2]
                : text;
            return types.ContainsKey(baseName);
        }
        for (var ti = 0; ti < list.Count; ti++)
        {
            var pair = YamlData.SingleKey(list[ti]);
            if (pair is null) continue;
            var fields = YamlData.AsList(YamlData.AsRecord(pair.Value.Body)?.GetValueOrDefault("fields"));
            if (fields is null) continue;
            for (var fi = 0; fi < fields.Count; fi++)
            {
                var fp = YamlData.SingleKey(fields[fi]);
                if (fp is null) continue;
                var body = YamlData.AsRecord(fp.Value.Body);
                var reference = body?.GetValueOrDefault("references");
                var refPath = $"/types/{ti}/{pair.Value.Key}/fields/{fi}/{fp.Value.Key}/references";
                var checkField = !IsTypeName(body?.GetValueOrDefault("type"));
                if (reference is string text)
                {
                    CheckRef(text, refPath, checkField);
                    continue;
                }
                if (reference is not List<object?> items) continue;
                for (var i = 0; i < items.Count; i++)
                {
                    if (items[i] is string item) CheckRef(item, $"{refPath}/{i}", checkField);
                }
            }
        }
        return errors;
    }

    static List<SpecValidationError> CheckDecimalSizes(ParsedYaml parsed)
    {
        var errors = new List<SpecValidationError>();
        var list = YamlData.AsList(YamlData.AsRecord(parsed.Data)?.GetValueOrDefault("types"));
        if (list is null) return errors;
        for (var ti = 0; ti < list.Count; ti++)
        {
            var pair = YamlData.SingleKey(list[ti]);
            if (pair is null) continue;
            var fields = YamlData.AsList(YamlData.AsRecord(pair.Value.Body)?.GetValueOrDefault("fields"));
            if (fields is null) continue;
            for (var fi = 0; fi < fields.Count; fi++)
            {
                var fp = YamlData.SingleKey(fields[fi]);
                if (fp is null) continue;
                var fdef = YamlData.AsRecord(fp.Value.Body);
                if (fdef?.GetValueOrDefault("type") is not "decimal") continue;
                if (fdef.GetValueOrDefault("size") is not List<object?> size || size.Count != 2) continue;
                if (!YamlData.TryFinite(size[0], out var precision) || !YamlData.TryFinite(size[1], out var scale)) continue;
                if (scale > precision)
                {
                    errors.Add(YamlData.Err(
                        parsed,
                        $"/types/{ti}/{pair.Value.Key}/fields/{fi}/{fp.Value.Key}/size",
                        $"decimal size scale must be <= precision ({precision})"));
                }
            }
        }
        return errors;
    }

    static List<SpecValidationError> CheckIdentity(ParsedYaml parsed, Dictionary<string, TypeInfo> types)
    {
        var errors = new List<SpecValidationError>();
        var list = YamlData.AsList(YamlData.AsRecord(parsed.Data)?.GetValueOrDefault("types"));
        if (list is null) return errors;
        for (var ti = 0; ti < list.Count; ti++)
        {
            var pair = YamlData.SingleKey(list[ti]);
            if (pair is null) continue;
            var def = YamlData.AsRecord(pair.Value.Body);
            if (def is null) continue;
            var path = $"/types/{ti}/{pair.Value.Key}";
            var idFields = new List<string>();
            if (YamlData.AsList(def.GetValueOrDefault("fields")) is { } fields)
            {
                for (var fi = 0; fi < fields.Count; fi++)
                {
                    var fp = YamlData.SingleKey(fields[fi]);
                    if (fp is null) continue;
                    if (YamlData.AsRecord(fp.Value.Body)?.GetValueOrDefault("is_id") is not true) continue;
                    var fieldPath = $"{path}/fields/{fi}/{fp.Value.Key}/is_id";
                    if (idFields.Count > 0)
                        errors.Add(YamlData.Err(parsed, fieldPath, $"is_id: true may appear on at most one field on {pair.Value.Key}"));
                    idFields.Add(fieldPath);
                }
            }
            if (YamlData.IsList(def.GetValueOrDefault("ids")) && idFields.Count > 0)
                errors.Add(YamlData.Err(parsed, $"{path}/ids", $"ids and is_id are mutually exclusive on {pair.Value.Key}"));
            if (def.GetValueOrDefault("ids") is not List<object?> ids) continue;
            var known = FieldNamesOf(pair.Value.Key, types);
            for (var i = 0; i < ids.Count; i++)
            {
                if (ids[i] is not string idName) continue;
                if (known.Contains(idName)) continue;
                errors.Add(YamlData.Err(parsed, $"{path}/ids/{i}", $"ids '{idName}' is not a field on {pair.Value.Key}"));
            }
        }
        return errors;
    }

    static string FieldTypeBase(string raw) =>
        raw.EndsWith("[]", StringComparison.Ordinal) || raw.EndsWith("{}", StringComparison.Ordinal) ? raw[..^2] : raw;

    static string? DottedRef(object? raw) => raw as string;

    static (string Column, string? Error) ResolveRoleColumn(
        TypeInfo dict,
        string role,
        string tableName,
        Dictionary<string, TypeInfo> types)
    {
        var known = FieldNamesOf(tableName, types);
        var reference = DottedRef(dict.FieldReferences.GetValueOrDefault(role));
        if (reference is not null)
        {
            var split = SplitRemove(reference);
            if (split.Source != tableName || !known.Contains(split.Name))
                return ("", $"dictionary {role} must reference a column on {tableName}");
            return (split.Name, null);
        }
        return known.Contains(role)
            ? (role, null)
            : ("", $"{tableName} must include a {role} column");
    }

    static List<SpecValidationError> CheckDictionary(ParsedYaml parsed, Dictionary<string, TypeInfo> types)
    {
        var errors = new List<SpecValidationError>();
        foreach (var (name, info) in types)
        {
            if (info.Inherits != "dictionary") continue;
            if (!info.Fields.ContainsKey("key"))
                errors.Add(YamlData.Err(parsed, $"{info.Path}/fields", $"dictionary type {name} must include a key field"));
            if (!info.Fields.ContainsKey("value"))
                errors.Add(YamlData.Err(parsed, $"{info.Path}/fields", $"dictionary type {name} must include a value field"));
            if (info.Tags.Contains("datasource_type"))
                errors.Add(YamlData.Err(parsed, info.Path, $"dictionary type {name} must not be tagged datasource_type"));
            if (!info.Tags.Contains("view_type"))
                errors.Add(YamlData.Err(parsed, info.Path, $"dictionary type {name} must be tagged view_type"));
            if (info.FieldReferences.Values.Any(reference => IsOwnerIdentityRef(reference, name, types)))
                errors.Add(YamlData.Err(parsed, info.Path, $"dictionary type {name} must not reference an owner identity"));
            if (info.FieldTypes.TryGetValue("value", out var valueType))
            {
                var baseName = FieldTypeBase(valueType);
                if (!Primitives.Contains(baseName) && types.TryGetValue(baseName, out var valueInfo) && valueInfo.Tags.Contains("datasource_type"))
                    errors.Add(YamlData.Err(parsed, $"{info.Path}/fields", $"dictionary type {name} value must not be a datasource_type"));
            }
        }
        return errors;
    }

    static List<SpecValidationError> CheckMapFields(ParsedYaml parsed, Dictionary<string, TypeInfo> types)
    {
        var errors = new List<SpecValidationError>();
        foreach (var (typeName, info) in types)
        {
            foreach (var (fieldName, fieldPath) in info.Fields)
            {
                if (!info.FieldTypes.TryGetValue(fieldName, out var rawType) || !rawType.EndsWith("{}", StringComparison.Ordinal))
                    continue;
                var dictName = rawType[..^2];
                if (!types.TryGetValue(dictName, out var dict) || dict.Inherits != "dictionary")
                {
                    errors.Add(YamlData.Err(parsed, $"{fieldPath}/type", $"{typeName}.{fieldName} type {rawType} must name a dictionary type"));
                    continue;
                }
                var text = DottedRef(info.FieldReferences.GetValueOrDefault(fieldName));
                var split = text is null ? (Source: (string?)null, Name: "") : SplitRemove(text);
                TypeInfo? table = split.Source is null ? null : types.GetValueOrDefault(split.Source);
                var ownerRef = table is null ? null : table.FieldReferences.GetValueOrDefault(split.Name);
                if (
                    split.Source is null
                    || table is null
                    || !table.Tags.Contains("datasource_type")
                    || ownerRef is null
                    || !IsOwnerIdentityRef(ownerRef, split.Source, types)
                )
                {
                    errors.Add(YamlData.Err(parsed, $"{fieldPath}/references", $"{typeName}.{fieldName} must reference a datasource_type owner identity column"));
                    continue;
                }
                var key = ResolveRoleColumn(dict, "key", split.Source, types);
                if (key.Error is not null)
                    errors.Add(YamlData.Err(parsed, $"{fieldPath}/references", key.Error));
                dict.FieldTypes.TryGetValue("value", out var valueType);
                var valueBase = valueType is null ? null : FieldTypeBase(valueType);
                var nested = valueBase is not null && !Primitives.Contains(valueBase) ? types.GetValueOrDefault(valueBase) : null;
                if (nested is null)
                {
                    var value = ResolveRoleColumn(dict, "value", split.Source, types);
                    if (value.Error is not null)
                        errors.Add(YamlData.Err(parsed, $"{fieldPath}/references", value.Error));
                    continue;
                }
                foreach (var role in nested.Fields.Keys)
                {
                    nested.FieldTypes.TryGetValue(role, out var raw);
                    if (raw is not null && (raw.EndsWith("[]", StringComparison.Ordinal) || raw.EndsWith("{}", StringComparison.Ordinal)))
                        continue;
                    var column = ResolveRoleColumn(nested, role, split.Source, types);
                    if (column.Error is not null)
                        errors.Add(YamlData.Err(parsed, $"{fieldPath}/references", column.Error));
                }
            }
        }
        return errors;
    }

    static (string Name, TypeInfo Info)? TypeInfoFromEntry(object? entry)
    {
        var pair = YamlData.SingleKey(entry);
        if (pair is null) return null;
        var def = YamlData.AsRecord(pair.Value.Body);
        if (def is null) return null;
        var fields = new Dictionary<string, string>(StringComparer.Ordinal);
        var fieldTypes = new Dictionary<string, string>(StringComparer.Ordinal);
        var fieldReferences = new Dictionary<string, object>(StringComparer.Ordinal);
        var idFields = new List<string>();
        if (YamlData.AsList(def.GetValueOrDefault("fields")) is { } list)
        {
            for (var fi = 0; fi < list.Count; fi++)
            {
                var fp = YamlData.SingleKey(list[fi]);
                if (fp is null) continue;
                fields[fp.Value.Key] = $"/types/{fp.Value.Key}/fields/{fi}";
                var body = YamlData.AsRecord(fp.Value.Body);
                if (body?.GetValueOrDefault("type") is string typeName) fieldTypes[fp.Value.Key] = typeName;
                var references = ReferencesOf(body);
                if (references is not null) fieldReferences[fp.Value.Key] = references;
                if (body?.GetValueOrDefault("is_id") is true) idFields.Add(fp.Value.Key);
            }
        }
        return (pair.Value.Key, new TypeInfo
        {
            Path = $"/types/{pair.Value.Key}",
            Kind = TypeKind(def),
            Tags = StringList(def.GetValueOrDefault("tags")) ?? [],
            Inherits = def.GetValueOrDefault("inherits") as string,
            Union = StringList(def.GetValueOrDefault("union")),
            Mapping = MappingOf(def),
            Extract = StringList(def.GetValueOrDefault("extract")),
            RemoveFields = StringList(def.GetValueOrDefault("remove_fields")),
            Ids = StringList(def.GetValueOrDefault("ids")),
            IdFields = idFields,
            Fields = fields,
            FieldTypes = fieldTypes,
            FieldReferences = fieldReferences,
        });
    }
}
