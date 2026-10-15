using System.Text.Json.Nodes;
using Json.Schema;
using Xunit;

namespace Deterministic.Generators.Common.Tests;

public class LastBranchTests
{
    sealed class Blank
    {
        public override string? ToString() => null;
    }

    static ParsedYaml Doc(string yaml)
    {
        var parsed = YamlDocuments.Parse(yaml);
        return new ParsedYaml { Root = parsed.Root, Data = YamlData.Plain(parsed.Root) };
    }

    static ParsedYaml Of(object? data) => new() { Root = null, Data = data };

    [Fact]
    public void Remaining_scalars_and_schema()
    {
        Assert.Equal(-16L, YamlDocuments.ResolvePlain("-0x10"));
        Assert.Equal(long.MinValue, YamlDocuments.ResolvePlain("-0x8000000000000000"));
        Assert.Equal("", AjvErrors.ErrorFromUnknown((object?)new Blank()));
        Assert.Equal("ok", AjvErrors.ErrorFromUnknown((object?)"ok"));
        _ = YamlData.PositionFor(YamlDocuments.Parse("a: 1\n").Root, "/missing");
        _ = YamlData.PositionFor(YamlDocuments.Parse("a: 1\n").Root, "/a");

        var denied = JsonSchema.FromText("false");
        _ = SchemaEngine.Evaluate(denied, JsonNode.Parse("1"));
        var inner = JsonSchema.FromText("""{"not":{"type":"number","minimum":1}}""");
        _ = SchemaEngine.Evaluate(inner, JsonNode.Parse("\"x\""));
        _ = SchemaEngine.Evaluate(inner, JsonNode.Parse("0"));
        _ = SchemaEngine.Evaluate(JsonSchema.FromText("""{"not":{"type":"string"}}"""), JsonNode.Parse("\"hello\""));
        _ = AjvErrors.ErrorFromUnknown((object)new InvalidOperationException("boom"));
    }

    [Fact]
    public async Task Paths_filters_and_catalog()
    {
        var dir = Path.Combine(Path.GetTempPath(), "dgc-last-" + Guid.NewGuid().ToString("n"));
        Directory.CreateDirectory(dir);
        var file = Path.Combine(dir, "plain.yaml");
        await File.WriteAllTextAsync(file, "a: 1\n");
        var link = Path.Combine(dir, "link.yaml");
        File.CreateSymbolicLink(link, file);
        var sub = Path.Combine(dir, "sub");
        Directory.CreateDirectory(sub);
        var linkDir = Path.Combine(dir, "linkdir");
        Directory.CreateSymbolicLink(linkDir, sub);
        Assert.Contains("plain.yaml", IncludeCycles.ResolvedId(file));
        Assert.Contains("plain.yaml", IncludeCycles.ResolvedId(link));
        Assert.Contains("sub", IncludeCycles.ResolvedId(sub));
        Assert.Contains("sub", IncludeCycles.ResolvedId(linkDir));
        Assert.Contains("missing.yaml", IncludeCycles.ResolvedId(Path.Combine(dir, "missing.yaml")));
        Assert.Contains("child.yaml", IncludeCycles.ResolvedId("/no/such/include-root/child.yaml"));
        Assert.Contains("missing.yaml", IncludeCycles.ResolvedId(Path.Combine(linkDir, "missing.yaml")));
        _ = IncludeCycles.ResolvedId("/");
        var opt = new ValidateOptions { IncludeFilePath = file };
        _ = await IncludeCycles.Check(Of("nope"), opt);
        _ = await IncludeCycles.Check(Of(new Dictionary<string, object?>
        {
            ["includes"] = new List<object?>
            {
                1,
                new Dictionary<string, object?>(),
                new Dictionary<string, object?> { ["file"] = "" },
                new Dictionary<string, object?> { ["file"] = 1 },
                new Dictionary<string, object?> { ["file"] = "plain.yaml" },
            },
        }), opt);
        Directory.Delete(dir, true);

        foreach (var expr in new[] { "type_1 == \"a\"", "tag == \"a\" && inherits == \"b\"", "type == \"a\" && )", "type == \"a\" || )" })
            _ = IncludeFilters.Parse(expr);
        _ = IncludeFilters.Check(Of(new Dictionary<string, object?>
        {
            ["includes"] = new List<object?> { 1, new Dictionary<string, object?> { ["types"] = new Dictionary<string, object?> { ["filter"] = "type == \"a\"" } }, new Dictionary<string, object?> { ["file"] = "" }, new Dictionary<string, object?> { ["file"] = 1 }, new Dictionary<string, object?> { ["file"] = "a.yaml" } },
        }));
        _ = IncludeFilters.Check(Of(null));

        var onlyMax = new FieldCatalog.FieldType { Name = "integer", MaxValue = "5" };
        var onlyMin = new FieldCatalog.FieldType { Name = "integer", MinValue = "1" };
        var both = new FieldCatalog.FieldType { Name = "integer", MinValue = "1", MaxValue = "5" };
        foreach (var field in new[] { onlyMax, onlyMin, both })
        {
            _ = FieldDefaults.Check(Doc("""
types:
  - user:
      fields:
        - n:
            type: integer
            default_value: 0
        - m:
            type: integer
            default_value: 9
        - k:
            type: integer
            default_value: 3
"""), new Dictionary<string, FieldCatalog.FieldType> { ["integer"] = field });
        }
        _ = FieldCatalog.Parse("1");
        _ = FieldCatalog.Parse("");
        _ = FieldCatalog.Parse("""
types:
  - integer: 1
  - name:
      min: 0
      defaults:
        - now: 1
        - token:
            regex: "^now$"
""");
        _ = FieldDefaults.Check(Doc("includes:\n  - 1\n  - combine_options: 1\n"), new Dictionary<string, FieldCatalog.FieldType>());
    }

