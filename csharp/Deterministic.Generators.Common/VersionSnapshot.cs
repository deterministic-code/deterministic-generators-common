using System.Text.RegularExpressions;
using YamlDotNet.Serialization;

namespace Deterministic.Generators.Common;

public sealed class VersionSnapshot
{
    static readonly Regex VersionDir = new(@"^version-\d{8}T\d{6}Z-\d{3}$", RegexOptions.Compiled);
    static readonly ISerializer Serializer = new SerializerBuilder().Build();

    public IReadOnlyDictionary<string, YamlValue?> Documents { get; }

    VersionSnapshot(IEnumerable<YamlValue?> diffsInOrder)
    {
        var docs = new Dictionary<string, YamlValue?>(StringComparer.Ordinal);
        foreach (var diff in diffsInOrder.Where(diff => diff is not null))
        {
            if (diff is not YamlMap map) throw new InvalidOperationException("expected a mapping");
            foreach (var entry in map.Entries)
            {
                var next = ApplyFile(docs.GetValueOrDefault(entry.Key), entry.Value);
                if (IsNull(next)) docs.Remove(entry.Key);
                else docs[entry.Key] = next;
            }
        }
        Documents = docs;
    }

    public static VersionSnapshot Combine(IEnumerable<YamlValue?> diffsInOrder) => new(diffsInOrder);

    public static VersionSnapshot Read(string deterministicRoot)
    {
        var snapshot = new VersionSnapshot([]);
        return Combine(Directory.GetDirectories(deterministicRoot)
            .Select(dir => Path.GetFileName(dir)!)
            .Where(name => VersionDir.IsMatch(name))
            .OrderBy(name => name, StringComparer.Ordinal)
            .Select(name => snapshot.DiffOf(Path.Combine(deterministicRoot, name, "diff.yaml"), $"{name}/diff.yaml")));
    }

    public string Yaml(string path) =>
        Documents.TryGetValue(path, out var value)
            ? Serializer.Serialize(YamlData.Plain(value))
            : throw new InvalidOperationException($"missing {path}");

    YamlValue? DiffOf(string path, string source)
    {
        if (!File.Exists(path)) return null;
        var text = File.ReadAllText(path);
        if (text == "") return null;
        var (root, errors) = YamlDocuments.Parse(text);
        if (errors.Count > 0) throw new InvalidOperationException($"{source}: {errors[0].Message}");
        return root is YamlMap ? root : throw new InvalidOperationException($"{source}: expected a mapping");
    }

    YamlValue? ApplyFile(YamlValue? before, YamlValue? envelope) => envelope switch
    {
        _ when IsNull(envelope) => before,
        YamlMap map when IsTrue(map, "removed") && map.Entries.Count == 1 => null,
        YamlMap map when IsTrue(map, "added") => Lookup(map, "content"),
        _ => Apply(before, envelope),
    };

    YamlValue? Apply(YamlValue? before, YamlValue? next) => next switch
    {
        _ when IsNull(next) => before,
        YamlMap split when before is YamlSeq seq && IsKeyed(seq) && IsSplit(split) => ApplyKeyed(seq, split),
        YamlMap nextMap when before is YamlMap beforeMap => ApplyObject(beforeMap, nextMap),
        _ => next,
    };

    YamlSeq ApplyKeyed(YamlSeq beforeVal, YamlMap split)
    {
        var removed = Strings(split, "removed").ToHashSet(StringComparer.Ordinal);
        var changed = Seq(Lookup(split, "changed"))
            .Select(FirstPair)
            .Where(pair => pair.Key is not null)
            .ToDictionary(pair => pair.Key!, pair => pair.Value, StringComparer.Ordinal);
        return SeqOf(Seq(Lookup(split, "added")).Concat(
            beforeVal.Items.Select(entry =>
            {
                var (key, value) = FirstPair(entry);
                if (removed.Contains(key!)) return null;
                return changed.TryGetValue(key!, out var nested) ? Single(key!, Apply(value, nested)!) : entry;
            }).OfType<YamlValue>()));
    }

    YamlMap ApplyObject(YamlMap beforeVal, YamlMap next)
    {
        var removed = Strings(next, "removed").ToHashSet(StringComparer.Ordinal);
        var beforeKeys = beforeVal.Entries.Select(entry => entry.Key).ToHashSet(StringComparer.Ordinal);
        return MapOf(beforeVal.Entries
            .Where(entry => !removed.Contains(entry.Key))
            .Select(entry => new YamlEntry
            {
                Key = entry.Key,
                Value = Has(next, entry.Key) ? Apply(entry.Value, Lookup(next, entry.Key))! : entry.Value,
            })
            .Concat(next.Entries.Where(entry =>
                !(entry.Key == "removed" && entry.Value is YamlSeq) && !beforeKeys.Contains(entry.Key))));
    }

    bool IsSplit(YamlMap map) =>
        map.Entries.All(entry => entry.Key is "added" or "changed" or "removed");

    bool IsKeyed(YamlSeq seq) =>
        seq.Items is { Count: > 0 } && seq.Items.All(item => item is YamlMap { Entries.Count: 1 });

    IEnumerable<YamlValue> Seq(YamlValue? value) => value is YamlSeq seq ? seq.Items : [];

    IEnumerable<string> Strings(YamlMap map, string key) =>
        Seq(Lookup(map, key)).Select(item => item is YamlScalar scalar ? Convert.ToString(scalar.Value) ?? "" : "");

    (string? Key, YamlValue? Value) FirstPair(YamlValue? entry) =>
        entry is YamlMap { Entries.Count: > 0 } map ? (map.Entries[0].Key, map.Entries[0].Value) : default;

    YamlMap Single(string key, YamlValue value) =>
        MapOf([new YamlEntry { Key = key, Value = value }]);

    YamlSeq SeqOf(IEnumerable<YamlValue> items)
    {
        var seq = new YamlSeq();
        seq.Items.AddRange(items);
        return seq;
    }

    YamlMap MapOf(IEnumerable<YamlEntry> entries)
    {
        var map = new YamlMap();
        map.Entries.AddRange(entries);
        return map;
    }

    YamlValue? Lookup(YamlMap map, string key) =>
        map.Entries.FirstOrDefault(entry => entry.Key == key)?.Value;

    bool Has(YamlMap map, string key) => map.Entries.Any(entry => entry.Key == key);

    bool IsTrue(YamlMap map, string key) =>
        Lookup(map, key) is YamlScalar scalar && scalar.Value is true or "true" or "True";

    bool IsNull(YamlValue? value) => value is null || value is YamlScalar { Value: null };
}
