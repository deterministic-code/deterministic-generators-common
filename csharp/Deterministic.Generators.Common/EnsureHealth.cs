namespace Deterministic.Generators.Common;

public static class EnsureHealth
{
    public const string HealthServiceName = "HealthCheckService";
    public const string HealthServiceMethod = "check";
    public const string HealthRouteName = "getHealth";
    public const string HealthRoutePath = "/api/health";
    public const string HEALTH_SERVICE_NAME = HealthServiceName;
    public const string HEALTH_SERVICE_METHOD = HealthServiceMethod;
    public const string HEALTH_ROUTE_NAME = HealthRouteName;
    public const string HEALTH_ROUTE_PATH = HealthRoutePath;

    public static IDeterministic Apply(IDeterministic deterministic) =>
        new Deterministic(
            deterministic.Types,
            deterministic.ExpandedTypes,
            deterministic.Datasource,
            deterministic.DatasourceSeeds,
            new ParsedServices
            {
                Generics = deterministic.Services.Generics,
                Customs = Prepend(
                    deterministic.Services.Customs,
                    service => service.Name == HealthServiceName,
                    new CustomServiceEntry
                    {
                        Name = HealthServiceName,
                        Methods = [HealthServiceMethod],
                    }),
            },
            new ParsedRoutes
            {
                Candidates = deterministic.Routes.Candidates,
                Customs = Prepend(
                    deterministic.Routes.Customs,
                    route => route.Path == HealthRoutePath,
                    new CustomRouteEntry
                    {
                        Name = HealthRouteName,
                        Path = HealthRoutePath,
                        Method = "GET",
                        Entity = null,
                    }),
                Nested = deterministic.Routes.Nested,
                ChildrenOnly = deterministic.Routes.ChildrenOnly,
                Datasource = deterministic.Routes.Datasource,
            });

    private static List<T> Prepend<T>(IReadOnlyList<T> list, Func<T, bool> match, T seed)
    {
        var index = -1;
        for (var i = 0; i < list.Count; i++)
        {
            if (!match(list[i])) continue;
            index = i;
            break;
        }
        if (index == 0) return [.. list];
        if (index > 0)
        {
            var moved = new List<T> { list[index] };
            moved.AddRange(list.Take(index));
            moved.AddRange(list.Skip(index + 1));
            return moved;
        }
        var inserted = new List<T> { seed };
        inserted.AddRange(list);
        return inserted;
    }
}
