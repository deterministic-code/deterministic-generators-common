using Xunit;

namespace Deterministic.Generators.Common.Tests;

public class VersionSnapshotTests
{
    const string ContactsRoot = "/Users/ryan/Projects/cali-contacts-test/cali-contacts-tests2/deterministic";

    [Fact]
    public void Combine_adds_files_for_boolean_and_string_added()
    {
        var snapshot = VersionSnapshot.Combine(
        [
            Parse("""
                a.yaml:
                  added: true
                  content:
                    n: 1
                """),
            Map(("b.yaml", Map(
                ("added", Scalar("true")),
                ("content", Map(("n", Scalar(2L))))))),
            Map(("c.yaml", Map(
                ("added", Scalar("True")),
                ("content", Map(("n", Scalar(3L))))))),
        ]);
        Assert.Equal(Serialize(Parse("n: 1\n")), snapshot.Yaml("a.yaml"));
        Assert.Equal(Serialize(Parse("n: 2\n")), snapshot.Yaml("b.yaml"));
        Assert.Equal(Serialize(Parse("n: 3\n")), snapshot.Yaml("c.yaml"));
    }

    [Fact]
    public void Combine_removes_a_file()
    {
        var snapshot = VersionSnapshot.Combine(
        [
            Parse("""
                gone.yaml:
                  added: true
                  content: { n: 1 }
                keep.yaml:
                  added: true
                  content: { n: 2 }
                """),
            Parse("""
                gone.yaml:
                  removed: true
                """),
        ]);
        Assert.False(snapshot.Documents.ContainsKey("gone.yaml"));
        Assert.Equal(Serialize(Parse("n: 2\n")), snapshot.Yaml("keep.yaml"));
    }

    [Fact]
    public void Combine_merges_object_keys()
    {
        var snapshot = VersionSnapshot.Combine(
        [
            Parse("""
                doc.yaml:
                  added: true
                  content:
                    a: 1
                    gone: true
                    keep: old
                    stay: prev
                """),
            Parse("""
                doc.yaml:
                  b: 2
                  keep: new
                  stay: ~
                  nested: ~
                  removed:
                    - gone
                """),
        ]);
        Assert.Equal(Serialize(Parse("a: 1\nkeep: new\nstay: prev\nb: 2\nnested: ~\n")), snapshot.Yaml("doc.yaml"));
    }

    [Fact]
    public void Combine_stores_removed_true_on_an_object()
    {
        var snapshot = VersionSnapshot.Combine(
        [
            Parse("""
                doc.yaml:
                  added: true
                  content:
                    a: 1
                """),
            Parse("""
                doc.yaml:
                  removed: true
                  extra: 2
                """),
        ]);
        Assert.Equal(Serialize(Parse("a: 1\nremoved: true\nextra: 2\n")), snapshot.Yaml("doc.yaml"));
    }

    [Fact]
    public void Combine_applies_keyed_add_change_and_remove()
    {
        var snapshot = VersionSnapshot.Combine(
        [
            Parse("""
                doc.yaml:
                  added: true
                  content:
                    types:
                      - a:
                          n: 1
                      - b:
                          n: 2
                """),
            Parse("""
                doc.yaml:
                  types:
                    added:
                      - c:
                          n: 3
                    changed:
                      - a:
                          n: 9
                      - {}
                      - 1
                    removed:
                      - b
                      - 1
                      - ~
                      - { x: 1 }
                """),
        ]);
        Assert.Equal(Serialize(Parse("""
            types:
              - c:
                  n: 3
              - a:
                  n: 9
            """)), snapshot.Yaml("doc.yaml"));
    }

    [Fact]
    public void Combine_replaces_a_value_that_is_not_a_keyed_split()
    {
        var snapshot = VersionSnapshot.Combine(
        [
            Parse("""
                doc.yaml:
                  added: true
                  content:
                    types:
                      - a: 1
                """),
            Parse("""
                doc.yaml:
                  types: replaced
                """),
        ]);
        Assert.Equal(Serialize(Parse("types: replaced\n")), snapshot.Yaml("doc.yaml"));
    }

