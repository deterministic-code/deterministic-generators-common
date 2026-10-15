using System.Globalization;
using System.Text.RegularExpressions;

namespace Deterministic.Generators.Common;

/// <summary>
/// Last-token pluralization compatible with the npm pluralize package.
/// Rules run from last to first, matching that package's lookup order.
/// </summary>
public static class Pluralize
{
    private static readonly List<(Regex Pattern, string Replacement)> PluralRules = [];
    private static readonly List<(Regex Pattern, string Replacement)> SingularRules = [];
    private static readonly HashSet<string> Uncountables = new(StringComparer.Ordinal);
    private static readonly Dictionary<string, string> IrregularSingles = new(StringComparer.Ordinal);
    private static readonly Dictionary<string, string> IrregularPlurals = new(StringComparer.Ordinal);

    static Pluralize()
    {
        (string Single, string Plural)[] irregular =
        [
            ("I", "we"), ("me", "us"), ("he", "they"), ("she", "they"), ("them", "them"),
            ("myself", "ourselves"), ("yourself", "yourselves"), ("itself", "themselves"),
            ("herself", "themselves"), ("himself", "themselves"), ("themself", "themselves"),
            ("is", "are"), ("was", "were"), ("has", "have"), ("this", "these"), ("that", "those"),
            ("echo", "echoes"), ("dingo", "dingoes"), ("volcano", "volcanoes"), ("tornado", "tornadoes"),
            ("torpedo", "torpedoes"), ("genus", "genera"), ("viscus", "viscera"), ("stigma", "stigmata"),
            ("stoma", "stomata"), ("dogma", "dogmata"), ("lemma", "lemmata"), ("schema", "schemata"),
            ("anathema", "anathemata"), ("ox", "oxen"), ("axe", "axes"), ("die", "dice"), ("yes", "yeses"),
            ("foot", "feet"), ("eave", "eaves"), ("goose", "geese"), ("tooth", "teeth"), ("quiz", "quizzes"),
            ("human", "humans"), ("proof", "proofs"), ("carve", "carves"), ("valve", "valves"),
            ("looey", "looies"), ("thief", "thieves"), ("groove", "grooves"), ("pickaxe", "pickaxes"),
            ("passerby", "passersby"),
        ];
        foreach (var (single, plural) in irregular)
        {
            IrregularSingles[single.ToLowerInvariant()] = plural.ToLowerInvariant();
            IrregularPlurals[plural.ToLowerInvariant()] = single.ToLowerInvariant();
        }

        Add(PluralRules, @"s?$", "s");
        Add(PluralRules, @"[^\u0000-\u007F]$", "$0");
        Add(PluralRules, @"([^aeiou]ese)$", "$1");
        Add(PluralRules, @"(ax|test)is$", "$1es");
        Add(PluralRules, @"(alias|[^aou]us|t[lm]as|gas|ris)$", "$1es");
        Add(PluralRules, @"(e[mn]u)s?$", "$1s");
        Add(PluralRules, @"([^l]ias|[aeiou]las|[ejzr]as|[iu]am)$", "$1");
        Add(PluralRules, @"(alumn|syllab|vir|radi|nucle|fung|cact|stimul|termin|bacill|foc|uter|loc|strat)(?:us|i)$", "$1i");
        Add(PluralRules, @"(alumn|alg|vertebr)(?:a|ae)$", "$1ae");
        Add(PluralRules, @"(seraph|cherub)(?:im)?$", "$1im");
        Add(PluralRules, @"(her|at|gr)o$", "$1oes");
        Add(PluralRules, @"(agend|addend|millenni|dat|extrem|bacteri|desiderat|strat|candelabr|errat|ov|symposi|curricul|automat|quor)(?:a|um)$", "$1a");
        Add(PluralRules, @"(apheli|hyperbat|periheli|asyndet|noumen|phenomen|criteri|organ|prolegomen|hedr|automat)(?:a|on)$", "$1a");
        Add(PluralRules, @"sis$", "ses");
        Add(PluralRules, @"(?:(kni|wi|li)fe|(ar|l|ea|eo|oa|hoo)f)$", "$1$2ves");
        Add(PluralRules, @"([^aeiouy]|qu)y$", "$1ies");
        Add(PluralRules, @"([^ch][ieo][ln])ey$", "$1ies");
        Add(PluralRules, @"(x|ch|ss|sh|zz)$", "$1es");
        Add(PluralRules, @"(matr|cod|mur|sil|vert|ind|append)(?:ix|ex)$", "$1ices");
        Add(PluralRules, @"\b((?:tit)?m|l)(?:ice|ouse)$", "$1ice");
        Add(PluralRules, @"(pe)(?:rson|ople)$", "$1ople");
        Add(PluralRules, @"(child)(?:ren)?$", "$1ren");
        Add(PluralRules, @"eaux$", "$0");
        Add(PluralRules, @"m[ae]n$", "men");
        Add(PluralRules, "^thou$", "you");

        Add(SingularRules, @"s$", "");
        Add(SingularRules, @"(ss)$", "$1");
        Add(SingularRules, @"(wi|kni|(?:after|half|high|low|mid|non|night|[^\w]|^)li)ves$", "$1fe");
        Add(SingularRules, @"(ar|(?:wo|[ae])l|[eo][ao])ves$", "$1f");
        Add(SingularRules, @"ies$", "y");
        Add(SingularRules, @"\b([pl]|zomb|(?:neck|cross)?t|coll|faer|food|gen|goon|group|lass|talk|goal|cut)ies$", "$1ie");
        Add(SingularRules, @"\b(mon|smil)ies$", "$1ey");
        Add(SingularRules, @"\b((?:tit)?m|l)ice$", "$1ouse");
        Add(SingularRules, @"(seraph|cherub)im$", "$1");
        Add(SingularRules, @"(x|ch|ss|sh|zz|tto|go|cho|alias|[^aou]us|t[lm]as|gas|(?:her|at|gr)o|[aeiou]ris)(?:es)?$", "$1");
        Add(SingularRules, @"(analy|diagno|parenthe|progno|synop|the|empha|cri|ne)(?:sis|ses)$", "$1sis");
        Add(SingularRules, @"(movie|twelve|abuse|e[mn]u)s$", "$1");
        Add(SingularRules, @"(test)(?:is|es)$", "$1is");
        Add(SingularRules, @"(alumn|syllab|vir|radi|nucle|fung|cact|stimul|termin|bacill|foc|uter|loc|strat)(?:us|i)$", "$1us");
        Add(SingularRules, @"(agend|addend|millenni|dat|extrem|bacteri|desiderat|strat|candelabr|errat|ov|symposi|curricul|quor)a$", "$1um");
        Add(SingularRules, @"(apheli|hyperbat|periheli|asyndet|noumen|phenomen|criteri|organ|prolegomen|hedr|automat)a$", "$1on");
        Add(SingularRules, @"(alumn|alg|vertebr)ae$", "$1a");
        Add(SingularRules, @"(cod|mur|sil|vert|ind)ices$", "$1ex");
        Add(SingularRules, @"(matr|append)ices$", "$1ix");
        Add(SingularRules, @"(pe)(rson|ople)$", "$1rson");
        Add(SingularRules, @"(child)ren$", "$1");
        Add(SingularRules, @"(eau)x?$", "$1");
        Add(SingularRules, @"men$", "man");

        foreach (var word in UncountableWords) Uncountables.Add(word);
        foreach (var pattern in UncountablePatterns)
        {
            Add(PluralRules, pattern, "$0");
            Add(SingularRules, pattern, "$0");
        }
    }

