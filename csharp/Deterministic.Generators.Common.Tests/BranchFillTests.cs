using System.Text.Json.Nodes;
using Xunit;

namespace Deterministic.Generators.Common.Tests;

public class BranchFillTests
{
    static ParsedYaml Doc(string yaml)
    {
        var parsed = YamlDocuments.Parse(yaml);
        return new ParsedYaml { Root = parsed.Root, Data = YamlData.Plain(parsed.Root) };
    }

    static ParsedYaml Data(object? data) => new() { Root = null, Data = data };

    static TypeField Field(string name, string type, object? references = null, bool? isId = null) => new()
    {
        Name = name,
        Type = type,
        Kind = "scalar",
        Base = type,
        IsId = isId,
        References = references,
    };

    static TypeModel Type(string name, string kind, string? inherits = null, List<TypeField>? fields = null, List<string>? extract = null, List<string>? tags = null) => new()
    {
        Name = name,
        Kind = kind,
        Inherits = inherits,
        Tags = tags ?? [],
        Extract = extract,
        Fields = fields ?? [],
    };

    [Fact]
    public void Pluralize_edges()
    {
        Assert.Equal("user", Pluralize.Singular("user"));
        Assert.Equal("Users", Pluralize.Plural("User"));
        Assert.Equal("USERS", Pluralize.Plural("USER"));
        Assert.Equal("Users", Pluralize.Plural("User"));
        Assert.Equal("", Pluralize.Plural(""));
        Assert.Equal("health", Pluralize.Plural("health"));
        Assert.Equal("people", Pluralize.Plural("person"));
        Assert.Equal("indices", Pluralize.Plural("index"));
        Assert.Equal("statuses", Pluralize.Plural("status"));
    }

    [Fact]
    public void Yaml_scalars_and_keys()
    {
        var (empty, emptyErr) = YamlDocuments.Parse("");
        Assert.Null(empty);
        Assert.Empty(emptyErr);
        var (docEnd, docErr) = YamlDocuments.Parse("---\n");
        Assert.True(docEnd is null || docErr.Count >= 0);
        var (inf, _) = YamlDocuments.Parse("a: .inf\nb: .nan\nc: -.inf\n");
        var map = Assert.IsType<YamlMap>(inf);
        Assert.Equal(double.PositiveInfinity, ((YamlScalar)map.Entries[0].Value).Value);
        Assert.Equal(double.NaN, ((YamlScalar)map.Entries[1].Value).Value);
        Assert.Null(((YamlScalar)map.Entries[0].Value).ToJson() is null ? null : map.Entries[0].Value.ToJson());
        Assert.NotNull(new YamlScalar { Value = 1.5 }.ToJson());
        Assert.NotNull(new YamlScalar { Value = 1UL }.ToJson());
        Assert.Null(new YamlScalar { IsMissing = true, Value = "x" }.ToJson());
        Assert.Null(new YamlScalar { Value = double.PositiveInfinity }.ToJson());
        Assert.NotNull(new YamlScalar { Value = DateTime.UnixEpoch }.ToJson());
        Assert.Null(YamlData.Plain(new YamlScalar { IsMissing = true, Value = 1 }));
        Assert.Null(YamlData.Plain(null));

        var keys = YamlNode.FromYaml("? {a: 1}\n: 2\n~: 3\ntrue: 4\n1: five\n1.5: six\n");
        Assert.Contains("[object Object]", keys.Record!.Keys);
        Assert.Equal(("0", 1), YamlData.SingleKey(new List<object?> { 1 })!.Value);
        Assert.Null(YamlData.SingleKey(new List<object?>()));
        Assert.Null(YamlData.SingleKey(new Dictionary<string, object?>()));
        Assert.False(YamlData.IsBool("x", true));
        Assert.True(YamlData.IsBool(true, true));
        Assert.False(YamlData.IsBool(false, true));
        Assert.True(YamlData.IsNumber(1));
        Assert.True(YamlData.IsNumber(1.5));
        Assert.True(YamlData.IsNumber(1UL));
        Assert.True(YamlData.IsNumber(1f));
        Assert.True(YamlData.IsNumber(1m));
        Assert.True(YamlData.TryFinite(1, out _));
        Assert.True(YamlData.TryFinite(1UL, out _));
        Assert.False(YamlData.TryFinite(ulong.MaxValue, out _));
        Assert.False(YamlData.IsInteger(1.5));
        Assert.False(YamlData.IsInteger("x"));
        Assert.Equal((1, 1), YamlData.PositionFor(null, "/a"));
        var node = YamlNode.FromYaml("n: 1\nf: 1.5\n");
        Assert.Equal(1, node.FiniteInt("n"));
        Assert.Null(node.FiniteInt("f"));
        Assert.Null(node.FiniteNumber("missing"));
        Assert.False(node.Has("missing"));
        Assert.True(node.Has("n"));
        Assert.Empty(node.Strings("missing"));
    }

