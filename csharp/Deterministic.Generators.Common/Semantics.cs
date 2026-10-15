using System.Numerics;
using System.Text.RegularExpressions;

namespace Deterministic.Generators.Common;

static class IncludeFilters
{
    static readonly HashSet<string> Accessors = new(StringComparer.Ordinal) { "type", "tag", "inherits" };

    public static SpecValidationResult Check(ParsedYaml parsed)
    {
        var errors = new List<SpecValidationError>();
        var includes = YamlData.AsList(YamlData.AsRecord(parsed.Data)?.GetValueOrDefault("includes"));
        if (includes is null) return SpecValidationResult.Ok();
        for (var i = 0; i < includes.Count; i++)
        {
            var types = YamlData.AsRecord(YamlData.AsRecord(includes[i])?.GetValueOrDefault("types"));
            if (types?.GetValueOrDefault("filter") is not string filter) continue;
            var result = Parse(filter);
            if (result is not null)
                errors.Add(YamlData.Err(parsed, $"/includes/{i}/types/filter", result));
        }
        return errors.Count == 0 ? SpecValidationResult.Ok() : SpecValidationResult.Fail(errors);
    }

    public static bool Match(string? expr, FilterCandidate cand)
    {
        if (string.IsNullOrEmpty(expr)) return true;
        try
        {
            return CompileFilter.Compile(expr)(cand);
        }
        catch
        {
            return false;
        }
    }

    public static string? Parse(string expr)
    {
        var tokens = Tokenize(expr);
        if (tokens.Error is not null) return $"invalid include filter: {tokens.Error}";
        var parsed = new Parser(tokens.Tokens!).Parse();
        return parsed is null ? null : $"invalid include filter: {parsed}";
    }

    sealed record Tok(string Kind, string Value);

    static (List<Tok>? Tokens, string? Error) Tokenize(string input)
    {
        var tokens = new List<Tok>();
        var i = 0;
        while (i < input.Length)
        {
            var ch = input[i];
            if (char.IsWhiteSpace(ch))
            {
                i++;
                continue;
            }
            if (input.AsSpan(i).StartsWith("||")) { tokens.Add(new("op", "||")); i += 2; continue; }
            if (input.AsSpan(i).StartsWith("&&")) { tokens.Add(new("op", "&&")); i += 2; continue; }
            if (input.AsSpan(i).StartsWith("==")) { tokens.Add(new("op", "==")); i += 2; continue; }
            if (input.AsSpan(i).StartsWith("!=")) { tokens.Add(new("op", "!=")); i += 2; continue; }
            if (ch is '(' or ')') { tokens.Add(new("op", ch.ToString())); i++; continue; }
            if (ch == '"')
            {
                i++;
                var value = "";
                while (i < input.Length && input[i] != '"')
                {
                    if (input[i] == '\\' && i + 1 < input.Length)
                    {
                        value += input[i + 1];
                        i += 2;
                        continue;
                    }
                    value += input[i];
                    i++;
                }
                if (i >= input.Length) return (null, "unterminated string literal");
                i++;
                tokens.Add(new("string", value));
                continue;
            }
            if (ch is >= 'a' and <= 'z' or '_')
            {
                var value = "";
                while (i < input.Length && (input[i] is >= 'a' and <= 'z' or >= '0' and <= '9' or '_'))
                {
                    value += input[i];
                    i++;
                }
                tokens.Add(new("ident", value));
                continue;
            }
            return (null, $"unexpected character '{ch}'");
        }
        tokens.Add(new("op", "eof"));
        return (tokens, null);
    }

    sealed class Parser(List<Tok> tokens)
    {
        int _i;

        public string? Parse()
        {
            var atom = Or();
            if (atom is not null) return atom;
            return Is("op", "eof") ? null : Unexpected();
        }

        string? Or()
        {
            var left = And();
            if (left is not null) return left;
            while (Is("op", "||"))
            {
                _i++;
                var right = And();
                if (right is not null) return right;
            }
            return null;
        }

        string? And()
        {
            var left = Atom();
            if (left is not null) return left;
            while (Is("op", "&&"))
            {
                _i++;
                var right = Atom();
                if (right is not null) return right;
            }
            return null;
        }

        string? Atom()
        {
            if (Is("op", "("))
            {
                _i++;
                var inner = Or();
                if (inner is not null) return inner;
                if (!Is("op", ")")) return "expected ')'";
                _i++;
                return null;
            }
            var tok = Peek();
            if (tok.Kind == "ident" && Accessors.Contains(tok.Value)) return Compare(tok.Value);
            return Unexpected();
        }

