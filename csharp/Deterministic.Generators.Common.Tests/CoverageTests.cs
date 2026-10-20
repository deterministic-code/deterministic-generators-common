using System.Text.RegularExpressions;
using Xunit;

namespace Deterministic.Generators.Common.Tests;

public class CoverageTests
{
    static async Task<string> SpecsRoot()
    {
        var found = await SpecPaths.FindSpecPath("backend", "types.spec.yaml");
        if (found is null) throw new InvalidOperationException("samples/valid not found");
        return Path.GetDirectoryName(Path.GetDirectoryName(found))!;
    }

    [Fact]
    public void Filters_cover_the_interpreter()
    {
        Assert.True(CompileFilter.Compile(null)(Cand("user")));
        Assert.True(CompileFilter.Compile("")(Cand("user")));
        Assert.True(CompileFilter.Compile("1==1")(Cand("user")));
        Assert.True(CompileFilter.Compile("1 == \"1\"")(Cand("user")));
        Assert.True(CompileFilter.Compile("\"1\" == 1")(Cand("user")));
        Assert.False(CompileFilter.Compile("1 === \"1\"")(Cand("user")));
        Assert.True(CompileFilter.Compile("true == 1")(Cand("user")));
        Assert.True(CompileFilter.Compile("1 == true")(Cand("user")));
        Assert.False(CompileFilter.Compile("null == 1")(Cand("user")));
        Assert.True(CompileFilter.Compile("null == null")(Cand("user")));
        Assert.True(CompileFilter.Compile("null === undefined")(Cand("user")));
        Assert.False(CompileFilter.Compile("0")(Cand("user")));
        Assert.False(CompileFilter.Compile("\"\"")(Cand("user")));
        Assert.True(CompileFilter.Compile("1 || 0")(Cand("user")));
        Assert.False(CompileFilter.Compile("0 || 0")(Cand("user")));
        Assert.False(CompileFilter.Compile("1 && 0")(Cand("user")));
        Assert.True(CompileFilter.Compile("1 && 2")(Cand("user")));
        Assert.True(CompileFilter.Compile("!0")(Cand("user")));
        Assert.False(CompileFilter.Compile("!1")(Cand("user")));
        Assert.True(CompileFilter.Compile("true")(Cand("user")));
        Assert.False(CompileFilter.Compile("false")(Cand("user")));
        Assert.False(CompileFilter.Compile("null")(Cand("user")));
        Assert.True(CompileFilter.Compile("1.5 === 1.5")(Cand("user")));
        Assert.False(CompileFilter.Compile("1.5 === 2")(Cand("user")));
        Assert.True(CompileFilter.Compile("true === true")(Cand("user")));
        Assert.False(CompileFilter.Compile("true === false")(Cand("user")));
        Assert.True(CompileFilter.Compile("null === null")(Cand("user")));
        Assert.False(CompileFilter.Compile("1 != 1")(Cand("user")));
        Assert.True(CompileFilter.Compile("1 !== \"1\"")(Cand("user")));
        Assert.True(CompileFilter.Compile("__name == \"user\"")(Cand("user")));
        Assert.True(CompileFilter.Compile("__inherits == \"set\"")(Cand("user", inherits: "set")));
        Assert.True(CompileFilter.Compile("type == \"user\" || tag == \"view_type\"")(Cand("role", ["view_type"])));
        Assert.False(CompileFilter.Compile("type == \"user\" && tag != \"view_type\"")(Cand("role", ["view_type"])));

        Assert.Contains("unknown identifier", ThrowsFilter("type is datasource_type"));
        Assert.Contains("expected ')'", ThrowsFilter("(type == \"user\""));
        Assert.Contains("Unexpected end of input", ThrowsFilter("1 =="));
        Assert.Contains("unexpected character", ThrowsFilter("1 $ 1"));
        Assert.Contains("is not defined", ThrowsFilter("__tags"));
        Assert.Contains("unexpected member", ThrowsFilter("__tags.true"));
        Assert.Contains("expected '('", ThrowsFilter("__tags.includes"));
        Assert.Contains("expected string", ThrowsFilter("__tags.includes(1)"));
        Assert.Contains("expected ')'", ThrowsFilter("__tags.includes(\"a\""));
        Assert.Contains(".includes", ThrowsFilter("__name.includes(\"a\")"));
        Assert.Contains("unexpected ')'", ThrowsFilter(")"));
        Assert.Contains("unexpected '2'", ThrowsFilter("1==1 2"));
        Assert.Contains("unterminated string", ThrowsFilter("\"1"));
    }

    [Fact]
    public void Include_filter_tokenizer_matches_the_typescript_errors()
    {
        Assert.Null(IncludeFilters.Parse("type == \"user\" && tag != \"view_type\" || inherits == \"set\""));
        Assert.Null(IncludeFilters.Parse("(type == \"user\")"));
        Assert.Contains("unterminated string", IncludeFilters.Parse("type == \"user"));
        Assert.Contains("unexpected character", IncludeFilters.Parse("type == 1"));
        Assert.Contains("unquoted", IncludeFilters.Parse("type == user"));
        Assert.Contains("expected == or !=", IncludeFilters.Parse("type \"user\""));
        Assert.Contains("expected ')'", IncludeFilters.Parse("(type == \"user\""));
        Assert.Contains("unexpected end", IncludeFilters.Parse(""));
        Assert.Contains("unexpected identifier", IncludeFilters.Parse("nope"));
        Assert.Contains("unexpected string", IncludeFilters.Parse("\"user\""));
        Assert.Contains("unexpected ')'", IncludeFilters.Parse(")"));
        Assert.Contains("expected a quoted string", IncludeFilters.Parse("type == )"));
        Assert.True(IncludeFilters.Match(null, Cand("user")));
        Assert.False(IncludeFilters.Match("nope", Cand("user")));
        Assert.True(IncludeFilters.Match("type == \"user\"", Cand("user")));
        var doc = Doc("includes:\n  - types:\n      filter: type is bad\n");
        var result = IncludeFilters.Check(doc);
        Assert.Contains("invalid include filter", result.Errors[0].Message);
        Assert.True(IncludeFilters.Check(Doc("version: 1\n")).Valid);
    }

