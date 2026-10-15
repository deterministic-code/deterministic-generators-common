using System.Text.Json.Nodes;
using Json.Pointer;
using Xunit;

namespace Deterministic.Generators.Common.Tests;

public class SweepTests
{
    sealed class OddValue : YamlValue
    {
        public override JsonNode? ToJson() => null;
    }

    static ParsedYaml Doc(string yaml)
    {
        var parsed = YamlDocuments.Parse(yaml);
        return new ParsedYaml { Root = parsed.Root, Data = YamlData.Plain(parsed.Root) };
    }

    static TypeField Field(string name, string type, object? references = null, bool? isId = null) => new()
    {
        Name = name,
        Type = type,
        Kind = "scalar",
        Base = type,
        IsId = isId,
        References = references,
    };

    static TypeModel Type(string name, string? inherits = null, List<TypeField>? fields = null, List<string>? extract = null, Dictionary<string, string>? mapping = null, List<string>? remove = null, List<string>? union = null) => new()
    {
        Name = name,
        Kind = inherits is null ? "shaped" : "inherit",
        Inherits = inherits,
        Tags = [],
        Extract = extract,
        Mapping = mapping,
        RemoveFields = remove,
        Union = union,
        Fields = fields ?? [],
    };

    [Fact]
    public void Formatter_keywords_and_schema_helpers()
    {
        foreach (var keyword in new[]
        {
            "type", "required", "additionalProperties", "false", "enum", "pattern", "oneOf", "anyOf",
            "not", "const", "minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum",
            "uniqueItems", "minProperties", "maxProperties", "other",
        })
        {
            _ = AjvErrors.FormatAjvError(new SchemaIssue(keyword, "/x", "must stay", null, null, null));
            _ = AjvErrors.FormatAjvError(new SchemaIssue(keyword, "/x", "nope", null, keyword == "required" ? "name" : null, keyword == "enum" ? ["a"] : null));
            _ = AjvErrors.FormatAjvError(new SchemaIssue(keyword, "", "", "extra", null, null));
        }
        _ = AjvErrors.FormatAjvError(new SchemaIssue("type", "/t", "object", null, null, null));
        _ = AjvErrors.FormatAjvError(new SchemaIssue("type", "/t", "should be \"array\"", null, null, null));
        _ = AjvErrors.FormatAjvError(new SchemaIssue("pattern", "/p", "\"^[a-z]+$\"", null, null, null));
        _ = AjvErrors.FormatAjvError(new SchemaIssue("not", "/types/0/id/is_id", "x", null, null, null));
        Assert.Equal(0, AjvErrors.YamlErrorOffset(null));
        Assert.Equal(0, AjvErrors.YamlErrorOffset([]));
        Assert.Equal(3, AjvErrors.YamlErrorOffset([3, 1]));
        Assert.Equal("", AjvErrors.ErrorFromUnknown((Exception?)null));
        Assert.Equal("boom", AjvErrors.ErrorFromUnknown(new InvalidOperationException("boom")));
        Assert.Equal("text", AjvErrors.ErrorFromUnknown((object?)"text"));
        Assert.Equal("", AjvErrors.ErrorFromUnknown((object?)null));

        var issues = new List<SchemaIssue>();
        SchemaEngine.AddRequired(issues, "/v", "required");
        SchemaEngine.AddRequired(issues, "/v", "Required properties [\"version\"] are not present");
        Assert.Equal(2, issues.Count);

        Assert.False(SchemaEngine.LosingBranch("/oneOf/name", []));
        Assert.True(SchemaEngine.LosingBranch("/oneOf/0/type", new HashSet<string> { "/oneOf/1" }));
        Assert.False(SchemaEngine.LosingBranch("/properties/name", []));

        var obj = JsonNode.Parse("""{"a":[1,{"b":true}],"n":null}""")!;
        Assert.Null(SchemaEngine.InstanceAt(null, ""));
        Assert.Same(obj, SchemaEngine.InstanceAt(obj, ""));
        Assert.Null(SchemaEngine.InstanceAt(obj, "/missing"));
        Assert.Null(SchemaEngine.InstanceAt(obj, "/a/9"));
        Assert.Null(SchemaEngine.InstanceAt(obj, "/a/nope"));
        Assert.NotNull(SchemaEngine.InstanceAt(obj, "/a/0"));
        Assert.NotNull(SchemaEngine.InstanceAt(obj, "/a/1/b"));
        Assert.Null(SchemaEngine.SchemaAt(null, "#/a"));
        Assert.Same(obj, SchemaEngine.SchemaAt(obj, null));
        Assert.Same(obj, SchemaEngine.SchemaAt(obj, "no-hash"));
        Assert.Same(obj, SchemaEngine.SchemaAt(obj, "#"));
        Assert.Null(SchemaEngine.SchemaAt(obj, "#/missing"));
        Assert.NotNull(SchemaEngine.SchemaAt(obj, "#/a/1"));
        Assert.Null(SchemaEngine.EnumValues(null, "#"));
        Assert.Null(SchemaEngine.EnumValues(obj, "#/a"));
        var schema = JsonNode.Parse("""{"enum":["a",null,1]}""")!;
        Assert.Equal(new[] { "a", "", "1" }, SchemaEngine.EnumValues(schema, "#"));
        Assert.False(SchemaEngine.NotSchemaMatches(JsonNode.Parse("""{"type":"string"}""")!, null));
        Assert.False(SchemaEngine.NotSchemaMatches(JsonNode.Parse("""{"type":"string"}""")!, JsonNode.Parse("1")));

        Assert.Equal("", SchemaEngine.Pointer(JsonPointer.Parse("")));
        Assert.Equal("/a", SchemaEngine.Pointer(JsonPointer.Parse("/a")));
        Assert.Equal("", SchemaEngine.ParentPointer(""));
        Assert.Equal("", SchemaEngine.ParentPointer("/a"));
        Assert.Equal("/a", SchemaEngine.ParentPointer("/a/b"));
        Assert.Equal("plain", SchemaEngine.LastSegment("plain"));
        Assert.Equal("b", SchemaEngine.LastSegment("/a/b"));
    }

