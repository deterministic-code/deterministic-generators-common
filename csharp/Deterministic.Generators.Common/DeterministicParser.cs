using System.Globalization;
using System.Text.RegularExpressions;

namespace Deterministic.Generators.Common;

public sealed class ParseOptions
{
    public Func<string, string>? ServiceClassName { get; init; }
}

public sealed class DeterministicParser
{
    private readonly IDeterministicReader _reader;
    private static readonly Regex ShorthandVerb = new(@"^(get|put|delete)_", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Dictionary<string, string[]> VerbToMethods = new(StringComparer.Ordinal)
    {
        ["get"] = ["GET"],
        ["put"] = ["PUT"],
        ["delete"] = ["DELETE"],
    };

    public DeterministicParser(IDeterministicReader reader) => _reader = reader;

    public async Task<IDeterministic> Parse(IReadOnlyDictionary<string, string> settings, ParseOptions? options = null)
    {
        _ = settings;
        var serviceClassName = options?.ServiceClassName ?? (entity => entity);
        var hasTypes = await _reader.Exists(SpecFiles.TypesYaml);
        var hasDs = await _reader.Exists(SpecFiles.DatasourceYaml);
        var hasSeeds = await _reader.Exists(SpecFiles.DatasourceSeedsYaml);
        var hasServices = await _reader.Exists(SpecFiles.ServicesYaml);
        var hasRoutes = await _reader.Exists(SpecFiles.RoutesYaml);
        var typesYaml = hasTypes ? await _reader.Read(SpecFiles.TypesYaml) : null;
        var datasourceYaml = hasDs ? await _reader.Read(SpecFiles.DatasourceYaml) : null;
        var seedsYaml = hasSeeds ? await _reader.Read(SpecFiles.DatasourceSeedsYaml) : null;
        var servicesYaml = hasServices ? await _reader.Read(SpecFiles.ServicesYaml) : null;
        var routesYaml = hasRoutes ? await _reader.Read(SpecFiles.RoutesYaml) : null;

        var types = typesYaml is null ? [] : ParseTypes(typesYaml);
        var expanded = Specification.ExpandTypes(types);
        var datasource = datasourceYaml is null ? [] : ParseDatasource(datasourceYaml, expanded);
        var seeds = seedsYaml is null
            ? new Dictionary<string, IReadOnlyList<SeedRow>>(StringComparer.Ordinal)
            : ParseSeeds(seedsYaml);
        var services = servicesYaml is null
            ? new ParsedServices()
            : ParseServices(servicesYaml, expanded, datasource, routesYaml, serviceClassName);
        var routes = routesYaml is null
            ? new ParsedRoutes { Datasource = datasource }
            : ParseRoutes(routesYaml, expanded, datasource);
        return EnsureHealth.Apply(new Deterministic(types, expanded, datasource, seeds, services, routes));
    }

    public static List<string> InheritsChain(string name, IReadOnlyDictionary<string, TypeModel> typeByName)
    {
        var chain = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal) { name };
        typeByName.TryGetValue(name, out var currentType);
        var current = currentType?.Inherits;
        while (current is not null)
        {
            if (current is "set" or "dictionary") break;
            if (!seen.Add(current)) break;
            chain.Add(current);
            typeByName.TryGetValue(current, out var next);
            current = next?.Inherits;
        }
        return chain;
    }

    private static List<TypeModel> ParseTypes(string yaml) =>
        YamlNode.FromYaml(yaml).NamedList("types").Select(entry =>
        {
            var node = entry.Node;
            var kind = node.Str("inherits") is not null ? "inherit"
                : node.Child("union").Value is List<object?> ? "union"
                : "shaped";
            var mapping = MappingOf(node);
            var extract = node.Strings("extract").ToList();
            var remove = node.Strings("remove_fields").ToList();
            var ids = node.Strings("ids").ToList();
            return new TypeModel
            {
                Name = entry.Name,
                Tags = node.Strings("tags").ToList(),
                Kind = kind,
                Inherits = node.Str("inherits"),
                Union = node.Child("union").Value is List<object?> ? node.Strings("union").ToList() : null,
                Mapping = mapping,
                Extract = extract.Count > 0 ? extract : null,
                RemoveFields = remove.Count > 0 ? remove : null,
                Ids = ids.Count > 0 ? ids : null,
                Fields = node.NamedList("fields").Select(field => ReadField(field.Name, field.Node)).ToList(),
            };
        }).ToList();

