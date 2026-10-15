using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Json.Schema;

namespace Deterministic.Generators.Common;

static class SchemaEngine
{
    static readonly Dictionary<string, JsonSchema> Cache = new(StringComparer.Ordinal);
    static readonly object Gate = new();
    static readonly System.Runtime.CompilerServices.ConditionalWeakTable<JsonSchema, JsonNode> SchemaNodes = new();

    public static async Task<JsonSchema> Load(string path)
    {
        lock (Gate)
        {
            if (Cache.TryGetValue(path, out var hit)) return hit;
        }
        var text = await File.ReadAllTextAsync(path);
        var parsed = YamlDocuments.Parse(text);
        var node = parsed.Root?.ToJson() ?? JsonNode.Parse("null");
        if (node is JsonObject obj)
        {
            obj.Remove("$schema");
            obj.Remove("$id");
        }
        var schema = JsonSchema.FromText(node!.ToJsonString());
        lock (Gate)
        {
            if (Cache.TryGetValue(path, out var hit)) return hit;
            SchemaNodes.Add(schema, node!);
            Cache[path] = schema;
            return schema;
        }
    }

    public static IReadOnlyList<SchemaIssue> Evaluate(JsonSchema schema, JsonNode? instance)
    {
        var result = schema.Evaluate(instance, new EvaluationOptions { OutputFormat = OutputFormat.List });
        if (result.IsValid) return [];
        SchemaNodes.TryGetValue(schema, out var schemaNode);
        var flat = new List<EvaluationResults>();
        Flatten(result, flat);
        var valid = flat.Where(item => item.IsValid).Select(item => item.EvaluationPath.ToString() ?? "").ToHashSet(StringComparer.Ordinal);
        var issues = new List<SchemaIssue>();
        Collect(result, schemaNode, instance, valid, issues);
        return Dedupe(issues);
    }

    static void Flatten(EvaluationResults result, List<EvaluationResults> all)
    {
        all.Add(result);
        if (result.Details is null) return;
        foreach (var detail in result.Details) Flatten(detail, all);
    }

    internal static bool LosingBranch(string eval, HashSet<string> valid)
    {
        foreach (var kind in new[] { "/oneOf/", "/anyOf/" })
        {
            var index = 0;
            while ((index = eval.IndexOf(kind, index, StringComparison.Ordinal)) >= 0)
            {
                var start = index + kind.Length;
                var end = start;
                while (end < eval.Length && char.IsDigit(eval[end])) end++;
                if (end == start)
                {
                    index += kind.Length;
                    continue;
                }
                var mine = eval[start..end];
                var prefix = eval[..start];
                for (var n = 0; n < 12; n++)
                {
                    var other = n.ToString(System.Globalization.CultureInfo.InvariantCulture);
                    if (other == mine) continue;
                    var branch = prefix + other;
                    if (valid.Contains(branch) || valid.Any(path => path.StartsWith(branch + "/", StringComparison.Ordinal)))
                        return true;
                }
                index = end;
            }
        }
        return false;
    }

    static void Collect(EvaluationResults result, JsonNode? schemaNode, JsonNode? instance, HashSet<string> valid, List<SchemaIssue> issues)
    {
        if (result.IsValid) return;
        var evalPath = result.EvaluationPath.ToString();
        var path = Pointer(result.InstanceLocation);
        if (SchemaAt(schemaNode, result.SchemaLocation.ToString()) is JsonObject schemaObj
            && schemaObj["not"] is JsonNode notNode
            && NotSchemaMatches(notNode, InstanceAt(instance, path)))
        {
            issues.Add(new SchemaIssue("not", path, "must NOT be valid", null, null, null));
        }
        if (result.HasErrors && result.Errors is not null)
        {
            var eval = evalPath;
            foreach (var (keyword, message) in result.Errors)
            {
                if (LosingBranch(eval, valid)) continue;
                if (eval.Contains("/not", StringComparison.Ordinal)) continue;
                if (eval.Contains("/if", StringComparison.Ordinal) && !eval.Contains("/then", StringComparison.Ordinal))
                    continue;
                if (message.Contains("false schema", StringComparison.Ordinal))
                {
                    var property = LastSegment(path);
                    issues.Add(new SchemaIssue(
                        "additionalProperties",
                        ParentPointer(path),
                        "must NOT have additional properties",
                        string.IsNullOrEmpty(property) ? null : property,
                        null,
                        null));
                    continue;
                }
                if (keyword == "required")
                {
                    AddRequired(issues, path, message);
                    continue;
                }
                if (keyword == "enum")
                {
                    issues.Add(new SchemaIssue(
                        "enum",
                        path,
                        "must be equal to one of the allowed values",
                        null,
                        null,
                        EnumValues(schemaNode, result.SchemaLocation.ToString())));
                    continue;
                }
                issues.Add(new SchemaIssue(keyword, path, message, null, null, null));
            }
        }
        if (result.Details is null) return;
        foreach (var detail in result.Details)
            Collect(detail, schemaNode, instance, valid, issues);
    }

