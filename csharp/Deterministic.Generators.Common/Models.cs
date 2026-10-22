namespace Deterministic.Generators.Common;

public sealed class FieldTypeParts
{
    public required string Kind { get; init; }
    public required string Base { get; init; }
    public bool IsArray { get; init; }
    public bool IsMap { get; init; }
}

public sealed class TypeField
{
    public required string Name { get; init; }
    public required string Type { get; init; }
    public required string Kind { get; init; }
    public required string Base { get; init; }
    public bool IsArray { get; init; }
    public bool IsMap { get; init; }
    public bool IsNullable { get; init; }
    public bool? IsId { get; init; }
    public object? Size { get; init; }
    public bool HasSize { get; init; }
    public int? MinSize { get; init; }
    public object? References { get; init; }
    public bool HasDefault { get; init; }
    public object? DefaultValue { get; init; }
    public bool DefaultIsLiteral { get; init; }
}

public sealed class TypeModel
{
    public required string Name { get; init; }
    public List<string> Tags { get; init; } = [];
    public required string Kind { get; init; }
    public string? Inherits { get; init; }
    public List<string>? Union { get; init; }
    public Dictionary<string, string>? Mapping { get; init; }
    public List<string>? Extract { get; init; }
    public List<string>? RemoveFields { get; init; }
    public List<string>? Ids { get; init; }
    public List<TypeField> Fields { get; init; } = [];
}

public sealed class DatasourceFieldOverlay
{
    public required string Name { get; init; }
    public bool? IsReadonly { get; init; }
    public bool? IsUnique { get; init; }
    public string? Mapping { get; init; }
    public bool? IsFixedId { get; init; }
    public bool? IncludeInCreate { get; init; }
    public bool? IncludeInUpdate { get; init; }
    public bool? IsOptimisticConcurrency { get; init; }
    public bool? UseNativeRowVersion { get; init; }
}

public sealed class DatasourceIndex
{
    public required string Name { get; init; }
    public List<string> Fields { get; init; } = [];
    public bool IsUnique { get; init; }
}

public sealed class DatasourceTable
{
    public required string Name { get; init; }
    public string? Mapping { get; init; }
    public List<DatasourceFieldOverlay> Fields { get; init; } = [];
    public List<DatasourceIndex> Indexes { get; init; } = [];
    public List<string> UniqueIndexFields { get; init; } = [];
    public bool? UseOptimisticConcurrency { get; init; }
}

public sealed class SeedRow
{
    public required int Id { get; init; }
    public Dictionary<string, object?> Row { get; init; } = [];
}

public sealed class ServiceByField
{
    public required string Field { get; init; }
    public required string Type { get; init; }
    public int? Size { get; init; }
}

public sealed class ServiceCandidate
{
    public required string Name { get; init; }
    public List<string> Tags { get; init; } = [];
    public string? Inherits { get; init; }
    public List<ServiceByField> ByFields { get; init; } = [];
}

public sealed class CustomServiceEntry
{
    public required string Name { get; init; }
    public string? Module { get; init; }
    public List<string> Methods { get; init; } = [];
}

public sealed class ParsedServices
{
    public List<ServiceCandidate> Generics { get; init; } = [];
    public List<CustomServiceEntry> Customs { get; init; } = [];
}

public sealed class RouteByField
{
    public required string ByField { get; init; }
    public List<string>? Methods { get; set; }
    public bool ByFieldUnique { get; init; }
}

public sealed class RouteCandidate
{
    public required string Name { get; init; }
    public List<string> Tags { get; init; } = [];
    public string? Inherits { get; init; }
    public List<RouteByField> ByFields { get; set; } = [];
    public List<string>? EagerReadPath { get; init; }
    public List<string>? EagerUpdatePath { get; init; }
    public List<string>? EagerReadMemberOnly { get; init; }
}

public sealed class CustomRouteEntry
{
    public required string Name { get; init; }
    public string? Path { get; init; }
    public string? Method { get; init; }
    public string? Entity { get; init; }
    public string? Request { get; init; }
    public string? Response { get; init; }
    public string? Module { get; init; }
    public string? RouteClass { get; init; }
}

public abstract class NestedRouteDescriptor
{
    public required string Kind { get; init; }
    public required string Parent { get; init; }
    public required string ParentParam { get; init; }
    public required string ParentBasePath { get; init; }
    public required string Segment { get; init; }
    public required string SegmentTail { get; init; }
}

public sealed class DirectFkDescriptor : NestedRouteDescriptor
{
    public required ChildRef Child { get; init; }
    public required string FkColumn { get; init; }
}

public sealed class ChildRef
{
    public required string Name { get; init; }
}

public sealed class M2mDescriptor : NestedRouteDescriptor
{
    public required string Junction { get; init; }
    public required string Target { get; init; }
    public required string TargetParam { get; init; }
    public required string ParentFkField { get; init; }
    public required string ChildFkField { get; init; }
}

public sealed class ParsedRoutes
{
    public List<RouteCandidate> Candidates { get; init; } = [];
    public List<CustomRouteEntry> Customs { get; init; } = [];
    public List<NestedRouteDescriptor> Nested { get; init; } = [];
    public HashSet<string> ChildrenOnly { get; init; } = [];
    public List<DatasourceTable> Datasource { get; init; } = [];
}

public interface IDeterministic
{
    IReadOnlyList<TypeModel> Types { get; }
    IReadOnlyList<TypeModel> ExpandedTypes { get; }
    IReadOnlyList<DatasourceTable> Datasource { get; }
    IReadOnlyDictionary<string, IReadOnlyList<SeedRow>> DatasourceSeeds { get; }
    ParsedServices Services { get; }
    ParsedRoutes Routes { get; }
}

public sealed class Deterministic : IDeterministic
{
    public Deterministic(IDeterministic source)
    {
        Types = source.Types;
        ExpandedTypes = source.ExpandedTypes;
        Datasource = source.Datasource;
        DatasourceSeeds = source.DatasourceSeeds;
        Services = source.Services;
        Routes = source.Routes;
    }

    public Deterministic(
        IReadOnlyList<TypeModel> types,
        IReadOnlyList<TypeModel> expandedTypes,
        IReadOnlyList<DatasourceTable> datasource,
        IReadOnlyDictionary<string, IReadOnlyList<SeedRow>> datasourceSeeds,
        ParsedServices services,
        ParsedRoutes routes)
    {
        Types = types;
        ExpandedTypes = expandedTypes;
        Datasource = datasource;
        DatasourceSeeds = datasourceSeeds;
        Services = services;
        Routes = routes;
    }

    public IReadOnlyList<TypeModel> Types { get; }
    public IReadOnlyList<TypeModel> ExpandedTypes { get; }
    public IReadOnlyList<DatasourceTable> Datasource { get; }
    public IReadOnlyDictionary<string, IReadOnlyList<SeedRow>> DatasourceSeeds { get; }
    public ParsedServices Services { get; }
    public ParsedRoutes Routes { get; }
}
