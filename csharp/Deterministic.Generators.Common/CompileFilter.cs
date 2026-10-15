using System.Globalization;
using System.Text.RegularExpressions;

namespace Deterministic.Generators.Common;

public sealed class FilterCandidate
{
    public required string Name { get; init; }
    public IReadOnlyList<string> Tags { get; init; } = [];
    public string? Inherits { get; init; }
}

public static class CompileFilter
{
    private static readonly HashSet<string> Allowed = new(StringComparer.Ordinal)
    {
        "__name", "__tags", "__inherits", "includes", "true", "false", "null", "undefined",
        "type", "tag", "inherits",
    };

    public static Func<FilterCandidate, bool> Compile(string? filterExpr, string contextLabel = "filter")
    {
        if (string.IsNullOrEmpty(filterExpr)) return _ => true;
        var placeholders = new List<string>();
        var withStrings = Regex.Replace(filterExpr, "\"[^\"]*\"", m =>
        {
            placeholders.Add(m.Value);
            return $"__STR{placeholders.Count - 1}__";
        });
        var rewritten = Rewrite(withStrings);
        AssertKnown(rewritten, contextLabel);
        var restored = Regex.Replace(rewritten, @"__STR(\d+)__", m =>
            placeholders[int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture)]);
        var fn = ParseExpr(restored, contextLabel);
        return cand => Truthy(fn(cand.Name, cand.Tags, cand.Inherits ?? ""));
    }

    public static Func<FilterCandidate, bool> CompileTypes(string? filterExpr) =>
        Compile(filterExpr, "types.filter");

    public static Func<FilterCandidate, bool> CompileTypesFilter(string? filterExpr) =>
        CompileTypes(filterExpr);

    private static string Rewrite(string input)
    {
        var step = Regex.Replace(input, @"\btype\s*(==|!=)\s*(__STR\d+__)",
            m => $"(__name {(m.Groups[1].Value == "==" ? "===" : "!==")} {m.Groups[2].Value})");
        step = Regex.Replace(step, @"\btag\s*==\s*(__STR\d+__)", m => $"__tags.includes({m.Groups[1].Value})");
        step = Regex.Replace(step, @"\btag\s*!=\s*(__STR\d+__)", m => $"!__tags.includes({m.Groups[1].Value})");
        return Regex.Replace(step, @"\binherits\s*(==|!=)\s*(__STR\d+__)",
            m => $"(__inherits {(m.Groups[1].Value == "==" ? "===" : "!==")} {m.Groups[2].Value})");
    }

    private static void AssertKnown(string source, string contextLabel)
    {
        foreach (Match ident in Regex.Matches(source, @"[A-Za-z_][A-Za-z0-9_]*"))
        {
            var text = ident.Value;
            if (text.StartsWith("__STR", StringComparison.Ordinal)) continue;
            if (Allowed.Contains(text)) continue;
            throw new InvalidOperationException(
                $"{contextLabel}: unknown identifier or syntax near \"{text}\". Supported: `type == \"name\"`, `tag == \"kind\"`, `inherits == \"parent\"`, logical && / ||, parens.");
        }
    }

    private enum Kind { String, Number, Bool, Null }

    private readonly record struct JsVal(Kind Kind, string Text, double Number, bool Flag)
    {
        public static JsVal Str(string text) => new(Kind.String, text, 0, false);
        public static JsVal Num(double number) => new(Kind.Number, "", number, false);
        public static JsVal Bool(bool flag) => new(Kind.Bool, "", flag ? 1 : 0, flag);
        public static JsVal Nil() => new(Kind.Null, "", 0, false);
    }

    private delegate JsVal Expr(string name, IReadOnlyList<string> tags, string inherits);

    private static bool Truthy(JsVal value)
    {
        if (value.Kind == Kind.Null) return false;
        if (value.Kind == Kind.Bool) return value.Flag;
        if (value.Kind == Kind.Number) return value.Number != 0 && !double.IsNaN(value.Number);
        return value.Text.Length > 0;
    }

    private static Expr ParseExpr(string source, string contextLabel)
    {
        List<Tok> tokens;
        try
        {
            tokens = Tokenize(source, contextLabel);
        }
        catch (InvalidOperationException ex)
        {
            throw new InvalidOperationException($"{contextLabel} is not a valid expression: {ex.Message}");
        }
        var i = 0;

        Expr ParseOr()
        {
            var left = ParseAnd();
            while (Is("||"))
            {
                i++;
                var right = ParseAnd();
                var l = left;
                var r = right;
                left = (n, t, h) => Truthy(l(n, t, h)) ? l(n, t, h) : r(n, t, h);
            }
            return left;
        }

        Expr ParseAnd()
        {
            var left = ParseEq();
            while (Is("&&"))
            {
                i++;
                var right = ParseEq();
                var l = left;
                var r = right;
                left = (n, t, h) => Truthy(l(n, t, h)) ? r(n, t, h) : l(n, t, h);
            }
            return left;
        }

        Expr ParseEq()
        {
            var left = ParseUnary();
            while (Is("==") || Is("!=") || Is("===") || Is("!=="))
            {
                var op = tokens[i].Text;
                i++;
                var right = ParseUnary();
                var l = left;
                var r = right;
                left = (n, t, h) =>
                {
                    var equal = op is "===" or "!=="
                        ? StrictEqual(l(n, t, h), r(n, t, h))
                        : LooseEqual(l(n, t, h), r(n, t, h));
                    if (op is "!=" or "!==") equal = !equal;
                    return JsVal.Bool(equal);
                };
            }
            return left;
        }

        Expr ParseUnary()
        {
            if (!Is("!")) return ParsePrimary();
            i++;
            var inner = ParseUnary();
            return (n, t, h) => JsVal.Bool(!Truthy(inner(n, t, h)));
        }

        Expr ParsePrimary()
        {
            if (Is("("))
            {
                i++;
                var inner = ParseOr();
                if (!Is(")"))
                    throw new InvalidOperationException($"{contextLabel} is not a valid expression: expected ')'");
                i++;
                return inner;
            }
            if (i >= tokens.Count || tokens[i].Kind == TokKind.Eof)
                throw new InvalidOperationException($"{contextLabel} is not a valid expression: Unexpected end of input");
            var tok = tokens[i];
            if (tok.Kind == TokKind.Number)
            {
                i++;
                var number = tok.Number;
                return (_, _, _) => JsVal.Num(number);
            }
            if (tok.Kind == TokKind.String)
            {
                i++;
                var text = tok.Text;
                return (_, _, _) => JsVal.Str(text);
            }
            if (tok.Kind != TokKind.Ident)
                throw new InvalidOperationException($"{contextLabel} is not a valid expression: unexpected '{tok.Text}'");
            i++;
            if (!Is("."))
            {
                return tok.Text switch
                {
                    "true" => (_, _, _) => JsVal.Bool(true),
                    "false" => (_, _, _) => JsVal.Bool(false),
                    "null" or "undefined" => (_, _, _) => JsVal.Nil(),
                    "__name" => (n, _, _) => JsVal.Str(n),
                    "__inherits" => (_, _, h) => JsVal.Str(h),
                    _ => throw new InvalidOperationException($"{contextLabel} is not a valid expression: {tok.Text} is not defined"),
                };
            }
            i++;
            if (i >= tokens.Count || tokens[i].Text != "includes")
                throw new InvalidOperationException($"{contextLabel} is not a valid expression: unexpected member");
            i++;
            if (!Is("("))
                throw new InvalidOperationException($"{contextLabel} is not a valid expression: expected '('");
            i++;
            if (i >= tokens.Count || tokens[i].Kind != TokKind.String)
                throw new InvalidOperationException($"{contextLabel} is not a valid expression: expected string");
            var needle = tokens[i].Text;
            i++;
            if (!Is(")"))
                throw new InvalidOperationException($"{contextLabel} is not a valid expression: expected ')'");
            i++;
            if (tok.Text != "__tags")
                throw new InvalidOperationException($"{contextLabel} is not a valid expression: {tok.Text}.includes");
            return (_, tags, _) => JsVal.Bool(tags.Contains(needle));
        }

        var expr = ParseOr();
        if (tokens[i].Kind != TokKind.Eof)
            throw new InvalidOperationException($"{contextLabel} is not a valid expression: unexpected '{tokens[i].Text}'");
        return expr;

        bool Is(string text) => i < tokens.Count && tokens[i].Text == text;
    }

    private static bool StrictEqual(JsVal left, JsVal right)
    {
        if (left.Kind != right.Kind) return false;
        if (left.Kind == Kind.String) return left.Text == right.Text;
        if (left.Kind == Kind.Number) return left.Number == right.Number;
        if (left.Kind == Kind.Bool) return left.Flag == right.Flag;
        return true;
    }

    private static bool LooseEqual(JsVal left, JsVal right)
    {
        if (left.Kind == right.Kind) return StrictEqual(left, right);
        if (left.Kind == Kind.Number && right.Kind == Kind.String
            && double.TryParse(right.Text, NumberStyles.Float, CultureInfo.InvariantCulture, out var n))
            return left.Number == n;
        if (right.Kind == Kind.Number && left.Kind == Kind.String
            && double.TryParse(left.Text, NumberStyles.Float, CultureInfo.InvariantCulture, out var m))
            return right.Number == m;
        if (left.Kind == Kind.Bool) return LooseEqual(JsVal.Num(left.Flag ? 1 : 0), right);
        if (right.Kind == Kind.Bool) return LooseEqual(left, JsVal.Num(right.Flag ? 1 : 0));
        return false;
    }

    private enum TokKind { Ident, String, Number, Op, Eof }

    private readonly record struct Tok(TokKind Kind, string Text, double Number);

    private static List<Tok> Tokenize(string source, string contextLabel)
    {
        var tokens = new List<Tok>();
        var i = 0;
        while (i < source.Length)
        {
            var ch = source[i];
            if (char.IsWhiteSpace(ch)) { i++; continue; }
            if (Starts(source, i, "===")) { tokens.Add(new Tok(TokKind.Op, "===", 0)); i += 3; continue; }
            if (Starts(source, i, "!==")) { tokens.Add(new Tok(TokKind.Op, "!==", 0)); i += 3; continue; }
            if (Starts(source, i, "==")) { tokens.Add(new Tok(TokKind.Op, "==", 0)); i += 2; continue; }
            if (Starts(source, i, "!=")) { tokens.Add(new Tok(TokKind.Op, "!=", 0)); i += 2; continue; }
            if (Starts(source, i, "&&")) { tokens.Add(new Tok(TokKind.Op, "&&", 0)); i += 2; continue; }
            if (Starts(source, i, "||")) { tokens.Add(new Tok(TokKind.Op, "||", 0)); i += 2; continue; }
            if (ch is '(' or ')' or '!' or '.')
            {
                tokens.Add(new Tok(TokKind.Op, ch.ToString(), 0));
                i++;
                continue;
            }
            if (ch == '"')
            {
                i++;
                var start = i;
                while (i < source.Length && source[i] != '"') i++;
                if (i >= source.Length)
                    throw new InvalidOperationException($"{contextLabel} is not a valid expression: unterminated string");
                tokens.Add(new Tok(TokKind.String, source[start..i], 0));
                i++;
                continue;
            }
            if (char.IsDigit(ch))
            {
                var start = i;
                while (i < source.Length && (char.IsDigit(source[i]) || source[i] == '.')) i++;
                var text = source[start..i];
                tokens.Add(new Tok(TokKind.Number, text, double.Parse(text, CultureInfo.InvariantCulture)));
                continue;
            }
            if (char.IsLetter(ch) || ch == '_')
            {
                var start = i;
                while (i < source.Length && (char.IsLetterOrDigit(source[i]) || source[i] == '_')) i++;
                tokens.Add(new Tok(TokKind.Ident, source[start..i], 0));
                continue;
            }
            throw new InvalidOperationException($"{contextLabel} is not a valid expression: unexpected character '{ch}'");
        }
        tokens.Add(new Tok(TokKind.Eof, "eof", 0));
        return tokens;
    }

    private static bool Starts(string source, int index, string text) =>
        index + text.Length <= source.Length && source.AsSpan(index, text.Length).SequenceEqual(text);
}
