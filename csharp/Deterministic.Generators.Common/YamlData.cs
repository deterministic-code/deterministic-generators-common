namespace Deterministic.Generators.Common;

static class YamlData
{
    public static Dictionary<string, object?>? AsRecord(object? value) =>
        value as Dictionary<string, object?>;

    public static List<object?>? AsList(object? value) => value as List<object?>;

    public static bool IsList(object? value) => value is List<object?>;

    public static (string Key, object? Body)? SingleKey(object? value)
    {
        if (value is List<object?> list)
        {
            if (list.Count == 0) return null;
            return ("0", list[0]);
        }
        var rec = AsRecord(value);
        if (rec is null || rec.Count == 0) return null;
        var pair = rec.First();
        return (pair.Key, pair.Value);
    }

    public static bool Has(Dictionary<string, object?> rec, string key) => rec.ContainsKey(key);

    public static bool IsString(object? value) => value is string;

    public static bool IsBool(object? value, bool expected) => value is bool b && b == expected;

    public static bool IsNumber(object? value) => value is long or int or double or ulong or float or decimal;

    public static bool TryFinite(object? value, out double number)
    {
        switch (value)
        {
            case long n:
                number = n;
                return true;
            case int n:
                number = n;
                return true;
            case ulong n when n <= long.MaxValue:
                number = n;
                return true;
            case double d when double.IsFinite(d):
                number = d;
                return true;
            case float f when float.IsFinite(f):
                number = f;
                return true;
            default:
                number = 0;
                return false;
        }
    }

    public static bool IsInteger(object? value)
    {
        if (!TryFinite(value, out var n)) return false;
        return n == Math.Truncate(n);
    }

    public static List<string>? StringList(object? value)
    {
        if (value is not List<object?> list) return null;
        return list.OfType<string>().ToList();
    }

    public static object? Plain(YamlValue? value) => value switch
    {
        null => null,
        YamlScalar s => s.IsMissing ? null : s.Value,
        YamlMap map => MapPlain(map),
        YamlSeq seq => seq.Items.Select(Plain).ToList(),
        _ => null,
    };

    static Dictionary<string, object?> MapPlain(YamlMap map)
    {
        var dict = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var entry in map.Entries)
            dict[entry.Key] = Plain(entry.Value);
        return dict;
    }

    public static (int Line, int Col) PositionFor(YamlValue? root, string instancePath)
    {
        if (root is null) return (1, 1);
        var node = NodeAt(root, Pointer(instancePath))!;
        return (Math.Max(1, node.Line), Math.Max(1, node.Col));
    }

    public static string[] Pointer(string pointer)
    {
        if (string.IsNullOrEmpty(pointer)) return [];
        return pointer.Split('/').Skip(1)
            .Select(seg => seg.Replace("~1", "/", StringComparison.Ordinal).Replace("~0", "~", StringComparison.Ordinal))
            .ToArray();
    }

    static YamlValue? NodeAt(YamlValue node, IReadOnlyList<string> segments)
    {
        YamlValue current = node;
        foreach (var seg in segments)
        {
            if (current is YamlMap map)
            {
                YamlValue? found = null;
                foreach (var entry in map.Entries)
                {
                    if (entry.Key == seg)
                    {
                        found = entry.Value;
                        break;
                    }
                }
                if (found is null) return current;
                current = found;
                continue;
            }
            if (current is YamlSeq seq)
            {
                if (!int.TryParse(seg, out var idx) || idx < 0 || idx >= seq.Items.Count)
                    return current;
                current = seq.Items[idx];
                continue;
            }
            return current;
        }
        return current;
    }

    public static SpecValidationError Err(ParsedYaml parsed, string instancePath, string message)
    {
        var (line, col) = PositionFor(parsed.Root, instancePath);
        return new SpecValidationError
        {
            Line = line,
            Col = col,
            InstancePath = instancePath,
            Message = message,
        };
    }

    public static bool PushUnique(
        HashSet<string> seen,
        string name,
        List<SpecValidationError> errors,
        ParsedYaml parsed,
        string instancePath,
        string message)
    {
        if (!seen.Add(name))
        {
            errors.Add(Err(parsed, instancePath, message));
            return false;
        }
        return true;
    }
}