        string? Compare(string accessor)
        {
            _i++;
            if (!Is("op", "==") && !Is("op", "!=")) return $"expected == or != after {accessor}";
            _i++;
            var value = Peek();
            if (value.Kind == "string")
            {
                _i++;
                return null;
            }
            if (value.Kind == "ident")
                return $"unquoted '{value.Value}'; wrap names in double quotes";
            return $"expected a quoted string after {accessor}";
        }

        Tok Peek() => tokens[_i];
        bool Is(string kind, string value)
        {
            var tok = Peek();
            return tok.Kind == kind && tok.Value == value;
        }

        string Unexpected()
        {
            var tok = Peek();
            if (tok.Kind == "op" && tok.Value == "eof") return "unexpected end of filter";
            if (tok.Kind == "ident") return $"unexpected identifier '{tok.Value}'";
            if (tok.Kind == "string") return $"unexpected string \"{tok.Value}\"";
            return $"unexpected '{tok.Value}'";
        }
    }
}

static class IncludeCycles
{
    public static Task<ValidateOptions?> WithIncludeFilePath(string path, ValidateOptions? options)
    {
        var full = Path.GetFullPath(path);
        return Task.FromResult<ValidateOptions?>(new ValidateOptions
        {
            Types = options?.Types,
            TypesPath = options?.TypesPath,
            Datasource = options?.Datasource,
            DatasourcePath = options?.DatasourcePath,
            IncludeFilePath = options?.IncludeFilePath ?? full,
            IncludeBasePath = options?.IncludeBasePath ?? Path.GetDirectoryName(full),
        });
    }

    public static async Task<SpecValidationResult> Check(ParsedYaml parsed, ValidateOptions? options)
    {
        string? rootPath = options?.IncludeFilePath is not null
            ? Path.GetFullPath(options.IncludeFilePath)
            : options?.IncludeBasePath is not null
                ? Path.GetFullPath(Path.Combine(options.IncludeBasePath, "types.yaml"))
                : null;
        if (rootPath is null) return SpecValidationResult.Ok();
        var rootId = ResolvedId(rootPath);
        var rootDir = Path.GetDirectoryName(rootId) ?? "";
        var errors = new List<SpecValidationError>();
        var stack = new List<string>();
        var done = new HashSet<string>(StringComparer.Ordinal);

        async Task Walk(string path, int rootIncludeIndex)
        {
            var id = ResolvedId(path);
            var instancePath = $"/includes/{rootIncludeIndex}/file";
            if (stack.Contains(id))
            {
                var cycle = stack.Append(id).Select(p => Path.GetRelativePath(rootDir, p));
                errors.Add(YamlData.Err(parsed, instancePath, $"circular include: {string.Join(" → ", cycle)}"));
                return;
            }
            if (done.Contains(id)) return;
            var loaded = await LoadChild(path);
            if (loaded.Error is not null)
            {
                errors.Add(YamlData.Err(parsed, instancePath, loaded.Error));
                return;
            }
            stack.Add(id);
            foreach (var inc in FileIncludes(loaded.Data))
                await Walk(Path.GetFullPath(Path.Combine(Path.GetDirectoryName(path) ?? "", inc.File)), rootIncludeIndex);
            stack.RemoveAt(stack.Count - 1);
            done.Add(id);
        }

        stack.Add(rootId);
        foreach (var inc in FileIncludes(parsed.Data))
            await Walk(Path.GetFullPath(Path.Combine(Path.GetDirectoryName(rootPath) ?? "", inc.File)), inc.Index);
        stack.RemoveAt(stack.Count - 1);
        done.Add(rootId);
        return errors.Count == 0 ? SpecValidationResult.Ok() : SpecValidationResult.Fail(errors);
    }

    internal static string ResolvedId(string path)
    {
        var abs = Path.GetFullPath(path);
        if (File.Exists(abs))
            return File.ResolveLinkTarget(abs, true)?.FullName ?? abs;
        if (Directory.Exists(abs))
            return Directory.ResolveLinkTarget(abs, true)?.FullName ?? abs;
        var dir = Path.GetDirectoryName(abs);
        var name = Path.GetFileName(abs);
        if (Directory.Exists(dir))
            return Path.Combine(Directory.ResolveLinkTarget(dir, true)?.FullName ?? Path.GetFullPath(dir), name);
        return abs;
    }

    static List<(int Index, string File)> FileIncludes(object? data)
    {
        var includes = YamlData.AsList(YamlData.AsRecord(data)?.GetValueOrDefault("includes"));
        var result = new List<(int, string)>();
        if (includes is null) return result;
        for (var i = 0; i < includes.Count; i++)
        {
            if (YamlData.AsRecord(includes[i])?.GetValueOrDefault("file") is string file && file.Length > 0)
                result.Add((i, file));
        }
        return result;
    }

