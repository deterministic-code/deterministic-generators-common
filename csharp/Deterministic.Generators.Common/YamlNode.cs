using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using YamlDotNet.Core;
using YamlDotNet.Core.Events;

namespace Deterministic.Generators.Common;

public abstract class YamlValue
{
    public int Line { get; init; } = 1;
    public int Col { get; init; } = 1;
    public abstract JsonNode? ToJson();
}

public sealed class YamlScalar : YamlValue
{
    public object? Value { get; init; }
    public bool IsMissing { get; init; }

    public override JsonNode? ToJson()
    {
        if (IsMissing || Value is null) return ParseNull();
        return Value switch
        {
            bool b => JsonValue.Create(b),
            long n => JsonValue.Create(n),
            ulong u => JsonValue.Create(u),
            double d when double.IsFinite(d) && d == Math.Truncate(d) && d >= long.MinValue && d <= long.MaxValue
                => JsonValue.Create((long)d),
            double d when double.IsFinite(d) => JsonValue.Create(d),
            double => ParseNull(),
            string s => JsonValue.Create(s),
            _ => JsonValue.Create(Convert.ToString(Value, CultureInfo.InvariantCulture)),
        };
    }

    private static JsonNode ParseNull() => JsonNode.Parse("null")!;
}

public sealed class YamlMap : YamlValue
{
    public List<YamlEntry> Entries { get; } = [];

    public override JsonNode? ToJson()
    {
        var obj = new JsonObject();
        foreach (var entry in Entries)
        {
            obj[entry.Key] = entry.Value.ToJson();
        }
        return obj;
    }
}

public sealed class YamlSeq : YamlValue
{
    public List<YamlValue> Items { get; } = [];

    public override JsonNode? ToJson()
    {
        var arr = new JsonArray();
        foreach (var item in Items) arr.Add(item.ToJson());
        return arr;
    }
}

public sealed class YamlEntry
{
    public required string Key { get; init; }
    public required YamlValue Value { get; init; }
    public int KeyLine { get; init; }
    public int KeyCol { get; init; }
}

public sealed class YamlParseError
{
    public required int Line { get; init; }
    public required int Col { get; init; }
    public required string Message { get; init; }
}

public static class YamlDocuments
{
    public static (YamlValue? Root, IReadOnlyList<YamlParseError> Errors) Parse(string text)
    {
        if (text.Length == 0)
            return (null, []);
        try
        {
            using var reader = new StringReader(text);
            var parser = new Parser(reader);
            parser.Consume<StreamStart>();
            if (parser.Accept<StreamEnd>(out _))
                return (null, []);
            parser.Consume<DocumentStart>();
            var anchors = new Dictionary<string, YamlValue>(StringComparer.Ordinal);
            var root = ReadNode(parser, anchors);
            return (root, []);
        }
        catch (YamlException ex)
        {
            var line = (int)Math.Max(1, ex.Start.Line);
            var col = (int)Math.Max(1, ex.Start.Column);
            return (null, [new YamlParseError { Line = line, Col = col, Message = ex.Message }]);
        }
    }

    internal static YamlValue ReadNode(IParser parser, Dictionary<string, YamlValue> anchors)
    {
        if (parser.Accept<Scalar>(out var scalar))
        {
            parser.MoveNext();
            var node = MakeScalar(scalar);
            Remember(scalar.Anchor, node, anchors);
            return node;
        }
        if (parser.Accept<MappingStart>(out var mapStart))
        {
            parser.MoveNext();
            var map = new YamlMap { Line = LineOf(mapStart.Start), Col = ColOf(mapStart.Start) };
            Remember(mapStart.Anchor, map, anchors);
            while (!parser.Accept<MappingEnd>(out _))
            {
                var keyNode = ReadNode(parser, anchors);
                var value = ReadNode(parser, anchors);
                map.Entries.Add(new YamlEntry
                {
                    Key = KeyString(keyNode),
                    Value = value,
                    KeyLine = keyNode.Line,
                    KeyCol = keyNode.Col,
                });
            }
            parser.Consume<MappingEnd>();
            return map;
        }
        if (parser.Accept<SequenceStart>(out var seqStart))
        {
            parser.MoveNext();
            var seq = new YamlSeq { Line = LineOf(seqStart.Start), Col = ColOf(seqStart.Start) };
            Remember(seqStart.Anchor, seq, anchors);
            while (!parser.Accept<SequenceEnd>(out _))
                seq.Items.Add(ReadNode(parser, anchors));
            parser.Consume<SequenceEnd>();
            return seq;
        }
        if (parser.Accept<AnchorAlias>(out var alias))
        {
            parser.MoveNext();
            var aliasName = alias.Value.ToString();
            if (anchors.TryGetValue(aliasName, out var target)) return target;
            throw new YamlException(alias.Start, alias.End, $"unknown anchor '{aliasName}'");
        }
        var current = parser.Current!;
        throw new YamlException(current.Start, current.Start, "unexpected YAML event");
    }