    [Fact]
    public async Task Parser_covers_expand_routes_services_and_seeds()
    {
        var types = """
            types:
              - user:
                  tags: [datasource_type, view_type]
                  inherits: set
                  fields:
                    - email:
                        type: string
                        size: 256
                        min_size: 1
                    - bio:
                        type: string
                        is_nullable: true
                    - code:
                        type: character
                        size: unlimited
                    - span:
                        type: string
                        size: [1, 2]
                    - flag:
                        type: boolean
                        is_id: false
                        default_value: null
                    - nick:
                        type: string
                        references: [user, id]
                    - display_name:
                        type: string
              - role:
                  tags: [datasource_type]
                  inherits: set
                  fields:
                    - name:
                        type: string
                    - title:
                        type: string
              - settings:
                  tags: [datasource_type]
                  inherits: dictionary
                  fields:
                    - user_id:
                        references: user.id
                        type: integer
                    - key:
                        type: string
                    - value:
                        type: string
              - person:
                  tags: [view_type]
                  inherits: user
                  remove_fields: [bio, user.flag]
                  extract: [notqualified]
                  fields:
                    - label:
                        type: string
                    - role:
                        type: role
              - phone_contact:
                  tags: [view_type]
                  union: [user, role]
                  mapping:
                    name: role_name
                    ignored: 1
                  remove_fields: [id]
                  fields:
                    - phone:
                        type: string
              - address:
                  tags: [datasource_type]
                  inherits: set
                  fields:
                    - user_id:
                        references: user.id
                        type: integer
                    - city:
                        type: string
              - membership:
                  tags: [datasource_type, many_to_many]
                  inherits: set
                  fields:
                    - user_id:
                        references: user.id
                        type: integer
                    - role_id:
                        references: role.id
                        type: integer
              - enrollment:
                  tags: [datasource_type, many_to_many]
                  inherits: set
                  fields:
                    - user_id:
                        references: user.id
                        type: integer
                    - role_id:
                        references: role.id
                        type: integer
              - note:
                  tags: [view_type]
                  fields:
                    - body:
                        type: string
                    - phones:
                        type: phone[]
                    - labels:
                        type: labels{}
                        references: labels.key
                        default_value: {}
              - child:
                  inherits: person
                  ids: [email]
              - bag:
                  inherits: dictionary
                  fields:
                    - owner_id:
                        references: user.id
                        type: integer
                    - key:
                        type: string
                    - value:
                        type: string
              - view_bag:
                  inherits: bag
                  fields:
                    - label:
                        type: string
            """;
        var datasource = """
            types:
              - user:
                  mapping: users
                  use_optimistic_concurrency: true
                  fields:
                    - email:
                        is_unique: true
                        is_readonly: false
                        mapping: email_address
                  indexes:
                    - by_email:
                        is_unique: true
                        fields: [email]
              - role:
                  fields:
                    - name:
                        is_unique: yes
            includes:
              - types:
                  filter: tag == "datasource_type"
            """;
        var routes = """
            routes:
              - get_users_by_email: null
              - put_users_by_displayName:
                  null
              - users_by_email:
                  entity: user
                  byField: email
                  methods: [GET, 1]
              - users_by_city:
                  entity: user
                  byField: city
              - ping:
                  path: /ping
                  method: GET
                  entity: user
                  request: note
                  response: note
                  module: ./routes/ping
                  routeClass: Ping
              - user:
                  eager_read_path: [role]
                  eager_update_path: [address]
                  eager_read_member_only: [email]
              - skipped:
                  eager_read_path: []
            combined_routes:
              - user:
                  route: /api/users/{id}
                  combines:
                    - address
                    - role:
                        via: membership
                        target: role
                        route: /roles
            includes:
              - types:
                  filter: tag == "datasource_type"
            """;
        var services = """
            services:
              - name: userService
                module: ./services/user
              - name: generated
                module: ./services/generated/user
              - module: ./skip
              - name: HealthApi
            includes:
              - types:
                  filter: tag == "datasource_type"
            """;
        var seeds = """
            seeds:
              - user:
                  - id1:
                      email: admin
                      extra:
                        nested: 1
            """;
        var det = await Parse(new Dictionary<string, string>
        {
            ["types.yaml"] = types,
            ["datasource.yaml"] = datasource,
            ["routes.yaml"] = routes,
            ["services.yaml"] = services,
            ["datasource_seeds.yaml"] = seeds,
        }, new ParseOptions { ServiceClassName = name => name + "Service" });

        var noteType = det.Types.First(type => type.Name == "note");
        Assert.True(noteType.Fields.First(field => field.Name == "phones").HasDefault);
        Assert.IsAssignableFrom<System.Collections.IList>(noteType.Fields.First(field => field.Name == "phones").DefaultValue);
        Assert.True(noteType.Fields.First(field => field.Name == "labels").HasDefault);
        var user = det.ExpandedTypes.First(type => type.Name == "user");
        Assert.Equal(["id", "email", "bio", "code", "span", "flag", "nick", "display_name"], user.Fields.Select(field => field.Name));
        Assert.Equal("unlimited", user.Fields.First(field => field.Name == "code").Size);
        Assert.IsType<double[]>(user.Fields.First(field => field.Name == "span").Size);
        Assert.True(user.Fields.First(field => field.Name == "flag").HasDefault);
        Assert.Null(user.Fields.First(field => field.Name == "flag").DefaultValue);
        var person = det.ExpandedTypes.First(type => type.Name == "person");
        Assert.Contains(person.Fields, field => field.Name == "label");
        Assert.DoesNotContain(person.Fields, field => field.Name is "bio" or "flag");
        var phone = det.ExpandedTypes.First(type => type.Name == "phone_contact");
        Assert.Contains(phone.Fields, field => field.Name == "role_name");
        Assert.DoesNotContain(phone.Fields, field => field.Name == "id");
        var viewBag = det.ExpandedTypes.First(type => type.Name == "view_bag");
        Assert.DoesNotContain(viewBag.Fields, field => field.Name == "owner_id");
        Assert.Equal(["email"], det.ExpandedTypes.First(type => type.Name == "child").Ids);
        Assert.Contains(det.Datasource, table => table.Name == "enrollment");
        Assert.DoesNotContain(det.Datasource, table => table.Name == "person");
        Assert.Equal("users", det.Datasource.First(table => table.Name == "user").Mapping);
        Assert.Contains("email", det.Datasource.First(table => table.Name == "user").UniqueIndexFields);
        Assert.Contains(det.Routes.Nested, route => route is DirectFkDescriptor);
        Assert.Contains(det.Routes.Nested, route => route is M2mDescriptor m2 && m2.Junction == "membership");
        Assert.Contains("address", det.Routes.ChildrenOnly);
        Assert.Contains(det.Routes.Customs, route => route.Name == "ping");
        Assert.Equal(["role"], det.Routes.Candidates.First(route => route.Name == "user").EagerReadPath);
        var byEmail = det.Routes.Candidates.First(route => route.Name == "user").ByFields.First(field => field.ByField == "email");
        Assert.Contains("GET", byEmail.Methods!);
        Assert.Contains("PUT", det.Routes.Candidates.First(route => route.Name == "user").ByFields.First(field => field.ByField == "display_name").Methods!);
        Assert.Null(det.Routes.Candidates.First(route => route.Name == "user").ByFields.First(field => field.ByField == "city").Methods);
        Assert.DoesNotContain(det.Services.Generics, service => service.Name == "user");
        Assert.Contains(det.Services.Generics, service => service.Name == "role");
        Assert.Contains(det.Services.Customs, service => service.Name == "userService");
        Assert.DoesNotContain(det.Services.Customs, service => service.Name == "generated");
        Assert.Equal(1, det.DatasourceSeeds["user"][0].Id);
        Assert.Equal("admin", det.DatasourceSeeds["user"][0].Row["email"]);
        Assert.DoesNotContain("extra", det.DatasourceSeeds["user"][0].Row.Keys);
        Assert.Equal("HealthCheckService", det.Services.Customs[0].Name);

        var again = EnsureHealth.Apply(det);
        Assert.Equal("HealthCheckService", again.Services.Customs[0].Name);
        var moved = EnsureHealth.Apply(new Deterministic(
            det.Types, det.ExpandedTypes, det.Datasource, det.DatasourceSeeds,
            new ParsedServices
            {
                Customs =
                [
                    new CustomServiceEntry { Name = "Other", Methods = [] },
                    new CustomServiceEntry { Name = "HealthCheckService", Methods = ["check"] },
                ],
            },
            new ParsedRoutes
            {
                Customs =
                [
                    new CustomRouteEntry { Name = "x", Path = "/x" },
                    new CustomRouteEntry { Name = "getHealth", Path = "/api/health", Method = "GET" },
                ],
            }));
        Assert.Equal("HealthCheckService", moved.Services.Customs[0].Name);
        Assert.Equal("/api/health", moved.Routes.Customs[0].Path);
        var copied = new Deterministic(moved);
        Assert.Equal(moved.Types, copied.Types);

        await ThrowsParse("types.yaml", "types:\n  - a:\n      inherits: b\n  - b:\n      inherits: a\n", "circular inherit");
        await ThrowsParse("types.yaml", """
            types:
              - a:
                  fields:
                    - name: {type: string}
              - b:
                  fields:
                    - name: {type: string}
              - c:
                  union: [a, b]
            """, "collide");
        await ThrowsParse("routes.yaml", "routes:\n  - \"\":\n", "non-empty");
        await ThrowsParse("routes.yaml", "routes:\n  - users:\n", "missing `_by_`");
        await ThrowsParse("routes.yaml", "routes:\n  - _by_email:\n", "empty entity");
        await ThrowsParse("routes.yaml", "routes:\n  - ghosts_by_email:\n", "unknown entity");
        await ThrowsParse("routes.yaml", types + "\nroutes:\n  - users_by_missing:\n", "not found on entity", "types.yaml");
        await ThrowsParse("routes.yaml", """
            routes:
              - users_by_email:
                  entity: 1
                  byField: email
            """, "non-string");
        await ThrowsParse("datasource_seeds.yaml", "seeds:\n  - user:\n      - nope:\n          name: a\n", "id\\d+");
        await ThrowsParse("routes.yaml", types + """

            combined_routes:
              - user:
                  combines:
                    - role:
                        via: ""
                        target: role
            """, "both via", "types.yaml");
        await ThrowsParse("routes.yaml", types + """

            combined_routes:
              - user:
                  combines:
                    - role:
                        via: missing
                        target: role
            """, "not found", "types.yaml");
        await ThrowsParse("routes.yaml", types + """

            combined_routes:
              - user:
                  combines:
                    - note:
                        via: membership
                        target: note
            """, "missing FK", "types.yaml");
        await ThrowsParse("routes.yaml", types + """

            combined_routes:
              - user:
                  combines:
                    - role
            """, "ambiguous junction", "types.yaml");
        await ThrowsParse("routes.yaml", """
            types:
              - parent:
                  inherits: set
                  fields:
                    - name: {type: string}
              - child:
                  fields:
                    - name: {type: string}
            combined_routes:
              - parent:
                  combines: [child]
            """, "no FK", "types.yaml");
    }

