//! Last-token pluralization matching the `pluralize` npm package.
//!
//! Rules are applied in reverse insertion order, the same way that package does.

use std::sync::OnceLock;

use regex::Regex;

struct Rule {
    pattern: Regex,
    replacement: &'static str,
}

struct Pluralizer {
    plural_rules: Vec<Rule>,
    singular_rules: Vec<Rule>,
    uncountables: Vec<&'static str>,
    irregular_singles: Vec<(&'static str, &'static str)>,
    irregular_plurals: Vec<(&'static str, &'static str)>,
}

fn regex(pattern: &str) -> Regex {
    Regex::new(&format!("(?i){pattern}")).unwrap_or_else(|err| {
        panic!("pluralize rule /{pattern}/ failed to compile: {err}")
    })
}

fn engine() -> &'static Pluralizer {
    static ENGINE: OnceLock<Pluralizer> = OnceLock::new();
    ENGINE.get_or_init(build)
}

fn build() -> Pluralizer {
    let mut plural_rules = Vec::new();
    let mut singular_rules = Vec::new();
    let add_plural = |rules: &mut Vec<Rule>, pattern: &str, replacement: &'static str| {
        let anchored = if pattern.starts_with('^') || pattern.contains("(?") {
            pattern.to_string()
        } else {
            pattern.to_string()
        };
        rules.push(Rule {
            pattern: regex(&anchored),
            replacement,
        });
    };

    let plural_src: &[(&str, &str)] = &[
        (r"s?$", "s"),
        (r"[^\u0000-\u007F]$", "$0"),
        (r"([^aeiou]ese)$", "$1"),
        (r"(ax|test)is$", "$1es"),
        (r"(alias|[^aou]us|t[lm]as|gas|ris)$", "$1es"),
        (r"(e[mn]u)s?$", "$1s"),
        (r"([^l]ias|[aeiou]las|[ejzr]as|[iu]am)$", "$1"),
        (
            r"(alumn|syllab|vir|radi|nucle|fung|cact|stimul|termin|bacill|foc|uter|loc|strat)(?:us|i)$",
            "$1i",
        ),
        (r"(alumn|alg|vertebr)(?:a|ae)$", "$1ae"),
        (r"(seraph|cherub)(?:im)?$", "$1im"),
        (r"(her|at|gr)o$", "$1oes"),
        (
            r"(agend|addend|millenni|dat|extrem|bacteri|desiderat|strat|candelabr|errat|ov|symposi|curricul|automat|quor)(?:a|um)$",
            "$1a",
        ),
        (
            r"(apheli|hyperbat|periheli|asyndet|noumen|phenomen|criteri|organ|prolegomen|hedr|automat)(?:a|on)$",
            "$1a",
        ),
        (r"sis$", "ses"),
        (r"(?:(kni|wi|li)fe|(ar|l|ea|eo|oa|hoo)f)$", "$1$2ves"),
        (r"([^aeiouy]|qu)y$", "$1ies"),
        (r"([^ch][ieo][ln])ey$", "$1ies"),
        (r"(x|ch|ss|sh|zz)$", "$1es"),
        (r"(matr|cod|mur|sil|vert|ind|append)(?:ix|ex)$", "$1ices"),
        (r"\b((?:tit)?m|l)(?:ice|ouse)$", "$1ice"),
        (r"(pe)(?:rson|ople)$", "$1ople"),
        (r"(child)(?:ren)?$", "$1ren"),
        (r"eaux$", "$0"),
        (r"m[ae]n$", "men"),
        (r"^thou$", "you"),
    ];
    for (pattern, replacement) in plural_src {
        add_plural(&mut plural_rules, pattern, replacement);
    }

    let singular_src: &[(&str, &str)] = &[
        (r"s$", ""),
        (r"(ss)$", "$1"),
        (
            r"(wi|kni|(?:after|half|high|low|mid|non|night|[^A-Za-z0-9_]|^)li)ves$",
            "$1fe",
        ),
        (r"(ar|(?:wo|[ae])l|[eo][ao])ves$", "$1f"),
        (r"ies$", "y"),
        (
            r"\b([pl]|zomb|(?:neck|cross)?t|coll|faer|food|gen|goon|group|lass|talk|goal|cut)ies$",
            "$1ie",
        ),
        (r"\b(mon|smil)ies$", "$1ey"),
        (r"\b((?:tit)?m|l)ice$", "$1ouse"),
        (r"(seraph|cherub)im$", "$1"),
        (
            r"(x|ch|ss|sh|zz|tto|go|cho|alias|[^aou]us|t[lm]as|gas|(?:her|at|gr)o|[aeiou]ris)(?:es)?$",
            "$1",
        ),
        (r"(analy|diagno|parenthe|progno|synop|the|empha|cri|ne)(?:sis|ses)$", "$1sis"),
        (r"(movie|twelve|abuse|e[mn]u)s$", "$1"),
        (r"(test)(?:is|es)$", "$1is"),
        (
            r"(alumn|syllab|vir|radi|nucle|fung|cact|stimul|termin|bacill|foc|uter|loc|strat)(?:us|i)$",
            "$1us",
        ),
        (
            r"(agend|addend|millenni|dat|extrem|bacteri|desiderat|strat|candelabr|errat|ov|symposi|curricul|quor)a$",
            "$1um",
        ),
        (
            r"(apheli|hyperbat|periheli|asyndet|noumen|phenomen|criteri|organ|prolegomen|hedr|automat)a$",
            "$1on",
        ),
        (r"(alumn|alg|vertebr)ae$", "$1a"),
        (r"(cod|mur|sil|vert|ind)ices$", "$1ex"),
        (r"(matr|append)ices$", "$1ix"),
        (r"(pe)(rson|ople)$", "$1rson"),
        (r"(child)ren$", "$1"),
        (r"(eau)x?$", "$1"),
        (r"men$", "man"),
    ];
    for (pattern, replacement) in singular_src {
        add_plural(&mut singular_rules, pattern, replacement);
    }

    let uncountable_res: &[&str] = &[
        r"pok[eé]mon$",
        r"[^aeiou]ese$",
        r"deer$",
        r"fish$",
        r"measles$",
        r"o[iu]s$",
        r"pox$",
        r"sheep$",
    ];
    for pattern in uncountable_res {
        add_plural(&mut plural_rules, pattern, "$0");
        add_plural(&mut singular_rules, pattern, "$0");
    }

    let irregulars = [
        ("i", "we"),
        ("me", "us"),
        ("he", "they"),
        ("she", "they"),
        ("them", "them"),
        ("myself", "ourselves"),
        ("yourself", "yourselves"),
        ("itself", "themselves"),
        ("herself", "themselves"),
        ("himself", "themselves"),
        ("themself", "themselves"),
        ("is", "are"),
        ("was", "were"),
        ("has", "have"),
        ("this", "these"),
        ("that", "those"),
        ("echo", "echoes"),
        ("dingo", "dingoes"),
        ("volcano", "volcanoes"),
        ("tornado", "tornadoes"),
        ("torpedo", "torpedoes"),
        ("genus", "genera"),
        ("viscus", "viscera"),
        ("stigma", "stigmata"),
        ("stoma", "stomata"),
        ("dogma", "dogmata"),
        ("lemma", "lemmata"),
        ("schema", "schemata"),
        ("anathema", "anathemata"),
        ("ox", "oxen"),
        ("axe", "axes"),
        ("die", "dice"),
        ("yes", "yeses"),
        ("foot", "feet"),
        ("eave", "eaves"),
        ("goose", "geese"),
        ("tooth", "teeth"),
        ("quiz", "quizzes"),
        ("human", "humans"),
        ("proof", "proofs"),
        ("carve", "carves"),
        ("valve", "valves"),
        ("looey", "looies"),
        ("thief", "thieves"),
        ("groove", "grooves"),
        ("pickaxe", "pickaxes"),
        ("passerby", "passersby"),
    ];

    let uncountables = [
        "adulthood",
        "advice",
        "agenda",
        "aid",
        "aircraft",
        "alcohol",
        "ammo",
        "analytics",
        "anime",
        "athletics",
        "audio",
        "bison",
        "blood",
        "bream",
        "buffalo",
        "butter",
        "carp",
        "cash",
        "chassis",
        "chess",
        "clothing",
        "cod",
        "commerce",
        "cooperation",
        "corps",
        "debris",
        "diabetes",
        "digestion",
        "elk",
        "energy",
        "equipment",
        "excretion",
        "expertise",
        "firmware",
        "flounder",
        "fun",
        "gallows",
        "garbage",
        "graffiti",
        "hardware",
        "headquarters",
        "health",
        "herpes",
        "highjinks",
        "homework",
        "housework",
        "information",
        "jeans",
        "justice",
        "kudos",
        "labour",
        "literature",
        "machinery",
        "mackerel",
        "mail",
        "media",
        "mews",
        "moose",
        "music",
        "mud",
        "manga",
        "news",
        "only",
        "personnel",
        "pike",
        "plankton",
        "pliers",
        "police",
        "pollution",
        "premises",
        "rain",
        "research",
        "rice",
        "salmon",
        "scissors",
        "series",
        "sewage",
        "shambles",
        "shrimp",
        "software",
        "species",
        "staff",
        "swine",
        "tennis",
        "traffic",
        "transportation",
        "trout",
        "tuna",
        "wealth",
        "welfare",
        "whiting",
        "wildebeest",
        "wildlife",
        "you",
    ];

    Pluralizer {
        plural_rules,
        singular_rules,
        uncountables: uncountables.to_vec(),
        irregular_singles: irregulars.to_vec(),
        irregular_plurals: irregulars.iter().map(|(s, p)| (*p, *s)).collect(),
    }
}