    private static TypeField ReadField(string name, YamlNode node)
    {
        var rawType = node.Str("type") ?? "string";
        var parsed = Specification.ParseFieldType(rawType);
        var references = ReferencesOf(node);
        var size = SizeOf(node);
        var literal = node.Literal("default_value");
        object? implicitDefault = parsed.IsArray
            ? new List<object?>()
            : parsed.IsMap
                ? new Dictionary<string, object?>(StringComparer.Ordinal)
                : null;
        var authored = node.Has("default_value");
        return new TypeField
        {
            Name = name,
            Type = rawType,
            Kind = parsed.Kind,
            Base = parsed.Base,
            IsArray = parsed.IsArray,
            IsMap = parsed.IsMap,
            IsNullable = node.Bool("is_nullable"),
            IsId = node.Bool("is_id") ? true : null,
            Size = size,
            HasSize = size is not null,
            MinSize = node.FiniteInt("min_size") is long min ? (int)min : null,
            References = references,
            HasDefault = authored || implicitDefault is not null,
            DefaultValue = literal.Present ? literal.Value : implicitDefault,
            DefaultIsLiteral = literal.Present || implicitDefault is not null,
        };
    }

    private static Dictionary<string, string>? MappingOf(YamlNode node)
    {
        if (node.Child("mapping").Record is not { } record || record.Count == 0) return null;
        var output = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (key, value) in record)
        {
            if (value is string text) output[key] = text;
        }
        return output.Count > 0 ? output : null;
    }

    private static object? ReferencesOf(YamlNode node)
    {
        var raw = node.Child("references").Value;
        if (raw is string text) return text;
        if (raw is List<object?> list && list.Count == 2 && list.All(item => item is string))
            return new[] { (string)list[0]!, (string)list[1]! };
        return null;
    }

    private static object? SizeOf(YamlNode node)
    {
        var raw = node.Child("size").Value;
        if (raw as string == "unlimited") return "unlimited";
        if (raw is long or double) return raw;
        if (raw is List<object?> list && list.Count == 2 && list.All(item => item is long or double))
            return new[] { ToNumber(list[0]!), ToNumber(list[1]!) };
        return null;
    }

    private static double ToNumber(object value) =>
        value is double d ? d : Convert.ToDouble(value, CultureInfo.InvariantCulture);

    private static List<DatasourceTable> ParseDatasource(string yaml, List<TypeModel> types)
    {
        var root = YamlNode.FromYaml(yaml);
        var tables = root.NamedList("types").Select(entry =>
        {
            var unique = new List<string>();
            var indexes = new List<DatasourceIndex>();
            foreach (var index in entry.Node.NamedList("indexes"))
            {
                var rawFields = index.Node.Child("fields").Value as List<object?>;
                var fields = rawFields?.OfType<string>().ToList() ?? [];
                indexes.Add(new DatasourceIndex
                {
                    Name = index.Name,
                    Fields = fields,
                    IsUnique = index.Node.Bool("is_unique"),
                });
                if (index.Node.Bool("is_unique") && fields.Count == 1 && fields[0].Length > 0)
                    unique.Add(fields[0]);
            }
            var overlays = entry.Node.NamedList("fields").Select(field => new DatasourceFieldOverlay
            {
                Name = field.Name,
                IsReadonly = field.Node.Has("is_readonly") ? field.Node.Bool("is_readonly") : null,
                IsUnique = field.Node.Has("is_unique") ? field.Node.Bool("is_unique") : null,
                Mapping = string.IsNullOrEmpty(field.Node.Str("mapping")) ? null : field.Node.Str("mapping"),
                IsFixedId = field.Node.Has("is_fixed_id") ? field.Node.Bool("is_fixed_id") : null,
                IsOptimisticConcurrency = field.Node.Has("is_optimistic_concurrency")
                    ? field.Node.Bool("is_optimistic_concurrency") : null,
                UseNativeRowVersion = field.Node.Has("use_native_row_version")
                    ? field.Node.Bool("use_native_row_version") : null,
            }).ToList();
            return new DatasourceTable
            {
                Name = entry.Name,
                Mapping = string.IsNullOrEmpty(entry.Node.Str("mapping")) ? null : entry.Node.Str("mapping"),
                Fields = overlays,
                Indexes = indexes,
                UniqueIndexFields = unique,
                UseOptimisticConcurrency = entry.Node.Has("use_optimistic_concurrency")
                    ? entry.Node.Bool("use_optimistic_concurrency") : null,
            };
        }).ToList();

        var filter = TypesFilter(root);
        if (filter is null) return tables;
        var selected = types.Where(type => filter(new FilterCandidate
        {
            Name = type.Name,
            Tags = type.Tags,
            Inherits = type.Inherits,
        })).Select(type => type.Name).ToHashSet(StringComparer.Ordinal);
        var overlayNames = tables.Select(table => table.Name).ToHashSet(StringComparer.Ordinal);
        var extras = types.Where(type => selected.Contains(type.Name) && !overlayNames.Contains(type.Name))
            .Select(type => new DatasourceTable
            {
                Name = type.Name,
                Fields = [],
                Indexes = [],
                UniqueIndexFields = [],
            });
        return tables.Where(table => selected.Contains(table.Name)).Concat(extras).ToList();
    }

    private static Dictionary<string, IReadOnlyList<SeedRow>> ParseSeeds(string yaml)
    {
        var byTable = new Dictionary<string, IReadOnlyList<SeedRow>>(StringComparer.Ordinal);
        foreach (var entry in YamlNode.FromYaml(yaml).NamedList("seeds"))
        {
            byTable[entry.Name] = entry.Node.NamedItems().Select(row => new SeedRow
            {
                Id = ParseSeedKey(row.Name),
                Row = SeedCells(row.Node),
            }).ToList();
        }
        return byTable;
    }

    private static int ParseSeedKey(string rowKey)
    {
        var match = Regex.Match(rowKey, @"^id(\d+)$");
        if (!match.Success)
            throw new InvalidOperationException($"Invalid seed row key \"{rowKey}\": expected pattern /^id\\d+$/");
        return int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
    }

    private static Dictionary<string, object?> SeedCells(YamlNode node)
    {
        var output = new Dictionary<string, object?>(StringComparer.Ordinal);
        if (node.Record is null) return output;
        foreach (var key in node.Record.Keys)
        {
            var literal = node.Literal(key);
            if (literal.Present) output[key] = literal.Value;
        }
        return output;
    }

    private static Func<FilterCandidate, bool>? TypesFilter(YamlNode root)
    {
        var block = IncludeBlock(root, "types");
        return block is null ? null : CompileFilter.CompileTypes(block.Str("filter"));
    }

    private static YamlNode? IncludeBlock(YamlNode root, string key)
    {
        foreach (var entry in root.Child("includes").Items())
        {
            if (entry.Child(key).IsMap) return entry.Child(key);
        }
        return null;
    }

    private static ParsedServices ParseServices(
        string servicesYaml,
        List<TypeModel> types,
        List<DatasourceTable> datasource,
        string? routesYaml,
        Func<string, string> serviceClassName)
    {
        var root = YamlNode.FromYaml(servicesYaml);
        var raw = new List<(string Name, string? Module)>();
        foreach (var entry in root.Child("services").Items())
        {
            var name = entry.Str("name");
            if (name is null) continue;
            raw.Add((name, entry.Str("module")));
        }
        var customs = raw.Where(service => service.Module is null || !service.Module.StartsWith("./services/generated/", StringComparison.Ordinal)).ToList();
        var explicitNames = customs.Select(service => service.Name).ToHashSet(StringComparer.Ordinal);
        var methods = CollectRouteServiceMethods(routesYaml);
        var dsByName = datasource.ToDictionary(table => table.Name, StringComparer.Ordinal);
        var predicate = TypesFilter(root);
        var generics = new List<ServiceCandidate>();
        if (predicate is not null)
        {
            var compare = TypeTrees.CompareByDatasourceTypeOrder(types, name => types.Find(type => type.Name == name)?.Inherits);
            generics = types.Where(type => predicate(new FilterCandidate
            {
                Name = type.Name,
                Tags = type.Tags,
                Inherits = type.Inherits,
            }))
            .Where(type => !explicitNames.Contains(serviceClassName(type.Name)))
            .OrderBy(type => type.Name, Comparer<string>.Create((a, b) => compare(a, b)))
            .Select(type => new ServiceCandidate
            {
                Name = type.Name,
                Tags = type.Tags,
                Inherits = type.Inherits,
                ByFields = Specification.UniqueLookupFields(type, dsByName.GetValueOrDefault(type.Name)),
            }).ToList();
        }
        return new ParsedServices
        {
            Generics = generics,
            Customs = customs.Select(entry => new CustomServiceEntry
            {
                Name = entry.Name,
                Module = entry.Module,
                Methods = methods.TryGetValue(entry.Name, out var set) ? set.Order(StringComparer.Ordinal).ToList() : [],
            }).ToList(),
        };
    }

    private static ParsedRoutes ParseRoutes(string routesYaml, List<TypeModel> types, List<DatasourceTable> datasource)
    {
        var root = YamlNode.FromYaml(routesYaml);
        var dsByName = datasource.ToDictionary(table => table.Name, StringComparer.Ordinal);
        var typeByName = types.ToDictionary(type => type.Name, StringComparer.Ordinal);
        var overlays = EntityOverlays(root);
        var all = types.Select(type =>
        {
            overlays.TryGetValue(type.Name, out var overlay);
            return new RouteCandidate
            {
                Name = type.Name,
                Tags = type.Tags,
                Inherits = type.Inherits,
                ByFields = [],
                EagerReadPath = overlay?.Read,
                EagerUpdatePath = overlay?.Update,
                EagerReadMemberOnly = overlay?.Member,
            };
        }).ToList();
        var childrenOnly = CollectCombinedChildNames(root, typeByName);
        AttachByFields(all, root, dsByName, typeByName);
        var customs = ExtractCustomRoutes(root, typeByName);
        var nested = CollectNested(root, typeByName);
        var predicate = TypesFilter(root);
        var candidates = new List<RouteCandidate>();
        if (predicate is not null)
        {
            var compare = TypeTrees.CompareByDatasourceTypeOrder(types, name =>
                typeByName.TryGetValue(name, out var type) ? type.Inherits : null);
            candidates = all.Where(candidate => predicate(new FilterCandidate
            {
                Name = candidate.Name,
                Tags = candidate.Tags,
                Inherits = candidate.Inherits,
            }))
            .Where(candidate => !childrenOnly.Contains(candidate.Name))
            .OrderBy(candidate => candidate.Name, Comparer<string>.Create((a, b) => compare(a, b)))
            .ToList();
        }
        return new ParsedRoutes
        {
            Candidates = candidates,
            Customs = customs,
            Nested = nested,
            ChildrenOnly = childrenOnly,
            Datasource = datasource,
        };
    }

    private sealed record Overlay(List<string>? Read, List<string>? Update, List<string>? Member);

    private static Dictionary<string, Overlay> EntityOverlays(YamlNode root)
    {
        var output = new Dictionary<string, Overlay>(StringComparer.Ordinal);
        foreach (var entry in root.NamedList("routes"))
        {
            var read = entry.Node.Strings("eager_read_path").ToList();
            var update = entry.Node.Strings("eager_update_path").ToList();
            var member = entry.Node.Strings("eager_read_member_only").ToList();
            if (read.Count + update.Count + member.Count == 0) continue;
            output[entry.Name] = new Overlay(
                read.Count > 0 ? read : null,
                update.Count > 0 ? update : null,
                member.Count > 0 ? member : null);
        }
        return output;
    }

    private static Dictionary<string, HashSet<string>> CollectRouteServiceMethods(string? routesYaml)
    {
        var byService = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        if (routesYaml is null) return byService;
        var root = YamlNode.FromYaml(routesYaml);
        void Visit(YamlNode node)
        {
            if (node.Value is List<object?>)
            {
                foreach (var item in node.Items()) Visit(item);
                return;
            }
            if (!node.IsMap) return;
            var service = node.Str("service");
            var function = node.Str("function");
            if (service is not null && function is not null)
            {
                if (!byService.TryGetValue(service, out var set))
                {
                    set = new HashSet<string>(StringComparer.Ordinal);
                    byService[service] = set;
                }
                set.Add(function);
            }
            if (node.Record is null) return;
            foreach (var key in node.Record.Keys) Visit(node.Child(key));
        }
        Visit(root.Child("routes"));
        Visit(root.Child("combined_routes"));
        return byService;
    }

    private static string SpecName(string raw) => raw.Replace('-', '_');

    private static string ShorthandField(string raw) =>
        Regex.Replace(SpecName(raw), "([a-z0-9])([A-Z])", "$1_$2").ToLowerInvariant();

    private static string SpecPlural(string name)
    {
        var parts = SpecName(name).Split('_');
        parts[^1] = Pluralize.Plural(parts[^1]);
        return string.Join('_', parts);
    }

    private static string SingularizeLast(string snakePlural)
    {
        var parts = snakePlural.Split('_');
        parts[^1] = Pluralize.Singular(parts[^1]);
        return string.Join('_', parts);
    }

    private static string DefaultParentBase(string parent) => $"/api/{SpecPlural(parent)}/{{id}}";
    private static string SegmentTail(string segment) => segment.Split('/').LastOrDefault(part => part.Length > 0) ?? "";
    private static string DefaultChildSegment(string name) => $"/{SpecPlural(name)}";

    private static bool ColumnIsUnique(DatasourceTable? table, TypeModel? type, string column)
    {
        if (column == Specification.PrimaryKeyColumn(table, type)) return true;
        if (table?.Fields.Any(field => field.Name == column && field.IsUnique == true) == true) return true;
        return table?.UniqueIndexFields.Contains(column) ?? false;
    }

    private static bool EntityHasField(TypeModel type, string field) =>
        field == "id" || type.Fields.Any(item => item.Name == field);

    private readonly record struct ByFieldParsed(string Entity, string ByField, List<string>? Methods);

    private static ByFieldParsed? ParseByFieldEntry(object? entry, Dictionary<string, TypeModel> typeByName)
    {
        if (entry is null) return null;
        if (entry is string token) return ParseShorthand(token, typeByName);
        if (entry is not Dictionary<string, object?> record || record.Count == 0) return null;
        var pair = record.First();
        if (pair.Value is null) return ParseShorthand(pair.Key, typeByName);
        if (pair.Value is not Dictionary<string, object?> def) return null;
        if (def.ContainsKey("entity") && def.ContainsKey("byField")) return ParseVerbose(pair.Key, def);
        return null;
    }

    private static ByFieldParsed ParseShorthand(string token, Dictionary<string, TypeModel> typeByName)
    {
        if (token.Length == 0)
            throw new InvalidOperationException("parseByFieldEntry: expected non-empty string token");
        var match = ShorthandVerb.Match(token);
        List<string>? methods = null;
        var body = token;
        if (match.Success)
        {
            methods = [.. VerbToMethods[match.Groups[1].Value.ToLowerInvariant()]];
            body = token[match.Length..];
        }
        var split = body.LastIndexOf("_by_", StringComparison.Ordinal);
        if (split < 0)
            throw new InvalidOperationException($"parseByFieldEntry: route key `{token}` is missing `_by_` separator");
        var plural = body[..split];
        var fieldToken = body[(split + "_by_".Length)..];
        if (plural.Length == 0 || fieldToken.Length == 0)
            throw new InvalidOperationException($"parseByFieldEntry: route key `{token}` has empty entity or field around `_by_`");
        var entity = SingularizeLast(plural);
        var byField = ShorthandField(fieldToken);
        if (!typeByName.TryGetValue(entity, out var type))
            throw new InvalidOperationException($"parseByFieldEntry: unknown entity `{entity}` in route `{token}`");
        if (!EntityHasField(type, byField))
            throw new InvalidOperationException($"parseByFieldEntry: field `{byField}` not found on entity `{entity}` in route `{token}`");
        return new ByFieldParsed(entity, byField, methods);
    }

    private static ByFieldParsed ParseVerbose(string key, Dictionary<string, object?> def)
    {
        if (def.GetValueOrDefault("entity") is not string entity || def.GetValueOrDefault("byField") is not string byField)
            throw new InvalidOperationException($"parseByFieldEntry: route `{key}` has non-string entity/byField");
        List<string>? methods = null;
        if (def.GetValueOrDefault("methods") is List<object?> list)
            methods = list.OfType<string>().ToList();
        return new ByFieldParsed(entity, byField, methods);
    }

    private static string? RefParent(object? references)
    {
        if (references is not string text) return null;
        var head = text.Split('.')[0];
        return head;
    }

    private static bool RefMatchesParent(string target, string parent, Dictionary<string, TypeModel> typeByName) =>
        parent == target || InheritsChain(parent, typeByName).Contains(target);

    private static List<TypeField> FkFields(TypeModel type, Dictionary<string, TypeModel> typeByName)
    {
        var fields = new List<TypeField>(type.Fields);
        foreach (var ancestor in InheritsChain(type.Name, typeByName))
        {
            if (typeByName.TryGetValue(ancestor, out var parent)) fields.AddRange(parent.Fields);
        }
        return fields;
    }

    private static string? FindForeignKeyTo(TypeModel child, string parentName, Dictionary<string, TypeModel> typeByName)
    {
        foreach (var field in FkFields(child, typeByName))
        {
            var target = RefParent(field.References);
            if (target is not null && RefMatchesParent(target, parentName, typeByName)) return field.Name;
        }
        return null;
    }

    private readonly record struct NormalizedChild(string Name, string? Via, string? Target, string? Route);

    private static NormalizedChild? NormalizeChild(object child)
    {
        if (child is string text)
            return new NormalizedChild(SpecName(text), null, null, null);
        if (child is not Dictionary<string, object?> record || record.Count == 0) return null;
        var pair = record.First();
        var def = pair.Value as Dictionary<string, object?>;
        return new NormalizedChild(
            SpecName(pair.Key),
            def?.GetValueOrDefault("via") as string,
            def?.GetValueOrDefault("target") as string,
            def?.GetValueOrDefault("route") as string);
    }

    private static HashSet<string> CollectCombinedChildNames(YamlNode root, Dictionary<string, TypeModel> typeByName)
    {
        var childrenOnly = new HashSet<string>(StringComparer.Ordinal);
        var parents = root.NamedList("combined_routes").Select(entry => entry.Name).ToHashSet(StringComparer.Ordinal);
        foreach (var entry in root.NamedList("combined_routes"))
        {
            var combines = entry.Node.Child("combines").Value as List<object?> ?? [];
            foreach (var child in combines)
            {
                string childName;
                if (child is string text) childName = SpecName(text);
                else if (child is Dictionary<string, object?> record && record.Count > 0)
                {
                    var pair = record.First();
                    var def = pair.Value as Dictionary<string, object?>;
                    if (def is not null && (def.ContainsKey("via") || def.ContainsKey("target"))) continue;
                    childName = SpecName(pair.Key);
                }
                else continue;
                if (parents.Contains(childName)) continue;
                if (!typeByName.TryGetValue(childName, out var childType)) continue;
                if (FindForeignKeyTo(childType, entry.Name, typeByName) is not null) childrenOnly.Add(childName);
            }
        }
        return childrenOnly;
    }

    private static void UpsertByField(
        List<RouteByField> list,
        ByFieldParsed parsed,
        Dictionary<string, DatasourceTable> dsByName,
        Dictionary<string, TypeModel> typeByName)
    {
        var existing = list.Find(entry => entry.ByField == parsed.ByField);
        if (existing is not null)
        {
            if (existing.Methods is null || parsed.Methods is null) existing.Methods = null;
            else
            {
                foreach (var method in parsed.Methods)
                {
                    if (!existing.Methods.Contains(method)) existing.Methods.Add(method);
                }
            }
            return;
        }
        dsByName.TryGetValue(parsed.Entity, out var table);
        typeByName.TryGetValue(parsed.Entity, out var type);
        list.Add(new RouteByField
        {
            ByField = parsed.ByField,
            Methods = parsed.Methods,
            ByFieldUnique = ColumnIsUnique(table, type, parsed.ByField),
        });
    }

    private static void AttachByFields(
        List<RouteCandidate> candidates,
        YamlNode root,
        Dictionary<string, DatasourceTable> dsByName,
        Dictionary<string, TypeModel> typeByName)
    {
        var byEntity = new Dictionary<string, List<RouteByField>>(StringComparer.Ordinal);
        foreach (var entry in root.Child("routes").Items())
        {
            var parsed = ParseByFieldEntry(entry.Value, typeByName);
            if (parsed is null) continue;
            if (!byEntity.TryGetValue(parsed.Value.Entity, out var list))
            {
                list = [];
                byEntity[parsed.Value.Entity] = list;
            }
            UpsertByField(list, parsed.Value, dsByName, typeByName);
        }
        foreach (var candidate in candidates)
        {
            if (byEntity.TryGetValue(candidate.Name, out var list) && list.Count > 0)
                candidate.ByFields = list;
        }
    }

    private static List<CustomRouteEntry> ExtractCustomRoutes(YamlNode root, Dictionary<string, TypeModel> typeByName)
    {
        var customs = new List<CustomRouteEntry>();
        foreach (var entry in root.Child("routes").Items())
        {
            if (!entry.IsMap) continue;
            if (ParseByFieldEntry(entry.Value, typeByName) is not null) continue;
            if (entry.Record!.Count == 0) continue;
            var name = entry.Record.Keys.First();
            var node = entry.Child(name);
            if (node.Has("eager_read_path") || node.Has("eager_update_path") || node.Has("eager_read_member_only"))
                continue;
            if (node.Str("path") is null) continue;
            customs.Add(new CustomRouteEntry
            {
                Name = name,
                Path = node.Str("path"),
                Method = node.Str("method"),
                Entity = node.Str("entity"),
                Request = node.Str("request"),
                Response = node.Str("response"),
                Module = node.Str("module"),
                RouteClass = node.Str("routeClass"),
            });
        }
        return customs;
    }

    private readonly record struct JunctionMatch(string Name, string ParentFk, string ChildFk);

    private static JunctionMatch? DetectJunction(string parentName, string childName, Dictionary<string, TypeModel> typeByName)
    {
        var matches = new List<JunctionMatch>();
        foreach (var (name, def) in typeByName)
        {
            if (name == parentName || name == childName) continue;
            if (!def.Tags.Contains("many_to_many")) continue;
            var parentFk = FindForeignKeyTo(def, parentName, typeByName);
            var childFk = FindForeignKeyTo(def, childName, typeByName);
            if (parentFk is not null && childFk is not null)
                matches.Add(new JunctionMatch(name, parentFk, childFk));
        }
        if (matches.Count == 0) return null;
        if (matches.Count > 1)
        {
            var candidates = string.Join(", ", matches.Select(match => match.Name));
            throw new InvalidOperationException(
                $"combined_routes: ambiguous junction between \"{parentName}\" and \"{childName}\" — candidates: {candidates}. Add via: to disambiguate.");
        }
        return matches[0];
    }

    private static M2mDescriptor M2m(string parentName, string parentBase, string junction, string target, string parentFk, string childFk, string? route)
    {
        var segment = route ?? DefaultChildSegment(target);
        return new M2mDescriptor
        {
            Kind = "m2m",
            Parent = parentName,
            ParentBasePath = parentBase,
            ParentParam = parentName,
            Junction = junction,
            Target = target,
            TargetParam = target,
            ParentFkField = parentFk,
            ChildFkField = childFk,
            Segment = segment,
            SegmentTail = SegmentTail(segment),
        };
    }

    private static DirectFkDescriptor Direct(string parentName, string parentBase, string childName, string fk, string? route)
    {
        var segment = route ?? DefaultChildSegment(childName);
        return new DirectFkDescriptor
        {
            Kind = "direct-fk",
            Parent = parentName,
            ParentBasePath = parentBase,
            ParentParam = parentName,
            Child = new ChildRef { Name = childName },
            FkColumn = fk,
            Segment = segment,
            SegmentTail = SegmentTail(segment),
        };
    }

    private static List<NestedRouteDescriptor> CollectNested(YamlNode root, Dictionary<string, TypeModel> typeByName)
    {
        var nested = new List<NestedRouteDescriptor>();
        foreach (var entry in root.NamedList("combined_routes"))
        {
            var route = entry.Node.Str("route");
            var parentBase = !string.IsNullOrEmpty(route) ? route : DefaultParentBase(entry.Name);
            var combines = entry.Node.Child("combines").Value as List<object?> ?? [];
            foreach (var raw in combines)
            {
                if (raw is null) continue;
                if (NormalizeChild(raw) is not { } child) continue;
                if (child.Via is not null || child.Target is not null)
                {
                    if (string.IsNullOrEmpty(child.Via) || string.IsNullOrEmpty(child.Target))
                        throw new InvalidOperationException(
                            $"combined_routes: M2M child must declare both via: and target: (parent={entry.Name}, child={child.Name})");
                    if (!typeByName.TryGetValue(child.Via, out var junction))
                        throw new InvalidOperationException($"combined_routes: junction \"{child.Via}\" not found in types.yaml");
                    var parentFk = FindForeignKeyTo(junction, entry.Name, typeByName);
                    var childFk = FindForeignKeyTo(junction, child.Target, typeByName);
                    if (parentFk is null || childFk is null)
                        throw new InvalidOperationException(
                            $"combined_routes: junction \"{child.Via}\" missing FK to {entry.Name}/{child.Target}");
                    nested.Add(M2m(entry.Name, parentBase!, child.Via, child.Target, parentFk, childFk, child.Route));
                    continue;
                }
                if (!typeByName.TryGetValue(child.Name, out var childDef))
                    throw new InvalidOperationException($"combined_routes: child \"{child.Name}\" not found in types.yaml");
                var fk = FindForeignKeyTo(childDef, entry.Name, typeByName);
                if (fk is not null)
                {
                    nested.Add(Direct(entry.Name, parentBase!, child.Name, fk, child.Route));
                    continue;
                }
                var junctionMatch = DetectJunction(entry.Name, child.Name, typeByName);
                if (junctionMatch is not null)
                {
                    nested.Add(M2m(entry.Name, parentBase!, junctionMatch.Value.Name, child.Name, junctionMatch.Value.ParentFk, junctionMatch.Value.ChildFk, child.Route));
                    continue;
                }
                throw new InvalidOperationException(
                    $"combined_routes: child \"{child.Name}\" has no FK to parent \"{entry.Name}\" and no detectable junction table in types.yaml");
            }
        }
        return nested;
    }
}