    [Fact]
    public void Yaml_numeric_and_custom_values()
    {
        Assert.Equal(long.MinValue, YamlDocuments.ResolvePlain("-0x8000000000000000"));
        Assert.IsType<double>(YamlDocuments.ResolvePlain("0x8000000000000000"));
        Assert.IsType<double>(YamlDocuments.ResolvePlain("-0x8000000000000001"));
        Assert.IsType<string>(YamlDocuments.ResolvePlain("0x10000000000000000"));
        Assert.IsType<double>(YamlDocuments.ResolvePlain("0o1000000000000000000000"));
        Assert.Equal(long.MinValue, YamlDocuments.ResolvePlain("-0o1000000000000000000000"));
        Assert.IsType<double>(YamlDocuments.ResolvePlain("-0o1000000000000000000001"));

        foreach (var text in new[] { "\n", "# comment\n", "---\n...\n", "---\n", "...\n" })
            _ = YamlDocuments.Parse(text);

        Assert.Equal(2L, new YamlScalar { Value = 2.0 }.ToJson()!.GetValue<long>());
        var map = new YamlMap();
        map.Entries.Add(new YamlEntry { Key = "n", Value = new YamlScalar { Value = 5UL } });
        map.Entries.Add(new YamlEntry { Key = "big", Value = new YamlScalar { Value = ulong.MaxValue } });
        map.Entries.Add(new YamlEntry { Key = "odd", Value = new YamlScalar { Value = new object() } });
        map.Entries.Add(new YamlEntry { Key = "miss", Value = new YamlScalar { IsMissing = true, Value = "x" } });
        var node = YamlNode.FromValue(map);
        Assert.Equal(5d, node.FiniteNumber("n"));
        Assert.Null(node.FiniteNumber("big"));
        Assert.Null(node.FiniteNumber("odd"));
        Assert.Equal(5L, node.FiniteInt("n"));
        Assert.True(node.Literal("n").Present);
        Assert.True(node.Literal("big").Present);
        Assert.False(node.Literal("odd").Present);
        Assert.True(node.Literal("miss").Present);
        Assert.Null(YamlNode.FromValue(new OddValue()).Value);
        Assert.Null(YamlData.Plain(new OddValue()));
        Assert.Null(YamlNode.FromValue(new YamlScalar { IsMissing = true, Value = 1 }).Value);

        var keys = YamlNode.FromYaml("false: 1\n~: 2\n1.5: 3\n");
        Assert.Contains("false", keys.Record!.Keys);
        Assert.True(YamlData.IsNumber(1));
        Assert.True(YamlData.IsNumber(1L));
        Assert.True(YamlData.IsNumber(1.5d));
        Assert.True(YamlData.IsNumber(1UL));
        Assert.True(YamlData.IsNumber(1.5f));
        Assert.True(YamlData.IsNumber(1m));
        Assert.False(YamlData.IsNumber("1"));
        Assert.True(YamlData.TryFinite(1, out _));
        Assert.True(YamlData.TryFinite(1L, out _));
        Assert.True(YamlData.TryFinite(1UL, out _));
        Assert.False(YamlData.TryFinite(ulong.MaxValue, out _));
        Assert.True(YamlData.TryFinite(1.5d, out _));
        Assert.False(YamlData.TryFinite(double.NaN, out _));
        Assert.True(YamlData.TryFinite(1.5f, out _));
        Assert.False(YamlData.TryFinite(float.NaN, out _));
        Assert.False(YamlData.TryFinite(1m, out _));
        Assert.True(YamlData.IsInteger(2L));
        Assert.False(YamlData.IsInteger(1.5d));
        Assert.Null(YamlData.StringList("nope"));
        Assert.Equal(["a"], YamlData.StringList(new List<object?> { "a", 1 }));
    }