fn restore_case(word: &str, token: &str) -> String {
    if word == token {
        return token.to_string();
    }
    if word == word.to_lowercase() {
        return token.to_lowercase();
    }
    if !word.is_empty() && word == word.to_uppercase() {
        return token.to_uppercase();
    }
    let mut chars = token.chars();
    if word.chars().next().is_some_and(|c| c.is_uppercase()) {
        let first = chars
            .next()
            .map(|c| c.to_uppercase().collect::<String>())
            .unwrap_or_default();
        let rest: String = chars.collect::<String>().to_lowercase();
        return format!("{first}{rest}");
    }
    token.to_lowercase()
}

fn interpolate(template: &str, caps: &regex::Captures<'_>) -> String {
    let mut out = String::new();
    let bytes = template.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'$' && i + 1 < bytes.len() && bytes[i + 1].is_ascii_digit() {
            let mut j = i + 1;
            let mut n: usize = 0;
            let mut digits = 0;
            while j < bytes.len() && bytes[j].is_ascii_digit() && digits < 2 {
                n = n * 10 + (bytes[j] - b'0') as usize;
                j += 1;
                digits += 1;
            }
            if let Some(group) = caps.get(n) {
                out.push_str(group.as_str());
            }
            i = j;
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}

fn apply_rule(word: &str, rule: &Rule) -> Option<String> {
    let caps = rule.pattern.captures(word)?;
    let full = caps.get(0)?;
    let interpolated = interpolate(rule.replacement, &caps);
    let replaced = if full.as_str().is_empty() {
        let idx = full.start();
        let prev = if idx == 0 {
            ""
        } else {
            word.get(idx - 1..idx).unwrap_or("")
        };
        restore_case(prev, &interpolated)
    } else {
        restore_case(full.as_str(), &interpolated)
    };
    let mut out = String::new();
    out.push_str(&word[..full.start()]);
    out.push_str(&replaced);
    out.push_str(&word[full.end()..]);
    Some(out)
}

fn sanitize(word: &str, token: &str, rules: &[Rule], uncountables: &[&str]) -> String {
    if token.is_empty() || uncountables.iter().any(|item| *item == token) {
        return word.to_string();
    }
    for rule in rules.iter().rev() {
        if let Some(updated) = apply_rule(word, rule) {
            return updated;
        }
    }
    word.to_string()
}

fn lookup<'a>(pairs: &'a [(&'a str, &'a str)], token: &str) -> Option<&'a str> {
    pairs.iter().find(|(key, _)| *key == token).map(|(_, v)| *v)
}

