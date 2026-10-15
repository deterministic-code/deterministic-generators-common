using Xunit;

[assembly: CollectionBehavior(DisableTestParallelization = true)]

namespace Deterministic.Generators.Common.Tests;

public class GapTests
{
    [Fact]
    public async Task Remaining_parser_and_seed_edges()
    {
        Assert.Contains("unterminated", IncludeFilters.Parse("type == \"a\\\"") ?? "");
        Assert.Null(IncludeFilters.Parse("type == \"a\\\"b\""));

        var types = """
            types:
              - user:
                  inherits: set
                  tags: [datasource_type]
                  fields:
                    - email: {type: string}
              - role:
                  inherits: set
                  tags: [datasource_type]
                  fields:
                    - name: {type: string}
              - link:
                  inherits: set
                  tags: [datasource_type, many_to_many]
                  fields:
                    - user_id: {type: integer, references: user.id}
                    - role_id: {type: integer, references: role.id}
              - bag:
                  inherits: dictionary
                  fields:
                    - value: {type: string}
            """;
        var routes = """
            combined_routes:
              - user:
                  route: /
                  combines:
                    - role:
                        route: /
            """;
        var det = await new DeterministicParser(new MemoryReader(new Dictionary<string, string>
        {
            ["types.yaml"] = types,
            ["routes.yaml"] = routes,
        })).Parse(new Dictionary<string, string>());
        Assert.Contains(det.Routes.Nested, route => route is M2mDescriptor);
        Assert.Equal("", det.Routes.Nested[0].SegmentTail);

        var dict = TypeModelSemantics.Check(Doc("""
            types:
              - bag:
                  inherits: dictionary
                  fields:
                    - value: {type: string}
            """));
        Assert.Contains(dict.Errors, error => error.Message.Contains("key field"));

        var seeds = SeedSemantics.Check(Doc("""
            seeds:
              - user:
                  - id1:
                      name: -1
                      title: hello
                      amount: true
                      flag: 1
                      count: 1.5
              - role: []
            """), YamlData.Plain(YamlDocuments.Parse("""
            types:
              - user:
                  fields:
                    - name: {type: unsignedinteger}
                    - title: {type: string, references: role.name}
                    - amount: {type: biginteger}
                    - flag: {type: boolean}
                    - count: {type: integer}
                    - extra: {type: mystery}
              - role:
                  fields:
                    - name: {type: string}
            """).Root), YamlData.Plain(YamlDocuments.Parse("""
            types:
              - user: {}
              - {}
            includes:
              - types: {}
            """).Root), true);
        var text = string.Join("\n", seeds.Errors.Select(error => error.Message));
        Assert.Contains("must be integer", text);
        Assert.Contains("must be string or number", text);

        var spec = await SpecPaths.ResolveSpecPath("backend", "types.spec.yaml");
        var validator = new SpecValidator(async () => spec, (_, _) => Task.FromResult(SpecValidationResult.Ok()));
        Assert.True((await validator.Validate("version: 1.0.0\ntypes: []\n")).Valid);

        var options = new ValidateOptions();
        var withDatasource = options.With(datasource: "d", setDatasource: true, includeBasePath: "b");
        Assert.Equal("d", withDatasource.Datasource);
        Assert.Equal("b", withDatasource.IncludeBasePath);
        Assert.Null(withDatasource.Types);
    }

    static ParsedYaml Doc(string yaml)
    {
        var parsed = YamlDocuments.Parse(yaml);
        return new ParsedYaml { Root = parsed.Root, Data = YamlData.Plain(parsed.Root) };
    }
}
