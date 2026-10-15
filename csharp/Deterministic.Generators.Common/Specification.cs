namespace Deterministic.Generators.Common;

public static class Specification
{
    private static readonly HashSet<string> Primitives = new(StringComparer.Ordinal)
    {
        "string", "character", "number", "integer", "unsignedinteger",
        "biginteger", "unsignedbiginteger", "smallinteger", "unsignedsmallinteger",
        "float", "decimal", "boolean", "datetime", "binary", "uuid", "reference",
    };

    private static readonly TypeField[] SetFields =
    [
        new()
        {
            Name = "id",
            Type = "integer",
            Kind = "primitive",
            Base = "integer",
            IsArray = false,
            IsMap = false,
            IsNullable = false,
        },
    ];

    public static FieldTypeParts ParseFieldType(string raw)
    {
        var isArray = raw.EndsWith("[]", StringComparison.Ordinal);
        var isMap = raw.EndsWith("{}", StringComparison.Ordinal);
        var basis = isArray || isMap ? raw[..^2] : raw;
        return new FieldTypeParts
        {
            Kind = Primitives.Contains(basis) ? "primitive" : "type",
            Base = basis,
            IsArray = isArray,
            IsMap = isMap,
        };
    }

    public static bool HasAuthoredIdentity(TypeModel type) =>
        (type.Ids is { Count: > 0 }) || type.Fields.Any(f => f.IsId == true);

    public static List<string> IdentityColumns(TypeModel? type)
    {
        if (type is null) return ["id"];
        if (type.Ids is { Count: > 0 }) return [.. type.Ids];
        var marked = type.Fields.Where(f => f.IsId == true).Select(f => f.Name).ToList();
        if (marked.Count > 0) return marked;
        return type.Inherits == "set" ? ["id"] : [];
    }

    public static string PrimaryKeyColumn(DatasourceTable? table, TypeModel? type = null)
    {
        _ = table;
        return IdentityColumns(type).FirstOrDefault() ?? "id";
    }

    public static List<ServiceByField> UniqueLookupFields(TypeModel type, DatasourceTable? table = null)
    {
        var result = new List<ServiceByField>();
        void Add(string name)
        {
            if (result.Any(e => e.Field == name)) return;
            var field = type.Fields.FirstOrDefault(x => x.Name == name);
            int? size = field?.HasSize == true && field.Size is long or int ? Convert.ToInt32(field.Size) : null;
            result.Add(new ServiceByField
            {
                Field = name,
                Type = field?.Type ?? "string",
                Size = size,
            });
        }
        foreach (var name in IdentityColumns(type)) Add(name);
        foreach (var overlay in table?.Fields ?? [])
        {
            if (overlay.IsUnique == true) Add(overlay.Name);
        }
        foreach (var name in table?.UniqueIndexFields ?? []) Add(name);
        return result;
    }

    public static bool TypeHasTag(TypeModel type, string tag) => type.Tags.Contains(tag);

    public static List<TypeModel> ExpandTypes(IReadOnlyList<TypeModel> types)
    {
        var byName = types.ToDictionary(t => t.Name, t => t, StringComparer.Ordinal);
        var cache = new Dictionary<string, List<TypeField>>(StringComparer.Ordinal);

        List<TypeField> Resolve(string name, HashSet<string> stack)
        {
            if (cache.TryGetValue(name, out var hit)) return hit;
            if (name == "set")
            {
                cache[name] = [.. SetFields];
                return cache[name];
            }
            if (stack.Contains(name))
                throw new InvalidOperationException($"circular inherit/union involving \"{name}\"");
            if (!byName.TryGetValue(name, out var type)) return [];
            stack.Add(name);

            List<SourcedField> ComposeSource(string source)
            {
                var fields = Resolve(source, stack).Select(f => SourcedField.From(f, source, f.Name)).ToList();
                if (byName.TryGetValue(source, out var src) && src.Inherits == "dictionary")
                {
                    fields = fields.Where(f => !IsOwnerIdentityRef(f.References, src.Name, byName)).ToList();
                }
                return fields;
            }

            var skipSetId = type.Inherits == "set" && HasAuthoredIdentity(type);
            var inherited = new List<SourcedField>();
            if (type.Inherits is not null && !skipSetId) inherited.AddRange(ComposeSource(type.Inherits));
            foreach (var member in type.Union ?? []) inherited.AddRange(ComposeSource(member));
            stack.Remove(name);
            var merged = new List<SourcedField>();
            merged.AddRange(KeepFields(RenameFields(ExtractFields(inherited, type.Extract), type.Mapping), type.RemoveFields));
            foreach (var field in type.Fields)
                merged.Add(SourcedField.From(field, name, field.Name));
            AssertUnique(merged, name);
            var result = merged.Select(f => f.ToField()).ToList();
            cache[name] = result;
            return result;
        }

        List<string>? ResolveIds(string name, HashSet<string> stack)
        {
            if (stack.Contains(name)) return null;
            if (!byName.TryGetValue(name, out var type)) return null;
            if (type.Ids is { Count: > 0 }) return type.Ids;
            if (type.Fields.Any(f => f.IsId == true)) return null;
            if (type.Inherits is not null && type.Inherits is not "set" and not "dictionary")
            {
                stack.Add(name);
                var ids = ResolveIds(type.Inherits, stack);
                stack.Remove(name);
                return ids;
            }
            return null;
        }

        return types.Select(type =>
        {
            var ids = type.Ids ?? ResolveIds(type.Name, []);
            return new TypeModel
            {
                Name = type.Name,
                Tags = type.Tags,
                Kind = type.Kind,
                Inherits = type.Inherits,
                Union = type.Union,
                Mapping = type.Mapping,
                Extract = type.Extract,
                RemoveFields = type.RemoveFields,
                Ids = ids is { Count: > 0 } ? [.. ids] : null,
                Fields = Resolve(type.Name, []),
            };
        }).ToList();
    }