    [Fact]
    public void Identity_trees_pluralize_and_yaml_helpers()
    {
        var field = new TypeField { Name = "email", Type = "string", Kind = "primitive", Base = "string", IsId = true, HasSize = true, Size = 16L };
        var shaped = new TypeModel { Name = "user", Kind = "shaped", Fields = [field] };
        var set = new TypeModel { Name = "row", Kind = "inherit", Inherits = "set" };
        Assert.Equal(["email"], Specification.IdentityColumns(shaped));
        Assert.Equal(["id"], Specification.IdentityColumns(null));
        Assert.Equal(["id"], Specification.IdentityColumns(set));
        Assert.Equal("email", Specification.PrimaryKeyColumn(null, shaped));
        Assert.Equal("id", Specification.PrimaryKeyColumn(null));
        Assert.True(Specification.HasAuthoredIdentity(shaped));
        Assert.True(Specification.TypeHasTag(new TypeModel { Name = "user", Kind = "shaped", Tags = ["view_type"] }, "view_type"));
        var parts = Specification.ParseFieldType("role[]");
        Assert.Equal("type", parts.Kind);
        Assert.True(parts.IsArray);
        var map = Specification.ParseFieldType("bag{}");
        Assert.True(map.IsMap);
        var table = new DatasourceTable
        {
            Name = "user",
            Fields = [new DatasourceFieldOverlay { Name = "email", IsUnique = true }],
            UniqueIndexFields = ["code"],
        };
        var lookups = Specification.UniqueLookupFields(shaped, table);
        Assert.Equal(["email", "code"], lookups.Select(item => item.Field));
        Assert.Equal(16, lookups[0].Size);

        var parent = new TypeModel
        {
            Name = "user",
            Kind = "shaped",
            Fields = [new TypeField { Name = "id", Type = "integer", Kind = "primitive", Base = "integer" }],
        };
        var child = new TypeModel
        {
            Name = "address",
            Kind = "shaped",
            Fields =
            [
                new TypeField
                {
                    Name = "user_id",
                    Type = "integer",
                    Kind = "primitive",
                    Base = "integer",
                    References = new[] { "user.id", "" },
                },
            ],
        };
        var loopA = new TypeModel
        {
            Name = "a",
            Kind = "shaped",
            Fields = [new TypeField { Name = "b_id", Type = "integer", Kind = "primitive", Base = "integer", References = "b.id" }],
        };
        var loopB = new TypeModel
        {
            Name = "b",
            Kind = "shaped",
            Fields = [new TypeField { Name = "a_id", Type = "integer", Kind = "primitive", Base = "integer", References = "a.id" }],
        };
        var types = new List<TypeModel> { parent, child, loopA, loopB };
        var tree = TypeTrees.DatasourceTypeTree(types);
        Assert.Contains("root", tree.Keys);
        var all = TypeTrees.DatasourceTypeHierarchies(types);
        Assert.NotEmpty(all.Graph.Edges);
        Assert.Contains("user", TypeTrees.DatasourceTypeAncestry(types, "address"));
        Assert.Empty(TypeTrees.DatasourceTypeAncestry(types, "missing"));
        var order = TypeTrees.DatasourceTypeOrder(types);
        Assert.Contains("user", order);
        var compare = TypeTrees.CompareByDatasourceTypeOrder(types, name => name == "alias" ? "user" : null);
        Assert.NotEqual(0, compare("missing-a", "missing-b"));
        Assert.Equal(0, compare("same", "same"));
        var yaml = TypeTrees.DatasourceTypeTreeYaml(tree);
        Assert.Contains("root:", yaml);
        Assert.Contains("{", TypeTrees.DatasourceTypeTreeJson(tree));
        Assert.Contains("<root>", TypeTrees.DatasourceTypeTreeXml(tree));
        var graph = TypeTrees.DatasourceTypeGraph(types);
        Assert.Contains("edges:", TypeTrees.DatasourceTypeGraphYaml(graph));
        Assert.Contains("nodes", TypeTrees.DatasourceTypeGraphJson(graph));
        Assert.Contains("<graph>", TypeTrees.DatasourceTypeGraphXml(graph));
        Assert.Equal("{}\n", TypeTrees.DatasourceTypeTreeYaml(new DatasourceTypeNode()));

        Assert.Equal("people", Pluralize.Plural("person"));
        Assert.Equal("People", Pluralize.Plural("Person"));
        Assert.Equal("PEOPLE", Pluralize.Plural("PERSON"));
        Assert.Equal("people", Pluralize.Plural("pErson"));
        Assert.Equal("users", Pluralize.Plural("user"));
        Assert.Equal("addresses", Pluralize.Plural("address"));
        Assert.Equal("children", Pluralize.Plural("child"));
        Assert.Equal("user", Pluralize.Singular("users"));
        Assert.Equal("person", Pluralize.Singular("people"));
        Assert.Equal("sheep", Pluralize.Plural("sheep"));
        Assert.Equal("", Pluralize.Plural(""));
        Assert.Equal("AS", Pluralize.Plural("A"));
        Assert.Equal("quizzes", Pluralize.Plural("quiz"));
        Assert.Equal("oxen", Pluralize.Plural("ox"));
        Assert.Equal("WE", Pluralize.Plural("I"));

        var node = YamlNode.FromYaml("""
            flag: yes
            n: 1
            big: .inf
            nan: .nan
            hex: 0x10
            oct: -0o10
            huge: 18446744073709551615
            q: ""
            list:
              - one: 1
              - {}
              - [1]
            anchor: &id 1
            alias: *id
            """, "$");
        Assert.Equal("yes", node.Str("flag"));
        Assert.False(node.Bool("flag"));
        Assert.Equal(1, node.FiniteNumber("n"));
        Assert.Equal(1, node.FiniteInt("n"));
        Assert.Null(node.FiniteNumber("big"));
        Assert.Null(node.FiniteInt("span"));
        Assert.True(node.Literal("n").Present);
        Assert.True(node.Literal("q").Present);
        Assert.Equal("", node.Literal("q").Value);
        var emptyDefaults = YamlNode.FromYaml("list: []\nmap: {}\nfull: [1]\nobj: { a: 1 }\n");
        Assert.True(emptyDefaults.Literal("list").Present);
        Assert.True(emptyDefaults.Literal("map").Present);
        Assert.False(emptyDefaults.Literal("full").Present);
        Assert.False(emptyDefaults.Literal("obj").Present);
        Assert.Single(node.NamedList("list"));
        Assert.Equal(1L, node.Child("alias").Value);
        var broken = Assert.Throws<InvalidOperationException>(() => YamlNode.FromYaml("a: *missing\n"));
        Assert.Contains("anchor", broken.Message);
        Assert.Equal(double.PositiveInfinity, YamlDocuments.ResolvePlain(".inf"));
        Assert.Equal(double.NegativeInfinity, YamlDocuments.ResolvePlain("-.inf"));
        Assert.True(double.IsNaN((double)YamlDocuments.ResolvePlain(".nan")!));
        Assert.Equal(long.MinValue, YamlDocuments.ResolvePlain("-0x8000000000000000"));
        Assert.True(YamlDocuments.ResolvePlain("18446744073709551615") is double);

        var parsed = YamlDocuments.Parse("a: 1\nb: [1, x]\n");
        Assert.True(YamlData.PositionFor(null, "/a").Line >= 1);
        Assert.True(YamlData.PositionFor(parsed.Root, "/missing").Line >= 1);
        Assert.True(YamlData.PositionFor(parsed.Root, "/b/nope").Line >= 1);
        Assert.True(YamlData.PositionFor(parsed.Root, "/b/0/extra").Line >= 1);
        Assert.True(YamlData.PositionFor(parsed.Root, "/b/-1").Line >= 1);
        Assert.Equal("a/b", YamlData.Pointer("/a~1b")[0]);
        Assert.Equal("~", YamlData.Pointer("/~0")[0]);
        Assert.Empty(YamlData.Pointer(""));
        Assert.True(YamlData.Has(new Dictionary<string, object?> { ["a"] = 1 }, "a"));
        Assert.True(YamlData.IsString("a"));
        Assert.True(YamlData.IsBool(true, true));
        Assert.False(YamlData.IsBool(false, true));
        Assert.True(YamlData.IsNumber(1L));
        Assert.True(YamlData.IsNumber(1));
        Assert.True(YamlData.IsNumber(1.5));
        Assert.True(YamlData.IsNumber(1ul));
        Assert.True(YamlData.IsNumber(1f));
        Assert.True(YamlData.IsNumber(1m));
        Assert.True(YamlData.TryFinite(1ul, out _));
        Assert.False(YamlData.TryFinite(ulong.MaxValue, out _));
        Assert.True(YamlData.TryFinite(1.5f, out _));
        Assert.False(YamlData.TryFinite(double.NaN, out _));
        Assert.False(YamlData.TryFinite("x", out _));
        Assert.True(YamlData.IsInteger(2L));
        Assert.False(YamlData.IsInteger(1.5));
        Assert.Equal(["a"], YamlData.StringList(new List<object?> { "a", 1 }));
        Assert.Null(YamlData.StringList("nope"));
        Assert.Null(YamlData.SingleKey(new Dictionary<string, object?>()));
        Assert.Null(YamlData.Plain(null));
        var doc = Doc("a: 1\n");
        var errors = new List<SpecValidationError>();
        Assert.True(YamlData.PushUnique([], "a", errors, doc, "/a", "dup"));
        Assert.False(YamlData.PushUnique(["a"], "a", errors, doc, "/a", "dup"));

        Assert.Equal(12, AjvErrors.YamlErrorOffset([12, 15]));
        Assert.Equal(0, AjvErrors.YamlErrorOffset(null));
        Assert.Equal(0, AjvErrors.YamlErrorOffset([]));
        Assert.Contains("must be string", AjvErrors.FormatAjvError(new SchemaIssue("type", "", "Value is \"array\" but should be \"string\"", null, null, null)));
        Assert.Equal("boom", AjvErrors.ErrorFromUnknown(new InvalidOperationException("boom")));
        Assert.Equal("plain", AjvErrors.ErrorFromUnknown((object?)"plain"));
        Assert.Equal("", AjvErrors.ErrorFromUnknown(null));
        Assert.Contains("must be object", AjvErrors.FormatAjvError(new SchemaIssue("type", "", "nope", null, null, null)));
        Assert.Contains("must have required property 'fields'", AjvErrors.FormatAjvError(new SchemaIssue("required", "/a", "missing 'fields'", null, null, null)));
        Assert.Contains("must have required property", AjvErrors.FormatAjvError(new SchemaIssue("required", "/a", "missing", null, null, null)));
        Assert.Contains("(property: tags2)", AjvErrors.FormatAjvError(new SchemaIssue("additionalProperties", "/a", "must NOT have additional properties", "tags2", null, null)));
        Assert.Contains("(missing: version)", AjvErrors.FormatAjvError(new SchemaIssue("required", "", "must have required property 'version'", null, "version", null)));
        Assert.Contains("(allowed: )", AjvErrors.FormatAjvError(new SchemaIssue("enum", "/m", "must be equal to one of the allowed values", null, null, [])));
        Assert.Contains("must match exactly one", AjvErrors.FormatAjvError(new SchemaIssue("oneOf", "", "must match exactly one schema in oneOf", null, null, null)));
        Assert.Contains("must match a schema in anyOf", AjvErrors.FormatAjvError(new SchemaIssue("anyOf", "", "x", null, null, null)));
        Assert.Contains("must NOT be valid", AjvErrors.FormatAjvError(new SchemaIssue("not", "/x", "x", null, null, null)));
        Assert.Contains("mutually exclusive", AjvErrors.FormatAjvError(new SchemaIssue("not", "/types/0/user/is_id", "must NOT be valid", null, null, null)));
        Assert.Contains("must be equal to constant", AjvErrors.FormatAjvError(new SchemaIssue("const", "/a", "x", null, null, null)));
        Assert.Contains("must match pattern", AjvErrors.FormatAjvError(new SchemaIssue("pattern", "/version", "no", null, null, null)));
        Assert.Contains("must be longer", AjvErrors.FormatAjvError(new SchemaIssue("minLength", "/a", "must be longer", null, null, null)));
        Assert.Contains("fewer than 1 characters", AjvErrors.FormatAjvError(new SchemaIssue("minLength", "/a", "too short", null, null, null)));
        Assert.Contains("more than 1 characters", AjvErrors.FormatAjvError(new SchemaIssue("maxLength", "/a", "x", null, null, null)));
        Assert.Contains("fewer than 1 items", AjvErrors.FormatAjvError(new SchemaIssue("minItems", "/a", "x", null, null, null)));
        Assert.Contains("more than 1 items", AjvErrors.FormatAjvError(new SchemaIssue("maxItems", "/a", "x", null, null, null)));
        Assert.Contains("must be >= 0", AjvErrors.FormatAjvError(new SchemaIssue("minimum", "/a", "x", null, null, null)));
        Assert.Contains("must be <= 0", AjvErrors.FormatAjvError(new SchemaIssue("maximum", "/a", "x", null, null, null)));
        Assert.Contains("duplicate items", AjvErrors.FormatAjvError(new SchemaIssue("uniqueItems", "/a", "x", null, null, null)));
        Assert.Contains("fewer than 1 properties", AjvErrors.FormatAjvError(new SchemaIssue("minProperties", "/a", "x", null, null, null)));
        Assert.Contains("more than 1 properties", AjvErrors.FormatAjvError(new SchemaIssue("maxProperties", "/a", "x", null, null, null)));
        Assert.Contains("must be valid", AjvErrors.FormatAjvError(new SchemaIssue("weird", "", "", null, null, null)));
        Assert.Contains("custom", AjvErrors.FormatAjvError(new SchemaIssue("weird", "/a", "custom", null, null, null)));

        var options = new ValidateOptions { Types = "t", Datasource = "d" };
        Assert.True(options.HasTypes);
        Assert.True(options.HasDatasource);
        var updated = options.With(types: "n", setTypes: true, includeFilePath: "f");
        Assert.Equal("n", updated.Types);
        Assert.Equal("d", updated.Datasource);
        Assert.Equal("f", updated.IncludeFilePath);
        Assert.False(new ValidateOptions().HasTypes);

        var named = Settings.FromSettings(new Dictionary<string, string>
        {
            ["application_name"] = "app",
            ["frontend_generate_framework"] = "next",
            ["comments"] = "none",
            ["codegen.create_index"] = "true",
            ["languages.typescript.library_reference_mode"] = "project",
        });
        Assert.Equal("app", named.ApplicationName);
        Assert.Equal("next", named.FrontendFramework);
        Assert.False(named.SimpleDoc);
        Assert.Equal("project", named.LibraryReferenceMode);
        Assert.Equal(Path.Combine("backend", "types.spec.yaml"), SpecPaths.SpecRelPath("backend", "types.spec.yaml"));
    }