    [Fact]
    public void Combine_keeps_the_previous_file_for_a_null_envelope()
    {
        var snapshot = VersionSnapshot.Combine(
        [
            Parse("""
                doc.yaml:
                  added: true
                  content:
                    n: 1
                """),
            Parse("""
                doc.yaml: ~
                """),
            null,
        ]);
        Assert.Equal(Serialize(Parse("n: 1\n")), snapshot.Yaml("doc.yaml"));
    }

    [Fact]
    public void Combine_throws_when_a_diff_is_not_a_mapping()
    {
        var ex = Assert.Throws<InvalidOperationException>(() =>
            VersionSnapshot.Combine([Parse("- a\n")]));
        Assert.Equal("expected a mapping", ex.Message);
        Assert.Throws<InvalidOperationException>(() => VersionSnapshot.Combine([Scalar(1L)]));
    }

    [Fact]
    public void Combine_replaces_when_added_is_not_true()
    {
        var snapshot = VersionSnapshot.Combine(
        [
            Parse("""
                doc.yaml:
                  added: true
                  content:
                    n: 1
                """),
            Parse("""
                doc.yaml:
                  added: false
                  n: 2
                """),
        ]);
        Assert.Equal(Serialize(Parse("n: 2\nadded: false\n")), snapshot.Yaml("doc.yaml"));
    }

    [Fact]
    public void Combine_applies_a_scalar_envelope_and_drops_added_null_content()
    {
        var snapshot = VersionSnapshot.Combine(
        [
            Parse("""
                a.yaml:
                  added: true
                  content:
                    n: 1
                b.yaml:
                  added: true
                  content:
                    n: 2
                """),
            Map(("a.yaml", Scalar(4L))),
            Parse("""
                b.yaml:
                  added: true
                  content: ~
                """),
        ]);
        Assert.Equal(Serialize(Scalar(4L)), snapshot.Yaml("a.yaml"));
        Assert.False(snapshot.Documents.ContainsKey("b.yaml"));
    }

    [Fact]
    public void Combine_replaces_an_empty_list_instead_of_treating_it_as_keyed()
    {
        var snapshot = VersionSnapshot.Combine(
        [
            Parse("""
                doc.yaml:
                  added: true
                  content:
                    types: []
                """),
            Parse("""
                doc.yaml:
                  types:
                    added:
                      - a: 1
                """),
        ]);
        Assert.Equal(Serialize(Parse("""
            types:
              added:
                - a: 1
            """)), snapshot.Yaml("doc.yaml"));
    }

    [Fact]
    public void Combine_replaces_a_keyed_list_when_the_delta_has_extra_keys()
    {
        var snapshot = VersionSnapshot.Combine(
        [
            Parse("""
                doc.yaml:
                  added: true
                  content:
                    types:
                      - a: 1
                """),
            Parse("""
                doc.yaml:
                  types:
                    added:
                      - b: 2
                    extra: 1
                """),
        ]);
        Assert.Equal(Serialize(Parse("""
            types:
              added:
                - b: 2
              extra: 1
            """)), snapshot.Yaml("doc.yaml"));
    }

    [Fact]
    public void Combine_does_not_treat_a_two_key_list_as_keyed()
    {
        var snapshot = VersionSnapshot.Combine(
        [
            Parse("""
                doc.yaml:
                  added: true
                  content:
                    types:
                      - a: 1
                        b: 2
                """),
            Parse("""
                doc.yaml:
                  types:
                    added:
                      - c: 3
                """),
        ]);
        Assert.Equal(Serialize(Parse("""
            types:
              added:
                - c: 3
            """)), snapshot.Yaml("doc.yaml"));
    }

    [Fact]
    public void Yaml_throws_for_a_missing_path()
    {
        var snapshot = VersionSnapshot.Combine([]);
        var ex = Assert.Throws<InvalidOperationException>(() => snapshot.Yaml("types.yaml"));
        Assert.Equal("missing types.yaml", ex.Message);
    }