    private static void Remember(AnchorName anchor, YamlValue node, Dictionary<string, YamlValue> anchors)
    {
        var name = anchor.ToString();
        if (!string.IsNullOrEmpty(name)) anchors[name] = node;
    }

    private static int LineOf(Mark mark) => (int)Math.Max(1, mark.Line);
    private static int ColOf(Mark mark) => (int)Math.Max(1, mark.Column);

    private static YamlScalar MakeScalar(Scalar scalar)
    {
        var line = LineOf(scalar.Start);
        var col = ColOf(scalar.Start);
        var forced = scalar.Style is ScalarStyle.SingleQuoted or ScalarStyle.DoubleQuoted
            or ScalarStyle.Literal or ScalarStyle.Folded;
        var value = forced ? scalar.Value : ResolvePlain(scalar.Value);
        return new YamlScalar { Line = line, Col = col, Value = value };
    }

    private static readonly Regex IntDecimal = new(@"^[-+]?[0-9]+$", RegexOptions.CultureInvariant);
    private static readonly Regex IntHex = new(@"^[-+]?0x[0-9a-fA-F]+$", RegexOptions.CultureInvariant);
    private static readonly Regex IntOct = new(@"^[-+]?0o[0-7]+$", RegexOptions.CultureInvariant);
    private static readonly Regex FloatNum = new(@"^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$", RegexOptions.CultureInvariant);
    private static readonly Regex FloatInf = new(@"^[-+]?\.(?:inf|Inf|INF)$", RegexOptions.CultureInvariant);
    private static readonly Regex FloatNan = new(@"^\.(?:nan|NaN|NAN)$", RegexOptions.CultureInvariant);

    internal static object? ResolvePlain(string text)
    {
        if (text.Length == 0 || text is "null" or "Null" or "NULL" or "~") return null;
        if (text is "true" or "True" or "TRUE") return true;
        if (text is "false" or "False" or "FALSE") return false;
        if (IntHex.IsMatch(text)) return ParseHex(text);
        if (IntOct.IsMatch(text)) return ParseOct(text);
        if (IntDecimal.IsMatch(text)) return ParseDecimal(text);
        if (FloatInf.IsMatch(text))
            return text.StartsWith('-') ? double.NegativeInfinity : double.PositiveInfinity;
        if (FloatNan.IsMatch(text)) return double.NaN;
        if (FloatNum.IsMatch(text) && double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var dbl))
        {
            if (double.IsFinite(dbl) && dbl == Math.Truncate(dbl) && dbl >= long.MinValue && dbl <= long.MaxValue)
                return (long)dbl;
            return dbl;
        }
        return text;
    }

    private static object ParseDecimal(string text)
    {
        if (long.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var n))
            return n;
        return double.Parse(text, CultureInfo.InvariantCulture);
    }

    private static object ParseHex(string text)
    {
        var neg = text.StartsWith('-');
        var body = text.TrimStart('+', '-');
        var digits = body[2..];
        if (ulong.TryParse(digits, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var u))
        {
            if (!neg && u <= long.MaxValue) return (long)u;
            if (neg && u <= (ulong)long.MaxValue + 1) return u == (ulong)long.MaxValue + 1 ? long.MinValue : -(long)u;
            return neg ? -((double)u) : (double)u;
        }
        return text;
    }

    private static object ParseOct(string text)
    {
        var neg = text.StartsWith('-');
        var body = text.TrimStart('+', '-');
        var digits = body[2..];
        ulong value = 0;
        foreach (var ch in digits) value = (value << 3) + (ulong)(ch - '0');
        if (!neg && value <= long.MaxValue) return (long)value;
        if (neg && value <= (ulong)long.MaxValue + 1)
            return value == (ulong)long.MaxValue + 1 ? long.MinValue : -(long)value;
        return neg ? -((double)value) : (double)value;
    }

    private static string KeyString(YamlValue key)
    {
        if (key is not YamlScalar scalar) return "[object Object]";
        return scalar.Value switch
        {
            null => "null",
            bool b => b ? "true" : "false",
            string s => s,
            _ => Convert.ToString(scalar.Value, CultureInfo.InvariantCulture)!,
        };
    }
}