    [Fact]
    public async Task Semantics_cover_types_datasource_seeds_and_includes()
    {
        var types = Doc("""
            types:
              - user:
                  tags: [datasource_type]
                  inherits: set
                  fields:
                    - email:
                        type: string
                    - email:
                        type: string
              - orphan:
                  inherits: missing
              - set:
                  fields:
                    - name: {type: string}
              - bag:
                  tags: [datasource_type, view_type]
                  inherits: dictionary
                  fields:
                    - key: {type: string}
              - viewbag:
                  tags: [view_type]
                  inherits: dictionary
                  fields:
                    - owner_id:
                        type: integer
                        references: user.id
                    - key: {type: string}
                    - value: {type: user}
              - ownerbag:
                  tags: [datasource_type]
                  inherits: dictionary
                  fields:
                    - key: {type: string}
                    - value: {type: string}
              - note:
                  fields:
                    - settings:
                        type: missing{}
                        references: missing.value
                    - amount:
                        type: decimal
                        size: [1, 2]
                    - code:
                        type: string
                        is_id: true
                    - alt:
                        type: string
                        is_id: true
                  ids: [missing]
              - child:
                  inherits: user
                  union: [missing, user]
                  extract: [user.nope, nope]
                  mapping:
                    name: title
                    email: mail
                  remove_fields: [nope]
                  fields:
                    - ref:
                        references: ghost.col
            """);
        var typeErrors = string.Join("\n", TypeModelSemantics.Check(types).Errors.Select(error => error.Message));
        Assert.Contains("duplicate field", typeErrors);
        Assert.Contains("reserved type name", typeErrors);
        Assert.Contains("unknown inherit", typeErrors);
        Assert.Contains("must include a value field", typeErrors);
        Assert.Contains("must not be tagged datasource_type", typeErrors);
        Assert.Contains("must not reference an owner identity", typeErrors);
        Assert.Contains("must name a dictionary type", typeErrors);
        Assert.Contains("scale", typeErrors);
        Assert.Contains("at most one field", typeErrors);
        Assert.Contains("mutually exclusive", typeErrors);
        Assert.Contains("is not a field", typeErrors);
        Assert.Contains("unknown type", typeErrors);

        var good = Doc("""
            types:
              - user:
                  inherits: set
                  fields:
                    - email: {type: string}
              - role:
                  inherits: set
                  fields:
                    - name: {type: string}
              - contact:
                  inherits: user
                  union: [role]
                  extract: [role.name]
                  mapping:
                    role.name: role_name
                  remove_fields: [email]
            """);
        Assert.True(TypeModelSemantics.Check(good).Valid);

        var roles = Doc("""
            types:
              - phone:
                  tags: [datasource_type]
                  inherits: set
              - phone_attribute:
                  tags: [datasource_type]
                  inherits: set
                  fields:
                    - phone_id:
                        references: phone.id
                    - attribute_name: {type: string}
                    - attribute_value: {type: string}
                    - locale: {type: string}
                    - timezone: {type: string}
              - locale_preferences:
                  tags: [view_type]
                  fields:
                    - locale: {type: string}
                    - timezone: {type: string}
                    - region: {type: string}
                    - extras:
                        type: phone[]
                    - flags:
                        type: attrs{}
                        references: phone_attribute.phone_id
                    - unlabeled: {}
              - attrs:
                  tags: [view_type]
                  inherits: dictionary
                  fields:
                    - key:
                        type: string
                        references: phone_attribute.attribute_name
                    - value:
                        type: string
                        references: phone_attribute.attribute_value
              - prefs_row:
                  tags: [datasource_type]
                  inherits: set
                  fields:
                    - phone_id:
                        references: phone.id
                    - key: {type: string}
                    - locale: {type: string}
                    - timezone: {type: string}
              - prefs:
                  tags: [view_type]
                  inherits: dictionary
                  fields:
                    - key: {type: string}
                    - value: {type: locale_preferences}
              - ghost_map:
                  tags: [view_type]
                  inherits: dictionary
                  fields:
                    - key: {type: string}
                    - value: {type: missing_shape}
              - bare_map:
                  tags: [view_type]
                  inherits: dictionary
                  fields:
                    - key: {type: string}
                    - value: {}
              - phone_view:
                  tags: [view_type]
                  inherits: phone
                  fields:
                    - attributes:
                        type: attrs{}
                        references: phone_attribute.phone_id
                    - prefs:
                        type: prefs{}
                        references: prefs_row.phone_id
                    - missing_value:
                        type: ghost_map{}
                        references: prefs_row.phone_id
                    - bare:
                        type: bare_map{}
                        references: prefs_row.phone_id
            """);
        var roleResult = TypeModelSemantics.Check(roles);
        var roleOk = string.Join("\n", roleResult.Errors.Select(error => error.Message));
        Assert.Contains("must include a region column", roleOk);
        Assert.Contains("must include a value column", roleOk);

        var roleErrors = Doc("""
            types:
              - phone:
                  tags: [datasource_type]
                  inherits: set
              - phone_attribute:
                  tags: [datasource_type]
                  inherits: set
                  fields:
                    - phone_id:
                        references: phone.id
                    - other: {type: string}
              - attrs:
                  tags: [view_type]
                  inherits: dictionary
                  fields:
                    - key:
                        type: string
                        references: phone.other
                    - value: {type: string}
              - phone_view:
                  tags: [view_type]
                  inherits: phone
                  fields:
                    - attributes:
                        type: attrs{}
                        references: phone_attribute.phone_id
            """);
        var roleMessages = string.Join("\n", TypeModelSemantics.Check(roleErrors).Errors.Select(error => error.Message));
        Assert.Contains("must reference a column on phone_attribute", roleMessages);
        Assert.Contains("must include a value column", roleMessages);

        var cycle = Doc("""
            types:
              - a:
                  inherits: b
              - b:
                  inherits: a
            """);
        Assert.Contains("circular inherit", TypeModelSemantics.Check(cycle).Errors[0].Message);

        var datasource = Doc("""
            types:
              - user:
                  fields:
                    - email:
                        is_fixed_id: true
                        is_readonly: false
                    - row:
                        is_optimistic_concurrency: true
                        use_native_row_version: true
                    - stamp:
                        use_native_row_version: true
                    - extra:
                        is_optimistic_concurrency: true
                  indexes:
                    - by_email:
                        fields: [missing]
                    - by_email:
                        fields: [email]
              - user:
                  fields: []
              - ghost:
                  fields:
                    - nope: {}
            """);
        var companion = """
            types:
              - user:
                  inherits: set
                  fields:
                    - email: {type: string}
                    - row: {type: string}
            """;
        var ds = DatasourceModel.CheckModel(datasource, YamlData.Plain(YamlDocuments.Parse(companion).Root), true);
        var dsText = string.Join("\n", ds.Errors.Select(error => error.Message));
        Assert.Contains("requires is_readonly", dsText);
        Assert.Contains("requires is_optimistic_concurrency", dsText);
        Assert.Contains("at most one", dsText);
        Assert.Contains("unknown field", dsText);
        Assert.Contains("duplicate index", dsText);
        Assert.Contains("duplicate type", dsText);
        Assert.Contains("not in types.yaml", dsText);
        Assert.Contains("must be integer", dsText);
        Assert.Contains("requires a binary field", dsText);

        var seeds = Doc("""
            seeds:
              - user:
                  - id1:
                      email: null
                      name: "x"
                      created: now
                      flag: true
                  - id1:
                      email: a
              - user:
                  - id2:
                      email: a
              - ghost:
                  - id1:
                      name: a
              - role:
                  - {}
            """);
        var seedTypes = """
            types:
              - user:
                  fields:
                    - email: {type: string}
                    - name:
                        type: integer
                        references: role.title
                    - flag: {type: boolean, is_nullable: true}
                    - code: {type: character}
              - role:
                  fields:
                    - title: {type: string}
                    - count: {type: unsignedinteger}
            """;
        var seedDs = """
            types:
              - user: {}
            includes:
              - types:
                  filter: type == "user"
            """;
        var seedResult = SeedSemantics.Check(
            seeds,
            YamlData.Plain(YamlDocuments.Parse(seedTypes).Root),
            YamlData.Plain(YamlDocuments.Parse(seedDs).Root),
            true);
        var seedText = string.Join("\n", seedResult.Errors.Select(error => error.Message));
        Assert.Contains("not nullable", seedText);
        Assert.Contains("must be integer", seedText);
        Assert.Contains("auto-injected", seedText);
        Assert.Contains("duplicate seed id", seedText);
        Assert.Contains("duplicate seed table", seedText);
        Assert.Contains("not in datasource.yaml", seedText);
        Assert.Contains("missing required field", seedText);
        Assert.False(SeedSemantics.Needs(Doc("seeds: []").Data));
        Assert.True(SeedSemantics.Needs(seeds.Data));
        Assert.Contains("required to validate", SeedSemantics.Companion(seeds, "types.yaml is required to validate seeds (pass types, or place types.yaml next to the seeds file)").Errors[0].Message);

        var routes = RouteModel.Check(Doc("""
            routes:
              - users
              - users
              - ping:
                  service: A
                  services: [B]
                  module: ./ping
            """));
        Assert.Contains("duplicate route", routes.Errors[0].Message);
        Assert.Contains("cannot combine", routes.Errors[1].Message);
        Assert.True(RouteModel.Check(Doc("version: 1")).Valid);
        var services = ServiceModel.Check(Doc("""
            services:
              - name: A
              - name: A
              - name: ""
            """));
        Assert.Contains("duplicate service", services.Errors[0].Message);

        var catalog = new Dictionary<string, FieldCatalog.FieldType>
        {
            ["integer"] = new()
            {
                Name = "integer",
                Defaults = [new FieldCatalog.DefaultToken { Token = "Zero", Regex = "^0$" }],
                MinValue = "0",
                MaxValue = "10",
            },
            ["character"] = new() { Name = "character" },
            ["datetime"] = new()
            {
                Name = "datetime",
                Defaults = [new FieldCatalog.DefaultToken { Token = "Now", Regex = "^Now$" }],
            },
        };
        var defaults = FieldDefaults.Check(Doc("""
            types:
              - event:
                  fields:
                    - n:
                        type: integer
                        default_value: 11
                    - c:
                        type: character
                        size: 2
                        default_value: a
                    - when:
                        type: datetime
                        default_value: Yesterday
                    - ok:
                        type: integer
                        default_value: 1
            includes:
              - combine_options:
                  source:
                    modify_fields:
                      - def:
                          type: integer
                          default_value: nope
                    add_fields:
                      - add_field:
                          extra:
                            type: integer
                            default_value: 0
                  destination: {}
            """), catalog);
        var defaultText = string.Join("\n", defaults.Errors.Select(error => error.Message));
        Assert.Contains("out of range", defaultText);
        Assert.Contains("length must equal size", defaultText);
        Assert.Contains("not a valid datetime default", defaultText);
        Assert.Contains("not a valid integer default", defaultText);
        Assert.True(FieldDefaults.Check(Doc("""
            types:
              - t:
                  fields:
                    - phones:
                        type: phone[]
                        default_value: []
                    - labels:
                        type: labels{}
                        default_value: {}
                    - notes:
                        type: note[]
                        is_nullable: true
                        default_value: null
                    - prefs:
                        type: prefs{}
                        is_nullable: true
                        default_value: null
            """), catalog).Valid);
        var collectionDefaults = FieldDefaults.Check(Doc("""
            types:
              - t:
                  fields:
                    - phones:
                        type: phone[]
                        default_value: {}
                    - labels:
                        type: labels{}
                        default_value: []
                    - notes:
                        type: note[]
                        default_value: null
            """), catalog);
        var collectionText = string.Join("\n", collectionDefaults.Errors.Select(error => error.Message));
        Assert.Contains("must be []", collectionText);
        Assert.Contains("must be {}", collectionText);
        Assert.Contains("is_nullable is true", collectionText);
        var parsedCatalog = FieldCatalog.Parse("""
            types:
              - integer:
                  supports_size: true
                  implicit_default: 0
                  min_value: 0
                  max_value: null
                  defaults:
                    - Zero:
                        regex: "^0$"
            """);
        Assert.True(parsedCatalog["integer"].HasImplicit);
        Assert.True(parsedCatalog["integer"].MaxIsNull);
        var loaded = await FieldCatalog.Load(await SpecsRoot());
        var loadedAgain = await FieldCatalog.Load(await SpecsRoot());
        Assert.Same(loaded, loadedAgain);
        Assert.Contains("string", loaded.Keys);

        var dir = Path.Combine(Path.GetTempPath(), "dgc-inc-" + Guid.NewGuid().ToString("n"));
        Directory.CreateDirectory(dir);
        try
        {
            var self = Path.Combine(dir, "self.yaml");
            await File.WriteAllTextAsync(self, "includes:\n  - file: self.yaml\n");
            var bad = Path.Combine(dir, "bad.yaml");
            await File.WriteAllTextAsync(bad, "includes:\n  - file: nope.yaml\n  - file: list.yaml\n  - file: broken.yaml\n  - file: .\n");
            await File.WriteAllTextAsync(Path.Combine(dir, "list.yaml"), "- 1\n");
            await File.WriteAllTextAsync(Path.Combine(dir, "broken.yaml"), "foo: [unterminated\n");
            var includeCycle = await IncludeCycles.Check(Doc(await File.ReadAllTextAsync(self)), new ValidateOptions { IncludeFilePath = self });
            Assert.Contains("circular include", includeCycle.Errors[0].Message);
            var other = await IncludeCycles.Check(Doc(await File.ReadAllTextAsync(bad)), new ValidateOptions { IncludeBasePath = dir });
            var messages = string.Join("\n", other.Errors.Select(error => error.Message));
            Assert.Contains("include file not found: nope.yaml", messages);
            Assert.Contains("include must be a mapping", messages);
            Assert.Contains("include is not valid YAML", messages);
            Assert.Contains("cannot read include", messages);
            Assert.True((await IncludeCycles.Check(Doc("version: 1\n"), null)).Valid);
            var withPath = await IncludeCycles.WithIncludeFilePath(self, new ValidateOptions { IncludeFilePath = "keep" });
            Assert.Equal("keep", withPath!.IncludeFilePath);
        }
        finally
        {
            Directory.Delete(dir, true);
        }
    }