    static async Task<(object? Data, string? Error)> LoadChild(string path)
    {
        string text;
        try
        {
            text = await File.ReadAllTextAsync(path);
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            return (null, $"include file not found: {Path.GetFileName(path)}");
        }
        catch (Exception ex)
        {
            return (null, $"cannot read include {Path.GetFileName(path)}: {ex.Message}");
        }
        var parsed = YamlDocuments.Parse(text);
        if (parsed.Errors.Count > 0)
            return (null, $"include is not valid YAML: {parsed.Errors[0].Message}");
        var data = YamlData.Plain(parsed.Root);
        if (YamlData.AsRecord(data) is null || YamlData.IsList(data))
            return (null, $"include must be a mapping: {Path.GetFileName(path)}");
        return (data, null);
    }
}

static class FieldCatalog
{
    public sealed class DefaultToken
    {
        public required string Token { get; init; }
        public required string Regex { get; init; }
    }

    public sealed class FieldType
    {
        public required string Name { get; init; }
        public bool? SupportsSize { get; init; }
        public object? ImplicitDefault { get; init; }
        public bool HasImplicit { get; init; }
        public string? MinValue { get; init; }
        public bool MinIsNull { get; init; }
        public string? MaxValue { get; init; }
        public bool MaxIsNull { get; init; }
        public List<DefaultToken> Defaults { get; init; } = [];
    }

    static readonly Dictionary<string, Task<Dictionary<string, FieldType>>> Cache = new(StringComparer.Ordinal);

    public static Task<Dictionary<string, FieldType>> Load(string? start = null)
    {
        var key = start ?? "";
        if (Cache.TryGetValue(key, out var hit)) return hit;
        var pending = LoadNew(start);
        Cache[key] = pending;
        return pending;
    }

    static async Task<Dictionary<string, FieldType>> LoadNew(string? start)
    {
        var path = await SpecPaths.FindSpecPath("backend", "types.yaml", start);
        if (path is null) throw new InvalidOperationException("field type catalog not found: backend/types.yaml");
        return Parse(await File.ReadAllTextAsync(path));
    }

    public static Dictionary<string, FieldType> Parse(string text)
    {
        var data = YamlData.Plain(YamlDocuments.Parse(text).Root);
        var types = YamlData.AsList(YamlData.AsRecord(data)?.GetValueOrDefault("types"));
        var map = new Dictionary<string, FieldType>(StringComparer.Ordinal);
        if (types is null) return map;
        foreach (var entry in types)
        {
            var parsed = ParseType(entry);
            if (parsed is not null) map[parsed.Name] = parsed;
        }
        return map;
    }

    static FieldType? ParseType(object? entry)
    {
        var pair = YamlData.SingleKey(entry);
        if (pair is null) return null;
        var body = YamlData.AsRecord(pair.Value.Body) ?? [];
        var min = body.GetValueOrDefault("min_value");
        var max = body.GetValueOrDefault("max_value");
        return new FieldType
        {
            Name = pair.Value.Key,
            SupportsSize = body.GetValueOrDefault("supports_size") is bool b ? b : null,
            ImplicitDefault = body.ContainsKey("implicit_default") ? body["implicit_default"] : null,
            HasImplicit = body.ContainsKey("implicit_default"),
            MinValue = min as string,
            MinIsNull = body.ContainsKey("min_value") && min is null,
            MaxValue = max as string,
            MaxIsNull = body.ContainsKey("max_value") && max is null,
            Defaults = ParseDefaults(body.GetValueOrDefault("defaults")),
        };
    }

    static List<DefaultToken> ParseDefaults(object? raw)
    {
        var list = YamlData.AsList(raw);
        var result = new List<DefaultToken>();
        if (list is null) return result;
        foreach (var entry in list)
        {
            var pair = YamlData.SingleKey(entry);
            if (pair is null) continue;
            var body = YamlData.AsRecord(pair.Value.Body) ?? [];
            if (body.GetValueOrDefault("regex") is not string regex) continue;
            result.Add(new DefaultToken { Token = pair.Value.Key, Regex = regex });
        }
        return result;
    }
}

static class FieldDefaults
{
    public static async Task<SpecValidationResult> Check(ParsedYaml parsed) =>
        Check(parsed, await FieldCatalog.Load());