    [Fact]
    public void Models_and_seeds()
    {
        var companion = Doc("""
types:
  - parent:
      inherits: 1
      fields:
        - version:
            type: integer
  - child:
      inherits: parent
      fields:
        - version: {}
        - bare: {}
""").Data;
        _ = DatasourceModel.CheckModel(Doc("""
types:
  - child:
      fields:
        - version:
            is_optimistic_concurrency: true
        - bare:
            is_optimistic_concurrency: true
"""), companion, true);
        _ = DatasourceModel.CheckModel(Doc("""
types:
  - other:
      fields:
        - version:
            is_optimistic_concurrency: true
  - nope: 1
"""), Doc("""
types:
  - nope: 1
  - parent:
      inherits: 1
  - child:
      inherits: parent
""").Data, true);
        _ = DatasourceModel.CheckModel(Doc("types: []"), "nope", true);

        var types = Doc("""
types:
  - person:
      fields:
        - email:
            type: string
  - user:
      fields:
        - named:
            references: person.email
        - ident:
            references: person.id
        - short:
            references: person
        - head:
            references: ".email"
        - tail:
            references: "person."
        - many:
            references: [person.email]
        - email:
            type: string
        - many:
            references: [person.email]
        - short:
            references: person
        - head:
            references: ".email"
        - tail:
            references: "person."
        - loose:
            type: map
        - empty: {}
""").Data;
        _ = SeedSemantics.Check(Doc("""
seeds:
  - []
  - {}
  - user:
      - row: 1
      - row:
          named: 1
          ident: 1
          loose: 1
          empty: 1
          email: a
          many: 1
          short: 1
          head: 1
          tail: 1
          created: 1
"""), types, Doc("""
types:
  - []
  - {}
  - user: 1
includes:
  - 1
  - types: []
  - types:
      filter: 1
  - types:
      filter: type == "user"
""").Data, true);
        _ = SeedSemantics.Check(Doc("""
seeds:
  - user:
      - row:
          email: a
          many: 1
          short: 1
          head: 1
          tail: 1
"""), null, Doc("""
includes:
  - types:
      filter: type == "user"
types:
  - []
  - {}
  - user: 1
  - person:
      inherits: base
""").Data, true);

        var handTypes = new Dictionary<string, object?>
        {
            ["types"] = new List<object?>
            {
                null,
                new Dictionary<string, object?>(),
                new Dictionary<string, object?> { ["user"] = 1 },
                new Dictionary<string, object?>
                {
                    ["person"] = new Dictionary<string, object?>
                    {
                        ["fields"] = new List<object?>
                        {
                            new Dictionary<string, object?> { ["email"] = new Dictionary<string, object?> { ["type"] = "string" } },
                        },
                    },
                },
                new Dictionary<string, object?>
                {
                    ["user"] = new Dictionary<string, object?>
                    {
                        ["fields"] = new List<object?>
                        {
                            new Dictionary<string, object?> { ["many"] = new Dictionary<string, object?> { ["references"] = new List<object?> { "person.email" } } },
                            new Dictionary<string, object?> { ["named"] = new Dictionary<string, object?> { ["references"] = "person.email" } },
                            new Dictionary<string, object?> { ["short"] = new Dictionary<string, object?> { ["references"] = "person" } },
                            new Dictionary<string, object?> { ["head"] = new Dictionary<string, object?> { ["references"] = ".email" } },
                            new Dictionary<string, object?> { ["tail"] = new Dictionary<string, object?> { ["references"] = "person." } },
                            new Dictionary<string, object?> { ["email"] = new Dictionary<string, object?> { ["type"] = "string" } },
                            new Dictionary<string, object?> { ["empty"] = new Dictionary<string, object?>() },
                        },
                    },
                },
            },
        };
        _ = SeedSemantics.Check(Doc("""
seeds:
  - user:
      - row:
          many: 1
          named: hi
          short: 1
          head: 1
          tail: 1
          email: a
          empty: 1
"""), handTypes, Doc("""
includes:
  - types:
      filter: type == "user"
""").Data, true);

        _ = ServiceModel.Check(Doc("""
services:
  - Users
  - name: ""
  - name: Users
  - {}
"""));
    }

