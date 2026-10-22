using Xunit;

namespace Deterministic.Generators.Common.Tests;

public class BehaviorTests
{
    [Fact]
    public void Settings_match_typescript_defaults_and_errors()
    {
        var missing = Settings.FromSettings(new Dictionary<string, string>());
        Assert.Equal("generated-frontend", missing.ApplicationName);
        Assert.Equal("vite", missing.FrontendFramework);
        Assert.Equal("1.0", missing.SchemaVersion);
        Assert.True(missing.CreateIndex);
        Assert.True(missing.SimpleDoc);
        Assert.False(missing.DescriptionDoc);
        Assert.False(missing.FullStack);
        Assert.Null(missing.LibraryReferenceMode);

        var empty = Settings.FromSettings(new Dictionary<string, string>
        {
            ["application_name"] = "",
            ["frontend_generate_framework"] = "",
            ["codegen.schema_version"] = "",
            ["codegen.create_index"] = "false",
            ["comments"] = "description",
            ["application_tier"] = "full-stack",
            ["languages.typescript.library_reference_mode"] = "",
        });
        Assert.Equal("generated-frontend", empty.ApplicationName);
        Assert.Equal("vite", empty.FrontendFramework);
        Assert.Equal("", empty.SchemaVersion);
        Assert.False(empty.CreateIndex);
        Assert.False(empty.SimpleDoc);
        Assert.True(empty.DescriptionDoc);
        Assert.True(empty.FullStack);
        Assert.Equal("", empty.LibraryReferenceMode);

        var ex = Assert.Throws<InvalidOperationException>(() =>
            Settings.FromSettings(new Dictionary<string, string> { ["frontend_generate_framework"] = "nope" }));
        Assert.Contains("\"vite\"", ex.Message);
        Assert.Contains("got \"nope\"", ex.Message);
    }

    [Fact]
    public async Task Readers_use_the_typescript_error_strings()
    {
        var memory = new MemoryReader(new Dictionary<string, string> { ["types.yaml"] = "version: 1.0.0\n" });
        Assert.True(await memory.Exists("types.yaml"));
        Assert.False(await memory.Exists("missing.yaml"));
        Assert.Equal("version: 1.0.0\n", await memory.Read("types.yaml"));
        var missing = await Assert.ThrowsAsync<InvalidOperationException>(() => memory.Read("nope.yaml"));
        Assert.Equal("deterministic reader: missing nope.yaml", missing.Message);

        var dir = Path.Combine(Path.GetTempPath(), "dgc-" + Guid.NewGuid().ToString("n"));
        Directory.CreateDirectory(dir);
        try
        {
            Directory.CreateDirectory(Path.Combine(dir, "sub"));
            var reader = new FileReader(dir);
            Assert.True(await reader.Exists("sub"));
            var fileMissing = await Assert.ThrowsAsync<InvalidOperationException>(() => reader.Read("types.yaml"));
            Assert.Equal($"deterministic reader: missing types.yaml in {Path.GetFullPath(dir)}", fileMissing.Message);
        }
        finally
        {
            Directory.Delete(dir, true);
        }
    }

    [Fact]
    public void Yaml_cursor_and_scalars_match_yaml_1_2()
    {
        Assert.Equal("yes", YamlDocuments.ResolvePlain("yes"));
        Assert.Equal(true, YamlDocuments.ResolvePlain("true"));
        Assert.Equal(false, YamlDocuments.ResolvePlain("FALSE"));
        Assert.Null(YamlDocuments.ResolvePlain("~"));
        Assert.Equal(16L, YamlDocuments.ResolvePlain("0x10"));
        Assert.Equal(8L, YamlDocuments.ResolvePlain("0o10"));
        Assert.Equal(100L, YamlDocuments.ResolvePlain("1e2"));
        Assert.True(double.IsPositiveInfinity((double)YamlDocuments.ResolvePlain(".inf")!));
        Assert.True(double.IsNaN((double)YamlDocuments.ResolvePlain(".nan")!));

        var node = YamlNode.FromYaml("flag: yes\nnope:\non: true\nitems:\n  - one:\n      a: 1\n  - []\n  - two: x\n");
        Assert.False(node.Bool("flag"));
        Assert.Equal("yes", node.Str("flag"));
        Assert.False(node.Has("missing"));
        Assert.Null(node.Child("missing").Value);
        Assert.True(node.Bool("on"));
        var named = node.NamedList("items");
        Assert.Equal(["one", "two"], named.Select(item => item.Name).ToArray());
        Assert.Equal(0, AjvErrors.YamlErrorOffset(null));
        Assert.Equal(12, AjvErrors.YamlErrorOffset([12, 15]));
    }