    public static SpecValidationResult Check(ParsedYaml parsed, Dictionary<string, FieldCatalog.FieldType> catalog)
    {
        var errors = new List<SpecValidationError>();
        Visit(parsed.Data, (path, def) =>
        {
            if (!def.ContainsKey("default_value")) return;
            if (def.GetValueOrDefault("type") is not string typeName) return;
            if (!catalog.TryGetValue(typeName, out var field)) return;
            var value = def["default_value"];
            var valuePath = $"{path}/default_value";
            if (value is string text)
            {
                var token = TokenError(field, text);
                if (token is not null) errors.Add(YamlData.Err(parsed, valuePath, token));
            }
            if (typeName == "character" && value is string chars)
            {
                var size = YamlData.TryFinite(def.GetValueOrDefault("size"), out var n) ? (int)n : 1;
                if (chars.Length != size)
                    errors.Add(YamlData.Err(parsed, valuePath, $"character default_value length must equal size ({size})"));
            }
            var range = RangeError(field, value);
            if (range is not null) errors.Add(YamlData.Err(parsed, valuePath, range));
        });
        return errors.Count == 0 ? SpecValidationResult.Ok() : SpecValidationResult.Fail(errors);
    }

    static string? TokenError(FieldCatalog.FieldType catalog, string value)
    {
        if (catalog.Defaults.Count == 0) return null;
        if (catalog.Defaults.Any(tok => Regex.IsMatch(value, tok.Regex))) return null;
        var allowed = string.Join(", ", catalog.Defaults.Select(tok => tok.Token));
        return $"default_value '{value}' is not a valid {catalog.Name} default — allowed forms: {allowed}";
    }

    static string? RangeError(FieldCatalog.FieldType catalog, object? value)
    {
        if (catalog.MinValue is null && catalog.MaxValue is null) return null;
        if (value is null) return null;
        var raw = Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture)!;
        if (!Regex.IsMatch(raw, @"^-?\d+$")) return null;
        var n = BigInteger.Parse(raw, System.Globalization.CultureInfo.InvariantCulture);
        if (catalog.MinValue is not null && n < BigInteger.Parse(catalog.MinValue, System.Globalization.CultureInfo.InvariantCulture))
            return $"default_value '{raw}' is out of range for {catalog.Name} (allowed {catalog.MinValue}..{catalog.MaxValue})";
        if (catalog.MaxValue is not null && n > BigInteger.Parse(catalog.MaxValue, System.Globalization.CultureInfo.InvariantCulture))
            return $"default_value '{raw}' is out of range for {catalog.Name} (allowed {catalog.MinValue}..{catalog.MaxValue})";
        return null;
    }

    static void Visit(object? data, Action<string, Dictionary<string, object?>> visit)
    {
        var root = YamlData.AsRecord(data);
        var types = YamlData.AsList(root?.GetValueOrDefault("types"));
        if (types is not null)
        {
            for (var ti = 0; ti < types.Count; ti++)
            {
                var rec = YamlData.AsRecord(types[ti]);
                if (rec is null || rec.Count == 0) continue;
                var table = rec.Keys.First();
                var fields = YamlData.AsList(YamlData.AsRecord(rec[table])?.GetValueOrDefault("fields"));
                if (fields is null) continue;
                for (var fi = 0; fi < fields.Count; fi++)
                {
                    var field = YamlData.AsRecord(fields[fi]);
                    if (field is null || field.Count == 0) continue;
                    var name = field.Keys.First();
                    var def = YamlData.AsRecord(field[name]);
                    if (def is not null) visit($"/types/{ti}/{table}/fields/{fi}/{name}", def);
                }
            }
        }
        var includes = YamlData.AsList(root?.GetValueOrDefault("includes"));
        if (includes is null) return;
        for (var ii = 0; ii < includes.Count; ii++)
        {
            var opts = YamlData.AsRecord(YamlData.AsRecord(includes[ii])?.GetValueOrDefault("combine_options"));
            if (opts is null) continue;
            foreach (var side in new[] { "source", "destination" })
            {
                var sideOpts = YamlData.AsRecord(opts.GetValueOrDefault(side));
                if (sideOpts is null) continue;
                var modify = YamlData.AsList(sideOpts.GetValueOrDefault("modify_fields"));
                if (modify is not null)
                {
                    for (var mi = 0; mi < modify.Count; mi++)
                    {
                        var def = YamlData.AsRecord(YamlData.AsRecord(modify[mi])?.GetValueOrDefault("def"));
                        if (def is not null)
                            visit($"/includes/{ii}/combine_options/{side}/modify_fields/{mi}/def", def);
                    }
                }
                var add = YamlData.AsList(sideOpts.GetValueOrDefault("add_fields"));
                if (add is null) continue;
                for (var ai = 0; ai < add.Count; ai++)
                {
                    var addField = YamlData.AsRecord(YamlData.AsRecord(add[ai])?.GetValueOrDefault("add_field"));
                    if (addField is null || addField.Count == 0) continue;
                    var name = addField.Keys.First();
                    var def = YamlData.AsRecord(addField[name]);
                    if (def is not null)
                        visit($"/includes/{ii}/combine_options/{side}/add_fields/{ai}/add_field/{name}", def);
                }
            }
        }
    }
}