    public static string Plural(string word) =>
        ReplaceWord(word, IrregularPlurals, IrregularSingles, PluralRules);

    public static string Singular(string word) =>
        ReplaceWord(word, IrregularSingles, IrregularPlurals, SingularRules);

    private static void Add(List<(Regex, string)> rules, string pattern, string replacement) =>
        rules.Add((new Regex(pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant), replacement));

    private static string ReplaceWord(
        string word,
        Dictionary<string, string> keepMap,
        Dictionary<string, string> replaceMap,
        List<(Regex Pattern, string Replacement)> rules)
    {
        var token = word.ToLowerInvariant();
        if (keepMap.ContainsKey(token)) return RestoreCase(word, token);
        if (replaceMap.TryGetValue(token, out var mapped)) return RestoreCase(word, mapped);
        return Sanitize(token, word, rules);
    }

    private static string Sanitize(string token, string word, List<(Regex Pattern, string Replacement)> rules)
    {
        if (token.Length == 0 || Uncountables.Contains(token)) return word;
        for (var i = rules.Count - 1; i >= 0; i--)
        {
            var (pattern, replacement) = rules[i];
            if (pattern.IsMatch(word)) return Apply(word, pattern, replacement);
        }
        return word;
    }

    private static string Apply(string word, Regex pattern, string replacement)
    {
        var match = pattern.Match(word);
        var result = Interpolate(replacement, match);
        var cased = match.Value.Length == 0
            ? RestoreEmpty(word, match.Index, result)
            : RestoreCase(match.Value, result);
        return string.Concat(word.AsSpan(0, match.Index), cased, word.AsSpan(match.Index + match.Length));
    }