    [Fact]
    public async Task Validators_cover_samples_examples_and_schema_keywords()
    {
        var specs = await SpecsRoot();
        var valid = Path.Combine(specs, "samples", "valid");
        Assert.True((await new RoutesApiValidator().ValidateFile(Path.Combine(valid, "routes_api.yaml"))).Valid);
        Assert.True((await new SpecValidator(new SpecRef("backend", "app.spec.yaml")).ValidateFile(Path.Combine(valid, "backend_app.yaml"))).Valid);
        var specPath = await SpecPaths.ResolveSpecPath("backend", "types.spec.yaml", specs);
        var cached = new SpecValidator(specPath);
        Assert.True((await cached.ValidateFile(Path.Combine(valid, "types.semver.yaml"))).Valid);
        Assert.True((await cached.ValidateFile(Path.Combine(valid, "types.semver.yaml"))).Valid);

        foreach (var app in new[] { "minimal", "tasks" })
        {
            var dir = Path.Combine(specs, "examples", app);
            foreach (var file in Directory.GetFiles(dir, "*.yaml"))
            {
                var result = await ValidatorFor(Path.GetFileName(file)).ValidateFile(file);
                Assert.True(result.Valid, $"{app}/{Path.GetFileName(file)} {result.Errors.FirstOrDefault()?.Message}");
            }
        }

        var errors = Path.Combine(specs, "examples", "errors");
        foreach (var file in Directory.GetFiles(errors, "*.yaml"))
        {
            var text = await File.ReadAllTextAsync(file);
            var (expect, yaml) = SplitSample(text);
            var includes = Strings(expect.GetValueOrDefault("includes"));
            Assert.NotEmpty(includes);
            var options = new ValidateOptions
            {
                Types = expect.GetValueOrDefault("types") as string,
                Datasource = expect.GetValueOrDefault("datasource") as string,
            };
            var result = await ValidatorFor(Path.GetFileName(file)).Validate(yaml, options);
            Assert.False(result.Valid, Path.GetFileName(file));
            var blob = string.Join("\n", result.Errors.Select(error => error.Message));
            foreach (var needle in includes)
                Assert.True(blob.Contains(needle), Path.GetFileName(file) + "\n" + blob);
        }

        foreach (var (folder, make) in SampleValidators())
        {
            var dir = Path.Combine(specs, "samples", "invalid", folder);
            if (!Directory.Exists(dir)) continue;
            foreach (var file in Directory.GetFiles(dir, "*.yaml"))
            {
                var text = await File.ReadAllTextAsync(file);
                var (_, yaml) = SplitSample(text);
                var result = await make().Validate(yaml);
                var json = YamlDocuments.Parse(yaml).Root?.ToJson()?.ToJsonString();
                Assert.False(result.Valid, file + "\n" + json);
            }
        }

        var schemaDir = Path.Combine(Path.GetTempPath(), "dgc-schema-" + Guid.NewGuid().ToString("n"));
        Directory.CreateDirectory(schemaDir);
        try
        {
            var schema = Path.Combine(schemaDir, "tiny.spec.yaml");
            await File.WriteAllTextAsync(schema, """
                type: object
                properties:
                  method:
                    enum: [GET, POST]
                  is_id:
                    not: true
                  value:
                    const: 1
                  name:
                    anyOf:
                      - type: string
                      - type: number
                required: [method]
                """);
            var validator = new SpecValidator(schema);
            var result = await validator.Validate("method: NOPE\nvalue: true\nname: true\nis_id: true\n");
            var blob = string.Join("\n", result.Errors.Select(error => error.Message));
            Assert.Contains("allowed: GET, POST", blob);
            Assert.Contains("ids and is_id are mutually exclusive", blob);
            Assert.Contains("must be equal to constant", blob);
        }
        finally
        {
            Directory.Delete(schemaDir, true);
        }

        var missing = await new SpecValidator(new SpecRef("no-such", "missing.spec.yaml")).Validate("version: 1\n");
        Assert.Contains("spec file not found", missing.Errors[0].Message);
        var syntax = await new TypesValidator().Validate("foo: [unterminated");
        Assert.Equal("", syntax.Errors[0].InstancePath);
        Assert.False(string.IsNullOrEmpty(syntax.Errors[0].Message));

        var emptySeeds = await new DatasourceSeedsValidator().Validate("version: 1.0.0\nseeds: []\n");
        Assert.True(emptySeeds.Valid);
        var seedFile = Path.Combine(Path.GetTempPath(), "dgc-seeds-" + Guid.NewGuid().ToString("n") + ".yaml");
        await File.WriteAllTextAsync(seedFile, "version: 1.0.0\nseeds:\n  - user:\n      - id1:\n          name: a\n");
        try
        {
            var lonely = await new DatasourceSeedsValidator().ValidateFile(seedFile);
            Assert.Contains("types.yaml is required", lonely.Errors[0].Message);
        }
        finally
        {
            File.Delete(seedFile);
        }
    }