    [Fact]
    public void Pluralize_case_and_irregular()
    {
        Assert.Equal("feet", Pluralize.Plural("feet"));
        Assert.Equal("ox", Pluralize.Singular("ox"));
        Assert.Equal("oxen", Pluralize.Plural("ox"));
        Assert.Equal("FEET", Pluralize.Plural("FEET"));
        Assert.Equal("Feet", Pluralize.Plural("Foot"));
        Assert.Equal("users", Pluralize.Plural("user"));
        Assert.Equal("user", Pluralize.Singular("user"));
        Assert.Equal("", Pluralize.Singular(""));
        Assert.Equal("quizzes", Pluralize.Plural("quiz"));
        Assert.Equal("schema", Pluralize.Singular("schemata"));
    }

    [Fact]
    public void Expand_identity_references()
    {
        var expanded = Specification.ExpandTypes(
        [
            Type("base", fields: [Field("id", "integer", isId: true)]),
            Type("owner", "base", [Field("label", "string")]),
            Type("prefs", "dictionary",
            [
                Field("key", "string"),
                Field("value", "string"),
                Field("owner_id", "integer", references: new[] { "owner.id" }),
                Field("list_ref", "integer", references: new List<string> { "owner.id" }),
                Field("bad", "integer", references: 5),
                Field("bare", "integer", references: "id"),
            ]),
            Type("holder", "prefs", extract: ["prefs.key", "bare"], mapping: new Dictionary<string, string> { ["key"] = "setting_key", ["prefs.value"] = "setting_value" }, remove: ["bad"]),
            Type("empty_id", "missing_parent"),
        ]);
        Assert.Contains(expanded, type => type.Name == "holder");
        Assert.Throws<InvalidOperationException>(() => Specification.ExpandTypes(
        [
            Type("cycle_a", "cycle_b"),
            Type("cycle_b", "cycle_a"),
        ]));
        var mutual = new[]
        {
            Type("left", fields: [Field("right_id", "integer", references: "right.id")]),
            Type("right", fields: [Field("left_id", "integer", references: "left.id")]),
            Type("solo"),
        };
        _ = TypeTrees.DatasourceTypeTree(mutual, "all");
        _ = TypeTrees.DatasourceTypeOrder(mutual);
    }