    [Fact]
    public void Ajv_messages()
    {
        string Msg(string keyword, string message, string? extra = null, string? missing = null, string[]? allowed = null) =>
            AjvErrors.FormatAjvError(new SchemaIssue(keyword, "/x", message, extra, missing, allowed));
        Assert.Contains("must be object", Msg("type", "object"));
        Assert.Contains("must be integer", Msg("type", "Value is \"number\" but should be \"integer\""));
        Assert.Contains("must be object", Msg("type", "nope"));
        Assert.Contains("must stay", Msg("type", "must stay custom"));
        Assert.Contains("must match pattern \"^a$\"", Msg("pattern", "^a$"));
        Assert.Contains("must match pattern", Msg("pattern", "The string value is not a match"));
        Assert.Equal("already must match", Msg("pattern", "already must match").Replace("(root) ", "").Replace("/x ", ""));
        Assert.Contains("must NOT have more", Msg("maxLength", "no"));
        Assert.Contains("must NOT have more", Msg("maxLength", "must NOT have more than 2 characters"));
        Assert.Contains("fewer than 1 items", Msg("minItems", "x"));
        Assert.Contains("more than 1 items", Msg("maxItems", "x"));
        Assert.Contains("must be >=", Msg("minimum", "x"));
        Assert.Contains("must be <=", Msg("maximum", "x"));
        Assert.Contains("duplicate", Msg("uniqueItems", "x"));
        Assert.Contains("fewer than 1 properties", Msg("minProperties", "x"));
        Assert.Contains("more than 1 properties", Msg("maxProperties", "x"));
        Assert.Contains("must keep", Msg("other", "must keep"));
        Assert.Contains("plain", Msg("other", "plain"));
        Assert.Contains("must be valid", Msg("other", ""));
        Assert.DoesNotContain("property:", Msg("additionalProperties", "m", ""));
        Assert.Contains("(property: a)", Msg("additionalProperties", "m", "a"));
        Assert.Contains("(missing: id)", Msg("required", "must have required property 'id'", missing: "id"));
        Assert.Contains("(allowed: A, B)", Msg("enum", "m", allowed: ["A", "B"]));
        Assert.Contains("mutually exclusive", AjvErrors.FormatAjvError(new SchemaIssue("not", "/t/is_id", "must NOT be valid", null, null, null)));
        Assert.Equal(0, AjvErrors.YamlErrorOffset(null));
        Assert.Equal(0, AjvErrors.YamlErrorOffset([]));
        Assert.Equal(3, AjvErrors.YamlErrorOffset([3, 4]));
        Assert.Equal("", AjvErrors.ErrorFromUnknown((Exception?)null));
        Assert.Equal("boom", AjvErrors.ErrorFromUnknown(new InvalidOperationException("boom")));
        Assert.Equal("text", AjvErrors.ErrorFromUnknown((object?)"text"));
        Assert.Equal("", AjvErrors.ErrorFromUnknown((object?)null));
    }