    [Fact]
    public async Task Parser_shapes()
    {
        _ = DeterministicParser.InheritsChain("missing", new Dictionary<string, TypeModel>());
        var types = new Dictionary<string, TypeModel>
        {
            ["note"] = new() { Name = "note", Kind = "inherit", Inherits = "ghost", Tags = [], Fields = [] },
            ["user"] = new() { Name = "user", Kind = "inherit", Inherits = "base", Tags = [], Fields = [] },
            ["base"] = new() { Name = "base", Kind = "shaped", Inherits = null, Tags = [], Fields = [] },
        };
        Assert.Contains("ghost", DeterministicParser.InheritsChain("note", types));
        Assert.Contains("base", DeterministicParser.InheritsChain("user", types));

        var reader = new MemoryReader(new Dictionary<string, string>
        {
            [SpecFiles.TypesYaml] = """
types:
  - user:
      tags: [datasource_type]
      mapping:
        a: 1
      fields:
        - email:
            type: string
  - renamed:
      mapping:
        email: mail
      fields:
        - id:
            type: integer
  - note:
      fields:
        - user_id:
            references: user.id
  - tag:
      tags: [datasource_type]
      fields:
        - name:
            type: string
  - label:
      fields:
        - name:
            type: string
  - membership:
      tags: [many_to_many]
      fields:
        - user_id:
            references: user.id
        - label_id:
            references: label.id
        - tag_id:
            references: tag.id
  - half:
      tags: [many_to_many]
      fields:
        - user_id:
            references: user.id
  - onlytag:
      tags: [many_to_many]
      fields:
        - tag_id:
            references: tag.id
""",
            [SpecFiles.DatasourceYaml] = """
types:
  - user:
      fields:
        - email:
            is_unique: true
""",
            [SpecFiles.RoutesYaml] = """
routes:
  - null
  - {}
  - home: 1
  - user:
      eager_update_path: [email]
  - profile:
      eager_read_path: [email]
      eager_update_path: [email]
      eager_read_member_only: [email]
  - users_by_id
  - get_users_by_email
  - get_users_by_email
  - put_users_by_email
  - custom:
      path: /custom
      method: GET
combined_routes:
  - tag:
      combines: 1
  - label:
  - user:
      combines:
        - note: 1
        - label
        - tag:
            via: membership
            target: tag
        - note:
            via: 1
            target: user
        - tag:
            via: half
            target: tag
        - tag:
            via: onlytag
            target: tag
""",
        });
        try
        {
            await new DeterministicParser(reader).Parse(new Dictionary<string, string>());
        }
        catch (InvalidOperationException)
        {
        }

        var parentMissing = new MemoryReader(new Dictionary<string, string>
        {
            [SpecFiles.TypesYaml] = """
types:
  - user:
      fields:
        - email:
            type: string
  - tag:
      fields:
        - name:
            type: string
  - onlytag:
      tags: [many_to_many]
      fields:
        - tag_id:
            references: tag.id
""",
            [SpecFiles.RoutesYaml] = """
combined_routes:
  - user:
      combines:
        - tag:
            via: onlytag
            target: tag
""",
        });
        await Assert.ThrowsAnyAsync<InvalidOperationException>(() =>
            new DeterministicParser(parentMissing).Parse(new Dictionary<string, string>()));

        var childMissing = new MemoryReader(new Dictionary<string, string>
        {
            [SpecFiles.TypesYaml] = """
types:
  - user:
      fields:
        - email:
            type: string
  - tag:
      fields:
        - name:
            type: string
  - half:
      tags: [many_to_many]
      fields:
        - user_id:
            references: user.id
""",
            [SpecFiles.RoutesYaml] = """
combined_routes:
  - user:
      combines:
        - tag:
            via: half
            target: tag
""",
        });
        await Assert.ThrowsAnyAsync<InvalidOperationException>(() =>
            new DeterministicParser(childMissing).Parse(new Dictionary<string, string>()));

        var seeds = new MemoryReader(new Dictionary<string, string>
        {
            [SpecFiles.DatasourceSeedsYaml] = """
seeds:
  - user:
      - id1: 1
      - id2:
          email: a
""",
        });
        try
        {
            await new DeterministicParser(seeds).Parse(new Dictionary<string, string>());
        }
        catch (InvalidOperationException)
        {
        }
    }