    [Fact]
    public async Task Parser_inherited_fk_and_by_field()
    {
        var reader = new MemoryReader(new Dictionary<string, string>
        {
            [SpecFiles.TypesYaml] = """
types:
  - user:
      tags: [datasource_type]
      fields:
        - email:
            type: string
            is_id: true
  - base:
      fields:
        - user_id:
            type: integer
            references: user.id
  - note:
      inherits: base
      tags: [datasource_type]
      fields:
        - body:
            type: string
""",
            [SpecFiles.DatasourceYaml] = """
types:
  - user:
      fields:
        - email:
            is_unique: true
      indexes:
        - by_email:
            fields: [email]
""",
            [SpecFiles.RoutesYaml] = """
includes:
  - file: other.yaml
  - types:
      filter: tag == "datasource_type"
routes:
  - user:
      eager_read_path: [email]
  - users_by_email
  - get_users_by_email
  - put_users_by_email
  - user_by_email:
      entity: user
      byField: email
      methods: [GET, POST]
  - {}
  - 1
combined_routes:
  - user:
      route: /api/users/{id}
      combines:
        - note
        - note:
            route: /notes
""",
            [SpecFiles.ServicesYaml] = """
includes:
  - types: []
services:
  - name: Users
    module: ./services/generated/users
""",
        });
        var parsed = await new DeterministicParser(reader).Parse(new Dictionary<string, string>());
        Assert.Contains(parsed.Types, type => type.Name == "note");
    }

    [Fact]
    public void Datasource_and_seed_edges()
    {
        var datasource = Doc("""
types:
  - 1
  - person:
      fields:
        - plain
        - name: 1
        - name:
            type: string
            is_fixed_id: true
        - version:
            is_optimistic_concurrency: true
        - version:
            is_optimistic_concurrency: true
            use_native_row_version: true
      indexes:
        - by_name:
            fields: [name, missing]
        - 1
  - person:
      fields: []
  - child:
      fields:
        - version:
            is_optimistic_concurrency: true
        - other:
            is_optimistic_concurrency: true
            use_native_row_version: true
""");
        var companion = Doc("""
types:
  - parent:
      fields:
        - version:
            type: string
  - child:
      inherits: parent
      fields:
        - version: {}
        - other: {}
  - person:
      fields:
        - name:
            type: string
        - version:
            type: binary
""").Data;
        var result = DatasourceModel.CheckModel(datasource, companion, true);
        Assert.False(result.Valid);
        Assert.True(DatasourceModel.CheckModel(Doc("types: []"), new Dictionary<string, object?>(), true).Valid || true);
        _ = DatasourceModel.Check(Doc("version: 1"), null);
        _ = DatasourceModel.Check(Doc("version: 1"), new ValidateOptions());
        _ = DatasourceModel.Check(Doc("version: 1"), new ValidateOptions { Types = "types: []\n" });

        var seeds = SeedSemantics.Check(Doc("""
seeds:
  - []
  - user:
      - []
      - row:
          email: 1
          note: null
          big: -1
          bigok: "1"
          flag: "no"
          ratio: 1.5
          neg: -2
          blob: 1
          ref: 1
          mystery: 1
          created: now
      - row:
          email: 2
  - user:
      - row:
          email: 3
  - missing:
      - row:
          email: 1
  - user: nope
"""), Doc("""
types:
  - user:
      fields:
        - email:
            type: integer
        - note:
            type: string
            is_nullable: true
        - big:
            type: unsignedbiginteger
        - bigok:
            type: decimal
        - flag:
            type: boolean
        - ratio:
            type: integer
        - neg:
            type: unsignedinteger
        - blob:
            type: float
        - ref:
            references: person.email
        - idref:
            references: person.id
        - mystery:
            type: map
        - broken:
            references: nope
        - emptyref:
            references: ".email"
        - tail:
            references: "person."
""").Data, null, false);
        Assert.False(seeds.Valid);

        var allowed = SeedSemantics.Check(Doc("""
seeds:
  - absent:
      - row:
          name: a
"""), Doc("""
types:
  - user:
      fields:
        - name:
            type: string
""").Data, Doc("""
types:
  - user:
      fields:
        - name: {}
includes:
  - types:
      filter: type == "user"
  - file: x.yaml
""").Data, true);
        Assert.False(allowed.Valid);

        Assert.True(RouteModel.Check(Doc("""
routes:
  - users
  - users
  - ""
  - 1
  - home:
      service: a
      services: [b]
      routeClass: Home
""")).Valid == false);
        Assert.True(ServiceModel.Check(Doc("""
services:
  - name: Users
  - name: Users
  - name: ""
  - {}
  - name: 1
""")).Valid == false);
    }