public readonly record struct YamlPick(bool Present, object? Value);

/// <summary>Typed cursor over a YAML value. Missing keys are empty nodes.</summary>
public sealed class YamlNode
{
    private readonly YamlValue? _value;

    private YamlNode(YamlValue? value, string path)
    {
        _value = value;
        Path = path;
    }

    public string Path { get; }
    public object? Value
    {
        get
        {
            if (_value is null) return null;
            if (_value is YamlScalar s) return s.IsMissing ? null : s.Value;
            return Plain(_value);
        }
    }

    internal static YamlNode FromValue(YamlValue? value, string path = "$") => new(value, path);

    public bool IsMap => _value is YamlMap;
    public IReadOnlyDictionary<string, object?>? Record =>
        _value is YamlMap map ? ToDictionary(map) : null;

    public static YamlNode FromYaml(string text, string path = "$")
    {
        var (root, errors) = YamlDocuments.Parse(text);
        if (errors.Count > 0)
            throw new InvalidOperationException(errors[0].Message);
        return new YamlNode(root, path);
    }

    public YamlNode Child(string key)
    {
        var found = Lookup(key);
        return new YamlNode(found, $"{Path}.{key}");
    }

    public bool Has(string key) => _value is YamlMap map && map.Entries.Any(e => e.Key == key);

    public string? Str(string key) => Lookup(key) is YamlScalar { Value: string s } ? s : null;

    public bool Bool(string key) => Lookup(key) is YamlScalar { Value: true };

    public double? FiniteNumber(string key)
    {
        if (Lookup(key) is not YamlScalar scalar) return null;
        return scalar.Value switch
        {
            long n => n,
            ulong u when u <= (ulong)long.MaxValue => u,
            double d when double.IsFinite(d) => d,
            _ => null,
        };
    }

    public long? FiniteInt(string key)
    {
        var number = FiniteNumber(key);
        if (number is null) return null;
        var d = number.Value;
        if (d != Math.Truncate(d) || d < long.MinValue || d > long.MaxValue) return null;
        return (long)d;
    }

    public YamlPick Literal(string key)
    {
        var found = Lookup(key);
        return found switch
        {
            YamlScalar scalar when scalar.Value is null or string or bool or long or ulong or double
                => new YamlPick(true, BoxNumber(scalar.Value)),
            YamlSeq { Items.Count: 0 } => new YamlPick(true, new List<object?>()),
            YamlMap { Entries.Count: 0 } => new YamlPick(true, new Dictionary<string, object?>(StringComparer.Ordinal)),
            _ => default,
        };
    }

    public IReadOnlyList<string> Strings(string key)
    {
        if (Lookup(key) is not YamlSeq seq) return [];
        return seq.Items.Select(item => item is YamlScalar { Value: string s } ? s : null)
            .Where(s => s is not null)
            .Cast<string>()
            .ToList();
    }

    public IReadOnlyList<YamlNode> Items()
    {
        if (_value is not YamlSeq seq) return [];
        return seq.Items.Select((item, i) => new YamlNode(item, $"{Path}[{i}]")).ToList();
    }

    public IReadOnlyList<YamlNamed> NamedItems()
    {
        var named = new List<YamlNamed>();
        foreach (var item in Items())
        {
            if (item._value is not YamlMap map || map.Entries.Count == 0) continue;
            var entry = map.Entries[0];
            named.Add(new YamlNamed(entry.Key, new YamlNode(entry.Value, $"{item.Path}.{entry.Key}")));
        }
        return named;
    }

    public IReadOnlyList<YamlNamed> NamedList(string key) => Child(key).NamedItems();

    private YamlValue? Lookup(string key)
    {
        if (_value is not YamlMap map) return null;
        foreach (var entry in map.Entries)
        {
            if (entry.Key == key) return entry.Value;
        }
        return null;
    }

    private static object? BoxNumber(object? value) => value switch
    {
        ulong u when u <= long.MaxValue => (long)u,
        ulong u => (double)u,
        _ => value,
    };

    private static object? Plain(YamlValue value) => value switch
    {
        YamlScalar s => s.Value,
        YamlMap map => ToDictionary(map),
        YamlSeq seq => seq.Items.Select(Plain).ToList(),
        _ => null,
    };

    private static Dictionary<string, object?> ToDictionary(YamlMap map)
    {
        var dict = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var entry in map.Entries)
            dict[entry.Key] = Plain(entry.Value);
        return dict;
    }
}

public readonly record struct YamlNamed(string Name, YamlNode Node);