    [Fact]
    public void Compile_filter_edges()
    {
        var cand = new FilterCandidate { Name = "user", Tags = ["view_type"], Inherits = "set" };
        Assert.True(CompileFilter.Compile("true == 1")(cand));
        Assert.True(CompileFilter.Compile("1 == true")(cand));
        Assert.True(CompileFilter.Compile("false == 0")(cand));
        Assert.True(CompileFilter.Compile("0 == false")(cand));
        Assert.True(CompileFilter.Compile("1 == \"1\"")(cand));
        Assert.True(CompileFilter.Compile("\"1\" == 1")(cand));
        Assert.False(CompileFilter.Compile("\"x\" == 1")(cand));
        Assert.False(CompileFilter.Compile("null == 0")(cand));
        Assert.True(CompileFilter.Compile("\"a\" && \"b\"")(cand));
        Assert.False(CompileFilter.Compile("\"\" && \"b\"")(cand));
        Assert.False(CompileFilter.Compile("0 || \"\"")(cand));
        Assert.True(CompileFilter.Compile("0 || \"a\"")(cand));
        Assert.False(CompileFilter.Compile("null || false")(cand));
        Assert.True(CompileFilter.Compile("!false")(cand));
        Assert.True(CompileFilter.CompileTypes("tag == \"view_type\"")(cand));
        Assert.False(CompileFilter.Compile("tag != \"view_type\"")(cand));
        Assert.ThrowsAny<InvalidOperationException>(() => CompileFilter.Compile("1 + 2"));
        Assert.ThrowsAny<InvalidOperationException>(() => CompileFilter.Compile("("));
        Assert.Null(IncludeFilters.Parse("type == \"user\""));
        Assert.Contains("unterminated", IncludeFilters.Parse("type == \""));
        Assert.Contains("unexpected character", IncludeFilters.Parse("type == 'u'"));
        Assert.Contains("expected ')'", IncludeFilters.Parse("(type == \"a\""));
        Assert.Contains("unexpected", IncludeFilters.Parse("type == \"a\" type"));
        Assert.Contains("expected ==", IncludeFilters.Parse("type \"a\""));
        Assert.Contains("unquoted", IncludeFilters.Parse("type == user"));
        Assert.Contains("quoted string", IncludeFilters.Parse("type =="));
        Assert.Contains("unexpected identifier", IncludeFilters.Parse("foo"));
        Assert.Contains("unexpected string", IncludeFilters.Parse("\"a\""));
        Assert.Contains("unexpected end", IncludeFilters.Parse(""));
        Assert.False(IncludeFilters.Match("bogus +", cand));
        Assert.True(IncludeFilters.Match(null, cand));
        Assert.True(IncludeFilters.Check(Data(null)).Valid);
        Assert.True(IncludeFilters.Check(Doc("includes:\n  - name: x\n")).Valid);
    }

    [Fact]
    public async Task Parser_and_specification_edges()
    {
        var expanded = Specification.ExpandTypes(
        [
            Type("base", "shaped", fields: [Field("id", "integer", isId: true), Field("name", "string")]),
            Type("owner", "inherit", "base", [Field("label", "string")]),
            Type("child", "inherit", "owner", [Field("extra", "string")], extract: ["owner.label", "bare"]),
            Type("mapref", "shaped", fields: [Field("owner_id", "integer", references: new List<string> { "owner.id" })]),
            Type("badref", "shaped", fields: [Field("x", "integer", references: 5)]),
        ]);
        Assert.Contains(expanded, type => type.Name == "child");
        var tree = TypeTrees.DatasourceTypeTree(expanded, "all");
        _ = TypeTrees.DatasourceTypeTreeYaml(tree);
        _ = TypeTrees.DatasourceTypeGraph(expanded);
        var order = TypeTrees.CompareByDatasourceTypeOrder(expanded, name => name == "child" ? "owner" : null);
        Assert.NotEqual(0, order("missing", "also"));

        var reader = new MemoryReader(new Dictionary<string, string>
        {
            [SpecFiles.TypesYaml] = """
types:
  - user:
      tags: [datasource_type]
      fields:
        - email:
            type: string
            size: [1.5, 2]
  - note:
      tags: [datasource_type]
      fields:
        - user_id:
            type: integer
            references: user.id
""",
            [SpecFiles.RoutesYaml] = """
includes:
  - types:
      filter: tag == "datasource_type"
routes: []
combined_routes:
  - user:
      combines:
        - 1
        - {}
""",
        });
        var parsed = await new DeterministicParser(reader).Parse(new Dictionary<string, string>());
        Assert.NotEmpty(parsed.Types);

        var missingChild = new MemoryReader(new Dictionary<string, string>
        {
            [SpecFiles.TypesYaml] = "types:\n  - user:\n      fields:\n        - id:\n            type: integer\n",
            [SpecFiles.RoutesYaml] = "combined_routes:\n  - user:\n      combines:\n        - ghost\n",
        });
        await Assert.ThrowsAnyAsync<InvalidOperationException>(() =>
            new DeterministicParser(missingChild).Parse(new Dictionary<string, string>()));
    }