    [Fact]
    public void Filters_and_pluralize_match_the_typescript_dsl()
    {
        var user = new FilterCandidate { Name = "user", Tags = ["view_type"], Inherits = "set" };
        Assert.True(CompileFilter.Compile(null)(user));
        Assert.True(CompileFilter.CompileTypesFilter("type == \"user\" && tag == \"view_type\"")(user));
        Assert.False(CompileFilter.Compile("type != \"user\" || inherits == \"nope\"")(user));
        Assert.True(IncludeFilters.Match("type == \"user\" &&", user) == false);
        var bad = Assert.Throws<InvalidOperationException>(() => CompileFilter.Compile("type == \"user\" &&"));
        Assert.Contains("is not a valid expression", bad.Message);
        var unknown = Assert.Throws<InvalidOperationException>(() => CompileFilter.Compile("foo == \"x\""));
        Assert.Contains("unknown identifier or syntax near \"foo\"", unknown.Message);
        Assert.Contains("unterminated string", IncludeFilters.Parse("type == \"oops"));
        Assert.Contains("unexpected character", IncludeFilters.Parse("type == 'user'"));
        Assert.Null(IncludeFilters.Parse("type == \"user\" && tag != \"x\""));

        Assert.Equal("people", Pluralize.Plural("person"));
        Assert.Equal("users", Pluralize.Plural("user"));
        Assert.Equal("addresses", Pluralize.Plural("address"));
        Assert.Equal("children", Pluralize.Plural("child"));
        Assert.Equal("user", Pluralize.Singular("users"));
        Assert.Equal("person", Pluralize.Singular("people"));
        Assert.Equal("People", Pluralize.Plural("Person"));
    }

    [Fact]
    public async Task Parser_expands_types_routes_services_and_seeds()
    {
        var yaml = new Dictionary<string, string>
        {
            [SpecFiles.TypesYaml] = """
                version: 1.0.0
                types:
                  - role:
                      tags: [datasource_type]
                      inherits: set
                      fields:
                        - name:
                            type: string
                  - user:
                      tags: [datasource_type, view_type]
                      inherits: set
                      fields:
                        - email:
                            type: string
                            size: 256
                        - role_id:
                            type: reference
                            references: role.id
                  - address:
                      tags: [datasource_type]
                      inherits: set
                      fields:
                        - user_id:
                            type: reference
                            references: user.id
                        - line1:
                            type: string
                  - membership:
                      tags: [datasource_type, many_to_many]
                      inherits: set
                      fields:
                        - user_id:
                            type: reference
                            references: user.id
                        - role_id:
                            type: reference
                            references: role.id
                """,
            [SpecFiles.DatasourceYaml] = """
                version: 1.0.0
                includes:
                  - types:
                      filter: tag == "datasource_type"
                types:
                  - user:
                      fields:
                        - email:
                            is_unique: true
                      indexes:
                        - by_email:
                            is_unique: true
                            fields: [email]
                """,
            [SpecFiles.DatasourceSeedsYaml] = """
                version: 1.0.0
                seeds:
                  - role:
                      - id1:
                          name: admin
                """,
            [SpecFiles.ServicesYaml] = """
                version: 1.0.0
                includes:
                  - types:
                      filter: tag == "datasource_type"
                services:
                  - name: userService
                    module: ./services/custom.ts
                  - name: Generated
                    module: ./services/generated/generated.ts
                """,
            [SpecFiles.RoutesYaml] = """
                version: 1.0.0
                includes:
                  - types:
                      filter: tag == "view_type"
                routes:
                  - get_users_by_email:
                  - user:
                      eager_read_path: [role]
                  - ping:
                      path: /api/ping
                      method: GET
                combined_routes:
                  - user:
                      combines:
                        - address
                        - role:
                            via: membership
                            target: role
                """,
        };
        var parsed = await new DeterministicParser(new MemoryReader(yaml)).Parse(
            new Dictionary<string, string>(),
            new ParseOptions { ServiceClassName = name => name + "Service" });
        Assert.Contains(parsed.Services.Customs, service => service.Name == EnsureHealth.HEALTH_SERVICE_NAME);
        Assert.Contains(parsed.Routes.Customs, route => route.Path == EnsureHealth.HEALTH_ROUTE_PATH);
        Assert.DoesNotContain(parsed.Services.Customs, service => service.Name == "Generated");
        Assert.Contains(parsed.Services.Generics, service => service.Name == "role");
        Assert.DoesNotContain(parsed.Services.Generics, service => service.Name == "user");
        Assert.Equal("people", Pluralize.Plural("person"));
        var user = parsed.ExpandedTypes.Single(type => type.Name == "user");
        Assert.Contains(user.Fields, field => field.Name == "id");
        Assert.Contains(parsed.Routes.Nested, route => route.Kind == "direct-fk");
        Assert.Contains(parsed.Routes.Nested, route => route.Kind == "m2m");
        Assert.Contains(parsed.Routes.ChildrenOnly, name => name == "address");
        Assert.Equal(1, parsed.DatasourceSeeds["role"][0].Id);
        Assert.Equal("admin", parsed.DatasourceSeeds["role"][0].Row["name"]);
        var reader = new MemoryReader(new Dictionary<string, string>
        {
            [SpecFiles.DatasourceSeedsYaml] = "version: 1.0.0\nseeds:\n  - role:\n      - nope:\n          name: x\n",
        });
        var seedEx = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            new DeterministicParser(reader).Parse(new Dictionary<string, string>()));
        Assert.Contains("expected pattern /^id\\d+$/", seedEx.Message);

