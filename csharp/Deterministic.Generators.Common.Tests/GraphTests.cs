using System.Text.Json.Nodes;
using Json.Schema;
using YamlDotNet.Core;
using YamlDotNet.Core.Events;
using Xunit;

namespace Deterministic.Generators.Common.Tests;

public class GraphTests
{
    sealed class EventParser(ParsingEvent? current) : IParser
    {
        public ParsingEvent? Current { get; } = current;
        public bool MoveNext() => false;
    }

    static ParsedYaml Of(object? data) => new() { Root = null, Data = data };

    static Dictionary<string, object?> Map(params (string Key, object? Value)[] pairs)
    {
        var dict = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var (key, value) in pairs) dict[key] = value;
        return dict;
    }

    static List<object?> List(params object?[] items) => [.. items];

    [Fact]
    public void Yaml_events_plural_and_pointers()
    {
        Assert.ThrowsAny<Exception>(() =>
            YamlDocuments.ReadNode(new EventParser(new DocumentEnd(false)), new Dictionary<string, YamlValue>()));
        var alias = YamlDocuments.Parse("a: &id 1\nb: *id\n");
        Assert.NotNull(alias.Root);

        Assert.Equal("", Pluralize.RestoreCase("Ab", ""));
        Assert.Equal("AB", Pluralize.RestoreCase("AB", "ab"));
        Assert.Equal("Ab", Pluralize.RestoreCase("Ab", "ab"));
        Assert.Equal("ab", Pluralize.RestoreCase("ab", "AB"));
        Assert.Equal("ab", Pluralize.RestoreCase("ab", "ab"));
        Assert.Equal("x", Pluralize.RestoreCase("", "x"));

        var node = YamlNode.FromYaml("a: 1\n");
        Assert.True(node.Has("a"));
        Assert.False(node.Has("b"));
        Assert.False(YamlNode.FromYaml("1").Has("a"));

        var obj = JsonNode.Parse("""{"a":1}""")!;
        Assert.NotNull(SchemaEngine.InstanceAt(obj, "a"));
        Assert.NotNull(SchemaEngine.SchemaAt(obj, "#a"));
        var schema = JsonSchema.FromText("""{"type":"object","additionalProperties":false,"properties":{}}""");
        var issues = SchemaEngine.Evaluate(schema, JsonNode.Parse("""{"extra":1}"""));
        Assert.NotEmpty(issues);
        _ = SchemaEngine.Evaluate(schema, JsonNode.Parse("{}"));
    }

    [Fact]
    public void Datasource_seed_shapes()
    {
        var shapes = new object?[]
        {
            null,
            "nope",
            Map(),
            Map(("types", 1)),
            Map(("types", List(1, Map(), Map(("person", 1))))),
            Map(("types", List(Map(("person", Map(
                ("fields", 1),
                ("indexes", 1),
                ("inherits", 1))))))),
            Map(("types", List(Map(("person", Map(
                ("fields", List(1, Map(("name", 1), ("version", Map(("type", "binary"), ("is_optimistic_concurrency", true)))))),
                ("indexes", List(
                    1,
                    Map(("by", 1)),
                    Map(("by", Map(("fields", 1)))),
                    Map(("by", Map(("fields", List("missing", "name"))))),
                    Map(("by", Map(("fields", List("name"))))))),
                ("inherits", "parent"))))))),
        };
        foreach (var shape in shapes)
        {
            _ = DatasourceModel.CheckModel(Of(shape), null, false);
            var companion = Map(("types", List(1, Map(("person", Map(("fields", List(Map(("name", Map(("type", "string"))))))))))));
            _ = DatasourceModel.CheckModel(Of(shape), companion, true);
            _ = SeedSemantics.Check(Of(shape), null, null, false);
            _ = SeedSemantics.Check(Of(shape), shape, null, false);
            _ = SeedSemantics.Check(Of(shape), shape, shape, true);
            _ = SeedSemantics.Needs(shape);
            _ = RouteModel.Check(Of(shape));
            _ = ServiceModel.Check(Of(shape));
            _ = TypeModelSemantics.Check(Of(shape));
            _ = IncludeFilters.Check(Of(shape));
            _ = TypeModelSemantics.IndexFields(shape);
        }

        var seeds = SeedSemantics.Check(Doc("""
seeds:
  - user:
      - row:
          ref: 1
          ratio: nope
          big: 4
          dec: 1
"""), Doc("""
types:
  - person:
      fields:
        - email:
            type: string
  - user:
      fields:
        - ref:
            references: person.email
        - ratio:
            type: float
        - big:
            type: unsignedbiginteger
        - dec:
            type: decimal
        - missing:
            type: string
""").Data, null, false);
        Assert.False(seeds.Valid);
    }

    static ParsedYaml Doc(string yaml)
    {
        var parsed = YamlDocuments.Parse(yaml);
        return new ParsedYaml { Root = parsed.Root, Data = YamlData.Plain(parsed.Root) };
    }

    [Fact]
    public void Semantics_and_specification_shapes()
    {
        var catalog = new Dictionary<string, FieldCatalog.FieldType>
        {
            ["integer"] = new()
            {
                Name = "integer",
                MinValue = "0",
                MaxValue = "10",
                Defaults = [new FieldCatalog.DefaultToken { Token = "now", Regex = "^now$" }],
            },
            ["character"] = new() { Name = "character", MinValue = null, MaxValue = null },
        };
        foreach (var expr in new[]
        {
            "type == \"a\" && )",
            "type == \"a\" || )",
            "tag != \"a\" && inherits == \"b\"",
            "nope",
            "type",
            "(type == \"a\"",
            "type == \"a\")",
            "",
        })
        {
            _ = IncludeFilters.Parse(expr);
            _ = IncludeFilters.Match(expr, new FilterCandidate { Name = "a", Tags = ["a"], Inherits = "b" });
        }

        var defaults = Doc("""
types:
  - []
  - user: 1
  - user:
      fields: 1
  - user:
      fields:
        - []
        - name: 1
        - count:
            type: integer
            default_value: 20
        - ok:
            type: integer
            default_value: 3
        - blank:
            type: integer
            default_value: null
        - word:
            type: integer
            default_value: now
        - badword:
            type: integer
            default_value: later
        - code:
            type: character
            size: 2
            default_value: AB
        - short:
            type: character
            default_value: Z
includes:
  - file: x
  - combine_options: 1
  - combine_options:
      source: 1
      destination:
        modify_fields: [1, { def: 1 }, { def: { type: integer, default_value: -1 } }]
        add_fields: [1, { add_field: 1 }, { add_field: {} }, { add_field: { extra: { type: integer, default_value: 99 } } }]
""");
        Assert.False(FieldDefaults.Check(defaults, catalog).Valid);
        _ = FieldCatalog.Parse("types:\n  - []\n  - name: 1\n  - integer:\n      min: 0\n      max: null\n");
        _ = FieldCatalog.Parse("nope: 1\n");

        var expanded = Specification.ExpandTypes(
        [
            new TypeModel { Name = "plain", Kind = "shaped", Tags = [], Fields = [] },
            new TypeModel
            {
                Name = "dict",
                Kind = "inherit",
                Inherits = "dictionary",
                Tags = [],
                Fields = [new TypeField { Name = "owner_id", Type = "integer", Kind = "scalar", Base = "integer", References = new[] { "plain.id" } }],
            },
            new TypeModel { Name = "holder", Kind = "inherit", Inherits = "dict", Tags = [], Fields = [] },
        ]);
        Assert.NotEmpty(expanded);
        Assert.Throws<InvalidOperationException>(() => Specification.ExpandTypes(
        [
            new TypeModel { Name = "a", Kind = "inherit", Inherits = "b", Tags = [], Fields = [] },
            new TypeModel { Name = "b", Kind = "inherit", Inherits = "a", Tags = [], Fields = [] },
        ]));

        var withIds = new TypeModel { Name = "user", Kind = "shaped", Tags = [], Ids = ["email"], Fields = [] };
        var withMark = new TypeModel
        {
            Name = "user",
            Kind = "shaped",
            Tags = [],
            Fields = [new TypeField { Name = "email", Type = "string", Kind = "scalar", Base = "string", IsId = true, HasSize = true, Size = 8 }],
        };
        Assert.Equal("email", Specification.PrimaryKeyColumn(null, withIds));
        Assert.Equal("id", Specification.PrimaryKeyColumn(null, null));
        Assert.NotEmpty(Specification.UniqueLookupFields(withMark, new DatasourceTable
        {
            Name = "user",
            Fields = [new DatasourceFieldOverlay { Name = "email", IsUnique = true }, new DatasourceFieldOverlay { Name = "code", IsUnique = false }],
            UniqueIndexFields = ["code", "email"],
        }));
        Assert.NotEmpty(Specification.UniqueLookupFields(withIds, null));
        Assert.True(Specification.HasAuthoredIdentity(withIds));
        Assert.False(Specification.HasAuthoredIdentity(new TypeModel { Name = "x", Kind = "shaped", Tags = [], Fields = [] }));
    }

    [Fact]
    public async Task Parser_optional_documents()
    {
        var servicesOnly = new MemoryReader(new Dictionary<string, string>
        {
            [SpecFiles.TypesYaml] = """
types:
  - user:
      fields:
        - name
        - email:
            type: string
""",
            [SpecFiles.ServicesYaml] = """
services:
  - name: Users
    module: ./custom/users
""",
        });
        var parsed = await new DeterministicParser(servicesOnly).Parse(new Dictionary<string, string>(), new ParseOptions
        {
            ServiceClassName = name => name + "Service",
        });
        Assert.NotEmpty(parsed.Types);

        var routes = new MemoryReader(new Dictionary<string, string>
        {
            [SpecFiles.TypesYaml] = """
types:
  - user:
      fields:
        - email:
            type: string
  - tag:
      fields:
        - user_id:
            references: user.id
        - tag_id:
            references: tag.id
""",
            [SpecFiles.RoutesYaml] = """
routes:
  - home:
      path: /home
      method: GET
      module: ./routes/home
  - users_by_email
combined_routes:
  - user:
      combines:
        - tag:
            via: tag
            target: user
""",
        });
        var routed = await new DeterministicParser(routes).Parse(new Dictionary<string, string>());
        Assert.NotNull(routed);
    }

    [Fact]
    public void Type_model_documents()
    {
        var result = TypeModelSemantics.Check(Doc("""
types:
  - base:
      ids: [id]
      fields:
        - id:
            type: integer
            is_id: true
  - child:
      inherits: base
      remove_fields: [base.id, local]
      extract: [base.id]
      mapping:
        id: child_id
      fields:
        - parent_id:
            references: [base.id]
        - amount:
            type: decimal
            size: [4, 2]
        - list:
            type: string[]
        - bag:
            type: string{}
  - dict:
      inherits: dictionary
      fields:
        - key:
            type: string
        - value:
            type: string
        - owner_id:
            references: child.id
  - unioned:
      union: [child, missing, string]
  - loop:
      inherits: loop
"""));
        Assert.NotNull(result);
    }
}