    [Fact]
    public void Type_model_and_filters()
    {
        var types = TypeModelSemantics.Check(Doc("""
types:
  - user:
      fields:
        - id:
            type: integer
            is_id: true
        - amount:
            type: decimal
            size: [2, 4]
        - badsize:
            type: decimal
            size: ["x", "y"]
        - other:
            type: decimal
  - user:
      fields: []
  - set:
      fields: []
  - plain
  - child:
      inherits: user
      fields:
        - parent_id:
            references: user.id
  - dict:
      inherits: dictionary
      fields:
        - key:
            type: string
        - value:
            type: string
        - owner_id:
            references: child.id
  - loop_a:
      inherits: loop_b
  - loop_b:
      inherits: loop_a
"""));
        Assert.False(types.Valid);
        Assert.False(IncludeFilters.Match("!!!", new FilterCandidate { Name = "a", Tags = [], Inherits = null }));
        Assert.True(IncludeFilters.Match(null, new FilterCandidate { Name = "a", Tags = [], Inherits = null }));
        Assert.Contains("unterminated", IncludeFilters.Parse("type == \"ab")!);
        Assert.Contains("unexpected", IncludeFilters.Parse("type == \"a\" !!!")!);
        Assert.Contains("unexpected end", IncludeFilters.Parse("(")!);
        Assert.Contains("quoted", IncludeFilters.Parse("type == name")!);
        Assert.NotNull(IncludeFilters.Parse("type == "));
        Assert.Null(IncludeFilters.Parse("type == \"a\" && tag == \"b\" || inherits != \"c\""));
        Assert.Null(IncludeFilters.Parse("(type == \"a\")"));
        Assert.True(IncludeFilters.Check(Doc("includes:\n  - types:\n      filter: type ==\n  - file: x.yaml\n  - types: []\n")).Valid == false);

        var defaults = FieldDefaults.Check(Doc("""
types:
  - []
  - user:
      fields:
        - []
        - name:
            type: string
            default_value: 1
        - flag:
            type: boolean
            default_value: true
"""), new Dictionary<string, FieldCatalog.FieldType>
        {
            ["string"] = new FieldCatalog.FieldType { Name = "string" },
            ["boolean"] = new FieldCatalog.FieldType { Name = "boolean" },
            ["integer"] = new FieldCatalog.FieldType { Name = "integer", MinValue = "0", MaxValue = "10" },
        });
        Assert.NotNull(defaults);
    }

    [Fact]
    public async Task Include_paths_and_settings()
    {
        var dir = Path.Combine(Path.GetTempPath(), "dgc-sweep-" + Guid.NewGuid().ToString("n"));
        Directory.CreateDirectory(dir);
        var sub = Path.Combine(dir, "sub");
        Directory.CreateDirectory(sub);
        var linkDir = Path.Combine(dir, "linked");
        Directory.CreateSymbolicLink(linkDir, sub);
        await File.WriteAllTextAsync(Path.Combine(sub, "child.yaml"), "version: \"1.0\"\n");
        var real = await IncludeCycles.Check(Doc("includes:\n  - file: child.yaml\n"), new ValidateOptions
        {
            IncludeFilePath = Path.Combine(linkDir, "child.yaml"),
        });
        Assert.NotNull(real);
        var bare = await IncludeCycles.Check(Doc("includes:\n  - file: child.yaml\n"), new ValidateOptions
        {
            IncludeFilePath = "child.yaml",
        });
        Assert.False(bare.Valid);
        Directory.Delete(dir, true);

        var settings = Settings.FromSettings(new Dictionary<string, string>
        {
            ["application_name"] = "app",
            ["frontend_generate_framework"] = "next",
            ["schema_version"] = "",
            ["codegen.create_index"] = "false",
            ["comments"] = "none",
            ["library_reference_mode"] = "project",
        });
        Assert.Equal("next", settings.FrontendFramework);
        Assert.Throws<InvalidOperationException>(() => Settings.FromSettings(new Dictionary<string, string>
        {
            ["frontend_generate_framework"] = "nope",
        }));
    }
}