fn contains(pairs: &[(&str, &str)], token: &str) -> bool {
    pairs.iter().any(|(key, _)| *key == token)
}

fn replace_word(
    word: &str,
    replace_map: &[(&str, &str)],
    keep_map: &[(&str, &str)],
    rules: &[Rule],
    uncountables: &[&str],
) -> String {
    let token = word.to_lowercase();
    if contains(keep_map, &token) {
        return restore_case(word, &token);
    }
    if let Some(mapped) = lookup(replace_map, &token) {
        return restore_case(word, mapped);
    }
    sanitize(word, &token, rules, uncountables)
}

#[inline(never)]
pub fn plural(word: &str) -> String {
    let engine = engine();
    replace_word(
        word,
        &engine.irregular_singles,
        &engine.irregular_plurals,
        &engine.plural_rules,
        &engine.uncountables,
    )
}

#[inline(never)]
pub fn singular(word: &str) -> String {
    let engine = engine();
    replace_word(
        word,
        &engine.irregular_plurals,
        &engine.irregular_singles,
        &engine.singular_rules,
        &engine.uncountables,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_npm_for_words_the_parser_uses() {
        assert_eq!(singular("users"), "user");
        assert_eq!(plural("user"), "users");
        assert_eq!(singular("addresses"), "address");
        assert_eq!(plural("address"), "addresses");
        assert_eq!(singular("contact_groups").split('_').next_back(), Some("group"));
        assert_eq!(plural("group"), "groups");
        assert_eq!(singular("people"), "person");
        assert_eq!(plural("person"), "people");
        assert_eq!(singular("children"), "child");
        assert_eq!(plural("child"), "children");
        assert_eq!(plural("User"), "Users");
        assert_eq!(plural("USER"), "USERS");
        assert_eq!(plural("users"), "users");
        assert_eq!(singular("user"), "user");
        assert_eq!(plural("sheep"), "sheep");
        assert_eq!(singular("fish"), "fish");
        assert_eq!(plural("health"), "health");
        assert_eq!(plural(""), "");
        assert_eq!(singular(""), "");
        assert_eq!(plural("alumnus"), "alumni");
        assert_eq!(singular("alumni"), "alumnus");
        assert_eq!(plural("agendum"), "agenda");
        assert_eq!(singular("agenda"), "agenda");
        assert_eq!(plural("bacterium"), "bacteria");
        assert_eq!(singular("bacteria"), "bacterium");
        assert_eq!(plural("criterion"), "criteria");
        assert_eq!(singular("criteria"), "criterion");
        assert_eq!(plural("phenomenon"), "phenomena");
        assert_eq!(singular("phenomena"), "phenomenon");
        assert_eq!(plural("knife"), "knives");
        assert_eq!(singular("knives"), "knife");
        assert_eq!(plural("zombie"), "zombies");
        assert_eq!(singular("zombies"), "zombie");
        assert_eq!(plural("alias"), "aliases");
        assert_eq!(singular("aliases"), "alias");
        assert_eq!(plural("quiz"), "quizzes");
        assert_eq!(singular("quizzes"), "quiz");
        assert_eq!(plural("foot"), "feet");
        assert_eq!(singular("Feet"), "Foot");
        assert_eq!(plural("them"), "them");
        assert_eq!(singular("analysis"), "analysis");
        assert_eq!(plural("analysis"), "analyses");
        assert_eq!(restore_case("aB", "XY"), "xy");
        assert_eq!(restore_case("Ab", ""), "");
        let empty_at_start = Rule {
            pattern: Regex::new("^").unwrap(),
            replacement: "x",
        };
        assert_eq!(apply_rule("Hello", &empty_at_start).as_deref(), Some("xHello"));
        let boom = std::panic::catch_unwind(|| regex("("));
        assert!(boom.is_err());
    }
}