    internal static void AddRequired(List<SchemaIssue> issues, string path, string message)
    {
        var names = RequiredNames(message).ToList();
        if (names.Count == 0)
            issues.Add(new SchemaIssue("required", path, message, null, null, null));
        foreach (var name in names)
            issues.Add(new SchemaIssue("required", path, message, null, name, null));
    }

    static IEnumerable<string> RequiredNames(string message)
    {
        var match = Regex.Match(message, @"\[(.*)\]");
        if (!match.Success) yield break;
        foreach (Match name in Regex.Matches(match.Groups[1].Value, "\"((?:\\\\.|[^\"])*)\""))
            yield return Regex.Unescape(name.Groups[1].Value);
    }

    internal static IReadOnlyList<string>? EnumValues(JsonNode? schema, string? location)
    {
        if (SchemaAt(schema, location) is not JsonObject obj || obj["enum"] is not JsonArray values) return null;
        var list = values.Select(item => item switch
        {
            JsonValue v when v.TryGetValue<string>(out var text) => text,
            null => "",
            _ => item!.ToJsonString().Trim('"'),
        }).ToList();
        return list;
    }

    internal static JsonNode? SchemaAt(JsonNode? root, string? location)
    {
        if (root is null || string.IsNullOrEmpty(location)) return root;
        var hash = location.IndexOf('#');
        if (hash < 0) return root;
        var pointer = location[(hash + 1)..];
        if (pointer.Length == 0) return root;
        JsonNode? node = root;
        foreach (var seg in YamlData.Pointer(pointer.StartsWith('/') ? pointer : "/" + pointer))
        {
            if (node is JsonObject obj && obj.TryGetPropertyValue(seg, out var child)) node = child;
            else if (node is JsonArray arr && int.TryParse(seg, out var index) && index >= 0 && index < arr.Count)
                node = arr[index];
            else return null;
        }
        return node;
    }

    internal static bool NotSchemaMatches(JsonNode notNode, JsonNode? instance)
    {
        var notSchema = JsonSchema.FromText(notNode.ToJsonString());
        return notSchema.Evaluate(instance ?? JsonNode.Parse("null")).IsValid;
    }

    internal static JsonNode? InstanceAt(JsonNode? root, string pointer)
    {
        if (root is null || pointer.Length == 0) return root;
        JsonNode? node = root;
        foreach (var seg in YamlData.Pointer(pointer.StartsWith('/') ? pointer : "/" + pointer))
        {
            if (node is JsonObject obj && obj.TryGetPropertyValue(seg, out var child)) node = child;
            else if (node is JsonArray arr && int.TryParse(seg, out var index) && index >= 0 && index < arr.Count)
                node = arr[index];
            else return null;
        }
        return node;
    }

    internal static string Pointer(Json.Pointer.JsonPointer pointer)
    {
        var text = pointer.ToString();
        return text.Length == 0 ? "" : text;
    }

    internal static string ParentPointer(string path)
    {
        var slash = path.LastIndexOf('/');
        return slash <= 0 ? "" : path[..slash];
    }

    internal static string LastSegment(string path)
    {
        var slash = path.LastIndexOf('/');
        return slash < 0 ? path : path[(slash + 1)..];
    }

    static IReadOnlyList<SchemaIssue> Dedupe(List<SchemaIssue> issues)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var kept = new List<SchemaIssue>();
        foreach (var issue in issues)
        {
            var allowed = issue.AllowedValues is null ? "" : string.Join(",", issue.AllowedValues);
            var key = $"{issue.Keyword}|{issue.InstancePath}|{issue.AdditionalProperty}|{issue.MissingProperty}|{allowed}";
            if (seen.Add(key)) kept.Add(issue);
        }
        return kept;
    }
}