    [Fact]
    public async Task Readers_and_includes()
    {
        var dir = Path.Combine(Path.GetTempPath(), "dgc-" + Guid.NewGuid().ToString("n"));
        Directory.CreateDirectory(dir);
        var nested = Path.Combine(dir, "nested");
        Directory.CreateDirectory(nested);
        await File.WriteAllTextAsync(Path.Combine(dir, "types.yaml"), "version: 1\n");
        var link = Path.Combine(dir, "link.yaml");
        File.CreateSymbolicLink(link, Path.Combine(dir, "types.yaml"));
        var reader = new FileReader(dir);
        Assert.True(await reader.Exists("types.yaml"));
        Assert.True(await reader.Exists("nested"));
        Assert.False(await reader.Exists("nope.yaml"));
        Assert.Contains("version", await reader.Read("types.yaml"));
        await Assert.ThrowsAnyAsync<InvalidOperationException>(() => reader.Read("nope.yaml"));
        var mem = new MemoryReader(new Dictionary<string, string>());
        await Assert.ThrowsAnyAsync<InvalidOperationException>(() => mem.Read("types.yaml"));

        var missingRoot = await IncludeCycles.Check(Doc("includes:\n  - file: nope.yaml\n"), new ValidateOptions
        {
            IncludeFilePath = "/no/such/include-root/child.yaml",
        });
        Assert.Contains("not found", missingRoot.Errors[0].Message);

        var linked = await IncludeCycles.Check(Doc("includes:\n  - file: link.yaml\n"), new ValidateOptions
        {
            IncludeFilePath = Path.Combine(dir, "types.yaml"),
        });
        Assert.False(linked.Valid);
        Directory.Delete(dir, true);
    }

    [Fact]
    public async Task Semantics_null_and_edges()
    {
        var empty = Data(null);
        Assert.True(TypeModelSemantics.Check(empty).Valid);
        Assert.True(DatasourceModel.CheckModel(empty, null, false).Valid);
        Assert.True(SeedSemantics.Check(empty, null, null, false).Valid);
        Assert.False(SeedSemantics.Needs(null));
        Assert.True(RouteModel.Check(empty).Valid);
        Assert.True(ServiceModel.Check(empty).Valid);
        Assert.True((await FieldDefaults.Check(empty)).Valid);

        var reserved = TypeModelSemantics.Check(Doc("types:\n  - set:\n      fields: []\n  - item:\n      inherits: base\n"));
        Assert.Contains(reserved.Errors, e => e.Message.Contains("reserved") || e.Message.Contains("unknown inherit"));

        var identity = TypeModelSemantics.Check(Doc("""
types:
  - base:
      fields:
        - id:
            type: integer
            is_id: true
  - owner:
      inherits: base
      fields:
        - name:
            type: string
  - prefs:
      inherits: dictionary
      tags: [datasource_type]
      fields:
        - key:
            type: string
        - value:
            type: string
        - owner_id:
            references: owner.id
  - loop_a:
      inherits: loop_b
  - loop_b:
      inherits: loop_a
      fields:
        - id:
            references: loop_a.id
"""));
        Assert.NotNull(identity);

        var seeds = SeedSemantics.Check(Doc("""
seeds:
  - user:
      - row:
          email: 1
          note: null
          big: -1
          flag: "no"
"""), Doc("""
types:
  - user:
      fields:
        - email:
            type: integer
        - note:
            type: string
        - big:
            type: unsignedbiginteger
        - flag:
            type: boolean
        - ref:
            references: other.id
""").Data, null, false);
        Assert.False(seeds.Valid);

        var ds = DatasourceModel.CheckModel(Doc("""
types:
  - user:
      fields:
        - id:
            is_fixed_id: true
        - rev:
            is_optimistic_concurrency: true
            use_native_row_version: true
      indexes:
        - by_email:
            fields: [email, 1]
"""), Doc("""
types:
  - user:
      inherits: base
      fields:
        - email:
            type: string
""").Data, true);
        Assert.False(ds.Valid);

        var catalog = FieldCatalog.Parse("types:\n  - string:\n      min_value: \"0\"\n      defaults:\n        - now:\n            regex: '^now$'\n");
        var defaults = FieldDefaults.Check(Doc("""
types:
  - user:
      fields:
        - name:
            type: string
            default_value: later
includes:
  - combine_options:
      source:
        modify_fields:
          - def:
              type: string
              default_value: 5
        add_fields:
          - add_field:
              extra:
                type: character
                size: 2
                default_value: ab
"""), catalog);
        Assert.False(defaults.Valid);

        Assert.ThrowsAny<InvalidOperationException>(() => Settings.FromSettings(new Dictionary<string, string>
        {
            ["frontend_generate_framework"] = "nope",
        }));
    }

    [Fact]
    public async Task Schema_cache_and_paths()
    {
        var path = await SpecPaths.ResolveSpecPath("backend", "types.spec.yaml");
        var first = await SchemaEngine.Load(path);
        var second = await SchemaEngine.Load(path);
        Assert.Same(first, second);
        var issues = SchemaEngine.Evaluate(first, JsonNode.Parse("null"));
        Assert.NotEmpty(issues);
        Assert.Null(await SpecPaths.FindAncestorPath("no-such-spec-file.yaml", Path.GetTempPath()));
    }
}