    [Fact]
    public void Read_empty_directory_and_ignores_non_version_files()
    {
        var dir = TempDir();
        try
        {
            Directory.CreateDirectory(Path.Combine(dir, "not-a-version"));
            File.WriteAllText(Path.Combine(dir, "not-a-version", "diff.yaml"), "types.yaml: { added: true, content: 1 }\n");
            Directory.CreateDirectory(Path.Combine(dir, "version-20261022T083957Z-001"));
            File.WriteAllText(Path.Combine(dir, "version-20261022T083957Z-001", "diff.yaml"), "");
            Directory.CreateDirectory(Path.Combine(dir, "version-20261024T050249Z-002"));
            var empty = VersionSnapshot.Read(dir);
            Assert.Empty(empty.Documents);

            var only = Path.Combine(Path.GetTempPath(), "dgc-empty-" + Guid.NewGuid().ToString("n"));
            Directory.CreateDirectory(only);
            try
            {
                Assert.Empty(VersionSnapshot.Read(only).Documents);
            }
            finally
            {
                Directory.Delete(only, true);
            }
        }
        finally
        {
            Directory.Delete(dir, true);
        }
    }

    [Fact]
    public void Read_throws_for_a_non_mapping_or_invalid_diff()
    {
        var dir = TempDir();
        try
        {
            var version = Path.Combine(dir, "version-20261022T083957Z-001");
            Directory.CreateDirectory(version);
            File.WriteAllText(Path.Combine(version, "diff.yaml"), "- not a map\n");
            var mapping = Assert.Throws<InvalidOperationException>(() => VersionSnapshot.Read(dir));
            Assert.Equal("version-20261022T083957Z-001/diff.yaml: expected a mapping", mapping.Message);

            File.WriteAllText(Path.Combine(version, "diff.yaml"), ":\n  [");
            var parse = Assert.Throws<InvalidOperationException>(() => VersionSnapshot.Read(dir));
            Assert.Contains("version-20261022T083957Z-001/diff.yaml", parse.Message);
        }
        finally
        {
            Directory.Delete(dir, true);
        }
    }

    [Fact]
    public void Read_replays_the_contacts_diffs_onto_live_types_and_datasource()
    {
        var snapshot = VersionSnapshot.Read(ContactsRoot);
        Assert.Equal(LiveYaml(SpecFiles.TypesYaml), snapshot.Yaml(SpecFiles.TypesYaml));
        Assert.Equal(LiveYaml(SpecFiles.DatasourceYaml), snapshot.Yaml(SpecFiles.DatasourceYaml));
    }

    static string LiveYaml(string name)
    {
        var live = Parse(File.ReadAllText(Path.Combine(ContactsRoot, name)));
        var wrapper = new YamlMap
        {
            Entries =
            {
                new YamlEntry
                {
                    Key = name,
                    Value = new YamlMap
                    {
                        Entries =
                        {
                            new YamlEntry { Key = "added", Value = new YamlScalar { Value = true } },
                            new YamlEntry { Key = "content", Value = live },
                        },
                    },
                },
            },
        };
        return VersionSnapshot.Combine([wrapper]).Yaml(name);
    }

    static YamlValue Parse(string yaml)
    {
        var (root, errors) = YamlDocuments.Parse(yaml);
        Assert.Empty(errors);
        return root!;
    }

    static string Serialize(YamlValue value) => VersionSnapshot.Combine(
    [
        new YamlMap
        {
            Entries =
            {
                new YamlEntry
                {
                    Key = "x.yaml",
                    Value = new YamlMap
                    {
                        Entries =
                        {
                            new YamlEntry { Key = "added", Value = new YamlScalar { Value = true } },
                            new YamlEntry { Key = "content", Value = value },
                        },
                    },
                },
            },
        },
    ]).Yaml("x.yaml");

    static YamlScalar Scalar(object? value) => new() { Value = value };

    static YamlMap Map(params (string Key, YamlValue Value)[] entries)
    {
        var map = new YamlMap();
        foreach (var (key, value) in entries)
            map.Entries.Add(new YamlEntry { Key = key, Value = value });
        return map;
    }

    static string TempDir()
    {
        var dir = Path.Combine(Path.GetTempPath(), "dgc-vs-" + Guid.NewGuid().ToString("n"));
        Directory.CreateDirectory(dir);
        return dir;
    }
}