    private static string RestoreEmpty(string word, int index, string result)
    {
        return RestoreCase(word[Math.Max(0, index - 1)].ToString(), result);
    }

    private static string Interpolate(string template, Match match) =>
        Regex.Replace(template, @"\$(\d{1,2})", m =>
        {
            var index = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
            if (index == 0) return match.Value;
            return index < match.Groups.Count ? match.Groups[index].Value : "";
        });

    internal static string RestoreCase(string word, string token)
    {
        if (word == token) return token;
        if (word == word.ToLowerInvariant()) return token.ToLowerInvariant();
        if (word == word.ToUpperInvariant()) return token.ToUpperInvariant();
        if (word[0] == char.ToUpperInvariant(word[0]))
            return token.Length == 0
                ? token
                : char.ToUpperInvariant(token[0]) + token[1..].ToLowerInvariant();
        return token.ToLowerInvariant();
    }

    private static readonly string[] UncountableWords =
    [
        "adulthood", "advice", "agenda", "aid", "aircraft", "alcohol", "ammo", "analytics", "anime",
        "athletics", "audio", "bison", "blood", "bream", "buffalo", "butter", "carp", "cash", "chassis",
        "chess", "clothing", "cod", "commerce", "cooperation", "corps", "debris", "diabetes", "digestion",
        "elk", "energy", "equipment", "excretion", "expertise", "firmware", "flounder", "fun", "gallows",
        "garbage", "graffiti", "hardware", "headquarters", "health", "herpes", "highjinks", "homework",
        "housework", "information", "jeans", "justice", "kudos", "labour", "literature", "machinery",
        "mackerel", "mail", "media", "mews", "moose", "music", "mud", "manga", "news", "only", "personnel",
        "pike", "plankton", "pliers", "police", "pollution", "premises", "rain", "research", "rice",
        "salmon", "scissors", "series", "sewage", "shambles", "shrimp", "software", "species", "staff",
        "swine", "tennis", "traffic", "transportation", "trout", "tuna", "wealth", "welfare", "whiting",
        "wildebeest", "wildlife", "you",
    ];

    private static readonly string[] UncountablePatterns =
    [
        @"pok[eé]mon$", @"[^aeiou]ese$", @"deer$", @"fish$", @"measles$", @"o[iu]s$", @"pox$", @"sheep$",
    ];
}