    [Fact]
    public void Type_semantics_edges()
    {
        _ = TypeModelSemantics.Check(Doc("""
types:
  - row:
      inherits: set
      ids: [id]
      fields:
        - id:
            type: integer
  - item:
      inherits: set
      ids: []
      fields:
        - id:
            type: integer
            is_id: true
  - bare:
      inherits: set
      fields:
        - ref:
            references: set.id
  - loop:
      inherits: loop
  - prefs:
      inherits: dictionary
      fields:
        - key:
            type: string
        - value:
            type: string
        - owner_id:
            references: loop.id
        - self_id:
            references: prefs.id
        - bare_id:
            references: id
        - pair_id:
            references: [loop.id, loop.name]
        - ghost_id:
            references: ghost.id
        - child_id:
            references: child.id
  - child:
      inherits: ghost
  - holder:
      inherits: prefs
      fields:
        - owner_id:
            references: child.id
  - unioned:
      union: [loop, set]
"""));
        _ = TypeModelSemantics.IndexTypeFields(Doc("""
types:
  - set:
      fields: []
  - user:
      fields:
        - email:
            type: string
  - loop:
      inherits: loop
  - unioned:
      union: [loop]
""").Data);
        var result = TypeModelSemantics.Check(Doc("""
types:
  - base:
      ids: []
      fields:
        - id:
            type: integer
            is_id: true
  - named:
      ids: [id]
      fields:
        - id:
            type: integer
  - plain:
      fields:
        - id:
            type: integer
  - child:
      inherits: base
      mapping:
        id: 1
      fields:
        - owner_id:
            references: [base.id, base.name]
  - dict:
      inherits: dictionary
      tags: [datasource_type]
      fields:
        - key:
            type: string
        - value:
            type: string[]
        - owner_id:
            references: missing.id
  - dict2:
      inherits: dictionary
      tags: [view_type]
      fields:
        - key:
            type: string
        - value:
            type: bag{}
        - owner_id:
            references: dict.key
  - bag:
      inherits: dictionary
      tags: [datasource_type]
      fields:
        - key:
            type: string
        - value:
            type: string
  - holder:
      fields:
        - prefs:
            type: dict{}
            references: dict.key
        - other:
            type: missing{}
  - loop:
      inherits: loop
      fields:
        - id:
            references: loop.id
  - unioned:
      union: [set, child, missing, loop]
"""));
        Assert.NotNull(result);
        Assert.Throws<InvalidOperationException>(() => Specification.ExpandTypes(
        [
            new TypeModel { Name = "holder", Kind = "inherit", Inherits = "dict", Tags = [], Fields = [] },
            new TypeModel
            {
                Name = "dict",
                Kind = "inherit",
                Inherits = "dictionary",
                Tags = [],
                Fields =
                [
                    new TypeField { Name = "owner_id", Type = "integer", Kind = "scalar", Base = "integer", References = "a.id" },
                    new TypeField { Name = "missing_id", Type = "integer", Kind = "scalar", Base = "integer", References = "missing.id" },
                ],
            },
            new TypeModel { Name = "a", Kind = "inherit", Inherits = "b", Tags = [], Fields = [] },
            new TypeModel { Name = "b", Kind = "inherit", Inherits = "a", Tags = [], Fields = [] },
        ]));
    }
}