    [Fact]
    public async Task Readers_and_spec_paths_cover_the_remaining_edges()
    {
        var dir = Path.Combine(Path.GetTempPath(), "dgc-read-" + Guid.NewGuid().ToString("n"));
        Directory.CreateDirectory(dir);
        try
        {
            await File.WriteAllTextAsync(Path.Combine(dir, "types.yaml"), "version: 1\n");
            var reader = new FileReader(dir);
            Assert.Equal("version: 1\n", await reader.Read("types.yaml"));
            Assert.False(await reader.Exists("missing.yaml"));
            var found = await SpecPaths.FindSpecPath("backend", "types.spec.yaml");
            Assert.NotNull(found);
            await Assert.ThrowsAsync<InvalidOperationException>(() => SpecPaths.ResolveSpecPath("nope", "gone.yaml", Path.GetPathRoot(dir)));
        }
        finally
        {
            Directory.Delete(dir, true);
        }
    }

    static FilterCandidate Cand(string name, string[]? tags = null, string? inherits = null) =>
        new() { Name = name, Tags = tags ?? [], Inherits = inherits };

    static string ThrowsFilter(string expr)
    {
        var ex = Assert.Throws<InvalidOperationException>(() => CompileFilter.CompileTypesFilter(expr));
        return ex.Message;
    }