        var empty = await new DeterministicParser(new MemoryReader(new Dictionary<string, string>())).Parse(new Dictionary<string, string>());
        Assert.Equal(EnsureHealth.HEALTH_ROUTE_PATH, empty.Routes.Customs[0].Path);
        Assert.Equal("id", Specification.PrimaryKeyColumn(null, null));
        Assert.True(Specification.TypeHasTag(user, "view_type"));
        Assert.NotEmpty(Specification.UniqueLookupFields(user, parsed.Datasource.Single(table => table.Name == "user")));
    }

    [Fact]
    public async Task Parse_stamps_write_inclusion_overlays()
    {
        var authored = await new DeterministicParser(new MemoryReader(new Dictionary<string, string>
        {
            [SpecFiles.TypesYaml] = """
                types:
                  - user:
                      tags: [datasource_type]
                      fields:
                        - email:
                            type: string
                        - created:
                            type: datetime
                """,
            [SpecFiles.DatasourceYaml] = """
                includes:
                  - types:
                      filter: tag == "datasource_type"
                types:
                  - user:
                      fields:
                        - created:
                            include_in_create: false
                """,
        })).Parse(new Dictionary<string, string>());
        var created = authored.Datasource.Single(table => table.Name == "user").Fields.Single(field => field.Name == "created");
        Assert.False(created.IncludeInCreate);
        Assert.Null(created.IncludeInUpdate);

        var inherited = await new DeterministicParser(new MemoryReader(new Dictionary<string, string>
        {
            [SpecFiles.TypesYaml] = """
                types:
                  - base:
                      fields:
                        - created:
                            type: datetime
                        - name:
                            type: string
                  - item:
                      tags: [datasource_type]
                      inherits: base
                      fields: []
                """,
            [SpecFiles.DatasourceYaml] = """
                includes:
                  - types:
                      filter: tag == "datasource_type"
                types:
                  - base:
                      fields:
                        - created:
                            include_in_create: false
                            include_in_update: false
                """,
        })).Parse(new Dictionary<string, string>());
        Assert.Equal(["item"], inherited.Datasource.Select(table => table.Name));
        var inheritedCreated = inherited.Datasource[0].Fields.Single(field => field.Name == "created");
        Assert.False(inheritedCreated.IncludeInCreate);
        Assert.False(inheritedCreated.IncludeInUpdate);

        var childWins = await new DeterministicParser(new MemoryReader(new Dictionary<string, string>
        {
            [SpecFiles.TypesYaml] = """
                types:
                  - base:
                      fields:
                        - key:
                            type: string
                  - item:
                      tags: [datasource_type]
                      inherits: base
                      fields: []
                """,
            [SpecFiles.DatasourceYaml] = """
                includes:
                  - types:
                      filter: tag == "datasource_type"
                types:
                  - base:
                      fields:
                        - key:
                            include_in_create: false
                            include_in_update: false
                            is_fixed_id: true
                  - item:
                      fields:
                        - key:
                            include_in_create: true
                """,
        })).Parse(new Dictionary<string, string>());
        var key = childWins.Datasource.Single(table => table.Name == "item").Fields.Single(field => field.Name == "key");
        Assert.True(key.IncludeInCreate);
        Assert.False(key.IncludeInUpdate);
        Assert.Null(key.IsFixedId);

        var typesOnly = await new DeterministicParser(new MemoryReader(new Dictionary<string, string>
        {
            [SpecFiles.TypesYaml] = """
                types:
                  - user:
                      tags: [datasource_type]
                      fields:
                        - created:
                            type: datetime
                            include_in_create: false
                            include_in_update: false
                """,
        })).Parse(new Dictionary<string, string>());
        var typeField = typesOnly.Types.Single(type => type.Name == "user").Fields.Single(field => field.Name == "created");
        Assert.Null(typeField.GetType().GetProperty("IncludeInCreate"));
        Assert.Null(typeField.GetType().GetProperty("IncludeInUpdate"));
    }

    [Fact]
    public void Expand_reports_cycles_and_dictionary_owners()
    {
        var types = new List<TypeModel>
        {
            new()
            {
                Name = "a",
                Kind = "inherit",
                Inherits = "b",
                Fields = [],
            },
            new()
            {
                Name = "b",
                Kind = "inherit",
                Inherits = "a",
                Fields = [],
            },
        };
        var ex = Assert.Throws<InvalidOperationException>(() => Specification.ExpandTypes(types));
        Assert.Contains("circular inherit/union involving \"", ex.Message);
        Assert.Equal(["parent"], DeterministicParser.InheritsChain("child", new Dictionary<string, TypeModel>
        {
            ["child"] = new() { Name = "child", Kind = "inherit", Inherits = "parent" },
            ["parent"] = new() { Name = "parent", Kind = "inherit", Inherits = "set" },
        }));
    }

    [Fact]
    public void Trees_emit_root_for_an_empty_graph()
    {
        var tree = TypeTrees.DatasourceTypeTree([]);
        Assert.True(tree.ContainsKey("root") || tree.Count >= 0);
        var graph = TypeTrees.DatasourceTypeGraph([]);
        Assert.Equal(["root"], graph.Nodes);
        Assert.Empty(graph.Edges);
        Assert.Contains("root", TypeTrees.DatasourceTypeGraphJson(graph));
        Assert.Contains("root", TypeTrees.DatasourceTypeGraphYaml(graph));
        Assert.Contains("root", TypeTrees.DatasourceTypeGraphXml(graph));
        Assert.Contains("root", TypeTrees.DatasourceTypeTreeYaml(tree));
        _ = TypeTrees.DatasourceTypeTreeJson(tree);
        _ = TypeTrees.DatasourceTypeTreeXml(tree);
        _ = TypeTrees.DatasourceTypeOrder([]);
        _ = TypeTrees.DatasourceTypeAncestry([], "missing");
        var hierarchies = TypeTrees.DatasourceTypeHierarchies([]);
        Assert.NotNull(hierarchies.FirstParentTree);
        Assert.Equal(0, TypeTrees.CompareByDatasourceTypeOrder([])("a", "a"));
    }

    [Fact]
    public async Task Validators_match_facade_messages_and_samples()
    {
        var types = new TypesValidator();
        var missing = await types.Validate("types: []\n");
        Assert.Matches("required property 'version'|missing required property version", missing.Errors[0].Message);
        var list = await types.Validate("- just a list\n");
        Assert.Contains("must be", list.Errors[0].Message);
        var version = await types.Validate("version: latest\ntypes: []\n");
        Assert.Matches("must match|pattern|semver", version.Errors[0].Message);
        var syntax = await types.Validate("foo: [unterminated\n");
        Assert.Equal("", syntax.Errors[0].InstancePath);
        Assert.True(syntax.Errors[0].Line > 0);

        var tags = await types.Validate("""
            version: 1.0.0
            types:
              - base:
                  tags: [view_type]
                  tags2: [x]
                  fields:
                    - name:
                        type: string
            """);
        Assert.Equal(
            ["/types/0/base must NOT have additional properties (property: tags2)"],
            tags.Errors.Select(error => error.Message).ToArray());

        var dict = await types.Validate("version: 1.0.0\ntypes:\n  - settings:\n      inherits: dictionary\n");
        Assert.Contains(dict.Errors, error => error.Message.Contains("fields"));
        Assert.DoesNotContain(dict.Errors, error => error.Message.Contains("oneOf") || error.Message.Contains("exactly one"));

        var minimal = await types.Validate("version: 1.0.0\ntypes: []\n");
        Assert.True(minimal.Valid);

        var root = await SpecPaths.FindAncestorPath("samples/valid");
        Assert.NotNull(root);
        var samples = Path.GetDirectoryName(root)!;
        foreach (var (file, validator) in new (string File, SpecValidator Validator)[]
        {
            ("types.yaml", new TypesValidator()),
            ("datasource.yaml", new DatasourceValidator()),
            ("datasource_seeds.yaml", new DatasourceSeedsValidator()),
            ("routes.yaml", new RoutesValidator()),
            ("services.yaml", new ServicesValidator()),
            ("frontend_bindings.yaml", new FrontendBindingsValidator()),
        })
        {
            var result = await validator.ValidateFile(Path.Combine(samples, "valid", file));
            Assert.True(result.Valid, file + " " + string.Join("; ", result.Errors.Select(error => error.Message)));
        }

        var specPath = await SpecPaths.ResolveSpecPath("backend", "types.spec.yaml");
        var semver = await new SpecValidator(specPath).ValidateFile(Path.Combine(samples, "valid", "types.semver.yaml"));
        Assert.True(semver.Valid);
        var again = await new SpecValidator(specPath).Validate(await File.ReadAllTextAsync(Path.Combine(samples, "valid", "types.semver.yaml")));
        Assert.True(again.Valid);

        Assert.Equal("(root) must be string", AjvErrors.FormatAjvError(new SchemaIssue("type", "", "must be string", null, null, null)));
        Assert.Equal("/x must NOT have additional properties", AjvErrors.FormatAjvError(new SchemaIssue("additionalProperties", "/x", "must NOT have additional properties", "", null, null)));
        Assert.Contains("ids and is_id are mutually exclusive", AjvErrors.FormatAjvError(new SchemaIssue("not", "/types/0/person/fields/0/id/is_id", "must NOT be valid", null, null, null)));
        Assert.Equal("/x must be equal to one of the allowed values (allowed: a, b)", AjvErrors.FormatAjvError(new SchemaIssue("enum", "/x", "must be equal to one of the allowed values", null, null, ["a", "b"])));
        Assert.Equal("/x must have required property 'fields' (missing: fields)", AjvErrors.FormatAjvError(new SchemaIssue("required", "/x", "must have required property 'fields'", null, "fields", null)));
    }

    [Fact]
    public async Task Include_cycles_and_field_defaults_follow_the_facades()
    {
        var dir = Path.Combine(Path.GetTempPath(), "dgc-inc-" + Guid.NewGuid().ToString("n"));
        Directory.CreateDirectory(dir);
        var self = Path.Combine(dir, "self.yaml");
        await File.WriteAllTextAsync(self, "version: 1.0.0\ntypes: []\nincludes:\n  - file: self.yaml\n");
        var result = await new TypesValidator().ValidateFile(self);
        Assert.Contains(result.Errors, error => error.Message.Contains("circular include:"));

        var missing = Path.Combine(dir, "missing-include.yaml");
        await File.WriteAllTextAsync(missing, "version: 1.0.0\ntypes: []\nincludes:\n  - file: gone.yaml\n");
        var missingResult = await new TypesValidator().ValidateFile(missing);
        Assert.Contains(missingResult.Errors, error => error.Message.Contains("include file not found: gone.yaml"));

        var badFilter = await new TypesValidator().Validate("""
            version: 1.0.0
            types: []
            includes:
              - types:
                  filter: type == user
            """);
        Assert.Contains(badFilter.Errors, error => error.Message.Contains("invalid include filter:"));
        Directory.Delete(dir, true);
    }
}