    private static (string Left, string Right)? SplitDot(string value)
    {
        var i = value.IndexOf('.');
        return i < 0 ? null : (value[..i], value[(i + 1)..]);
    }

    private static HashSet<string> IdentityFieldNames(TypeModel? type, Dictionary<string, TypeModel> byName, HashSet<string>? stack = null)
    {
        stack ??= [];
        if (type is null) return [];
        if (stack.Contains(type.Name)) return [];
        var local = IdentityColumns(type);
        if (local.Count > 0) return local.ToHashSet(StringComparer.Ordinal);
        if (type.Inherits is not null && type.Inherits != "dictionary")
        {
            stack.Add(type.Name);
            byName.TryGetValue(type.Inherits, out var parent);
            return IdentityFieldNames(parent, byName, stack);
        }
        return [];
    }

    private static bool IsOwnerIdentityRef(object? references, string selfName, Dictionary<string, TypeModel> byName)
    {
        if (references is null) return false;
        var raw = references switch
        {
            string s => new[] { s },
            string[] arr => arr,
            IReadOnlyList<string> list => list.ToArray(),
            _ => [],
        };
        if (raw.Length == 0) return false;
        var parts = raw.Select(reference =>
        {
            var split = SplitDot(reference);
            return split is null ? ("", reference) : (split.Value.Left, split.Value.Right);
        }).ToList();
        var owner = parts[0].Item1;
        if (owner.Length == 0 || owner == selfName) return false;
        byName.TryGetValue(owner, out var ownerType);
        var identity = IdentityFieldNames(ownerType, byName);
        return parts.All(p => p.Item1 == owner && identity.Contains(p.Item2));
    }

    private static List<SourcedField> ExtractFields(List<SourcedField> fields, List<string>? extract)
    {
        if (extract is not { Count: > 0 }) return fields;
        var allow = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        foreach (var item in extract)
        {
            var split = SplitDot(item);
            if (split is null) continue;
            if (!allow.TryGetValue(split.Value.Left, out var set))
            {
                set = new HashSet<string>(StringComparer.Ordinal);
                allow[split.Value.Left] = set;
            }
            set.Add(split.Value.Right);
        }
        return fields.Where(f =>
        {
            if (f.Source is null || !allow.TryGetValue(f.Source, out var keep)) return true;
            return keep.Contains(f.Name);
        }).ToList();
    }

    private static List<SourcedField> RenameFields(List<SourcedField> fields, Dictionary<string, string>? mapping)
    {
        if (mapping is null) return fields;
        return fields.Select(f =>
        {
            if (f.Source is not null && mapping.TryGetValue($"{f.Source}.{f.Name}", out var qualified))
                return f.Renamed(qualified);
            if (mapping.TryGetValue(f.Name, out var bare)) return f.Renamed(bare);
            return f;
        }).ToList();
    }

    private static void AssertUnique(List<SourcedField> fields, string typeName)
    {
        var seen = new Dictionary<string, SourcedField>(StringComparer.Ordinal);
        foreach (var field in fields)
        {
            if (seen.TryGetValue(field.Name, out var prev))
            {
                throw new InvalidOperationException(
                    $"{prev.Source}.{prev.Original} and {field.Source}.{field.Original} collide on the composed shape of {typeName}; use mapping or remove_fields and give new names");
            }
            seen[field.Name] = field;
        }
    }

    private static List<SourcedField> KeepFields(List<SourcedField> fields, List<string>? remove)
    {
        if (remove is not { Count: > 0 }) return fields;
        return fields.Where(f => !remove.Any(item =>
        {
            var split = SplitDot(item);
            return split is null
                ? f.Name == item
                : f.Name == split.Value.Right && f.Source == split.Value.Left;
        })).ToList();
    }

    private sealed class SourcedField
    {
        public required TypeField Field { get; init; }
        public string? Source { get; init; }
        public required string Original { get; init; }
        public string Name => Field.Name;
        public object? References => Field.References;

        public static SourcedField From(TypeField field, string source, string original) =>
            new() { Field = field, Source = source, Original = original };

        public SourcedField Renamed(string name) => new()
        {
            Field = Clone(Field, name),
            Source = Source,
            Original = Original,
        };

        public TypeField ToField() => Field;

        private static TypeField Clone(TypeField field, string name) => new()
        {
            Name = name,
            Type = field.Type,
            Kind = field.Kind,
            Base = field.Base,
            IsArray = field.IsArray,
            IsMap = field.IsMap,
            IsNullable = field.IsNullable,
            IsId = field.IsId,
            Size = field.Size,
            HasSize = field.HasSize,
            MinSize = field.MinSize,
            References = field.References,
            HasDefault = field.HasDefault,
            DefaultValue = field.DefaultValue,
            DefaultIsLiteral = field.DefaultIsLiteral,
        };
    }
}