    static ParsedYaml Doc(string yaml)
    {
        var parsed = YamlDocuments.Parse(yaml);
        Assert.Empty(parsed.Errors);
        return new ParsedYaml { Root = parsed.Root, Data = YamlData.Plain(parsed.Root) };
    }

    static async Task<IDeterministic> Parse(Dictionary<string, string> files, ParseOptions? options = null) =>
        await new DeterministicParser(new MemoryReader(files)).Parse(new Dictionary<string, string>(), options);

    static async Task ThrowsParse(string file, string yaml, string needle, string? also = null)
    {
        var files = new Dictionary<string, string> { [file] = yaml };
        if (also is not null && also != file)
        {
            var types = yaml.Contains("types:") ? yaml : "types: []\n";
            files["types.yaml"] = types;
        }
        if (also == "types.yaml" && file != "types.yaml" && yaml.Contains("types:"))
            files["types.yaml"] = yaml;
        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => Parse(files));
        Assert.Contains(needle, ex.Message);
    }

    static (Dictionary<string, object?> Expect, string Yaml) SplitSample(string text)
    {
        var parts = Regex.Split(text, @"^---\s*$", RegexOptions.Multiline)
            .Select(part => part.Trim())
            .Where(part => part.Length > 0)
            .ToArray();
        var meta = YamlData.AsRecord(YamlData.Plain(YamlDocuments.Parse(parts[0]).Root))!;
        return (YamlData.AsRecord(meta["expect"])!, string.Join("\n---\n", parts.Skip(1)));
    }

    static List<string> Strings(object? value)
    {
        if (value is string text) return [text];
        if (value is List<object?> list) return list.OfType<string>().ToList();
        return [];
    }

    static SpecValidator ValidatorFor(string file)
    {
        var stem = Path.GetFileNameWithoutExtension(file);
        var prefix = stem.Split('.')[0];
        return prefix switch
        {
            "types" => new TypesValidator(),
            "datasource" => new DatasourceValidator(),
            "datasource_seeds" => new DatasourceSeedsValidator(),
            "routes" => new RoutesValidator(),
            "routes_api" => new RoutesApiValidator(),
            "services" => new ServicesValidator(),
            "frontend_bindings" => new FrontendBindingsValidator(),
            "backend_app" or "backend-app" => new SpecValidator(new SpecRef("backend", "app.spec.yaml")),
            _ => throw new InvalidOperationException($"no validator for {file}"),
        };
    }

    static IEnumerable<(string Folder, Func<SpecValidator> Make)> SampleValidators()
    {
        yield return ("types", () => new TypesValidator());
        yield return ("datasource", () => new DatasourceValidator());
        yield return ("datasource_seeds", () => new DatasourceSeedsValidator());
        yield return ("routes", () => new RoutesValidator());
        yield return ("routes_api", () => new RoutesApiValidator());
        yield return ("services", () => new ServicesValidator());
        yield return ("frontend_bindings", () => new FrontendBindingsValidator());
        yield return ("backend_app", () => new SpecValidator(new SpecRef("backend", "app.spec.yaml")));
    }
}
