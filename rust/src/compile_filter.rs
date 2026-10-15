use regex::Regex;

use crate::error::Error;

const ACCESSORS: &[&str] = &["type", "tag", "inherits"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilterCandidate {
    pub name: String,
    pub tags: Vec<String>,
    pub inherits: Option<String>,
}

pub type FilterPredicate = Box<dyn Fn(&FilterCandidate) -> bool + Send + Sync>;

#[derive(Debug, Clone, PartialEq)]
enum Val {
    Bool(bool),
    Null,
    Undefined,
    Num(f64),
    Str(String),
    Name,
    Inherits,
    Tags,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CmpOp {
    Eq,
    StrictEq,
    Ne,
    StrictNe,
}

#[derive(Debug, Clone)]
enum Expr {
    Lit(Val),
    Not(Box<Expr>),
    And(Box<Expr>, Box<Expr>),
    Or(Box<Expr>, Box<Expr>),
    Cmp(CmpOp, Box<Expr>, Box<Expr>),
    Includes(Box<Expr>, Box<Expr>),
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Ident(String),
    Str(String),
    Num(f64),
    Eq,
    StrictEq,
    Ne,
    StrictNe,
    And,
    Or,
    Not,
    LParen,
    RParen,
    Dot,
    Eof,
}

pub fn compile_types_filter(filter_expr: Option<&str>) -> Result<FilterPredicate, Error> {
    compile_filter(filter_expr, "types.filter")
}

pub fn compile_filter(filter_expr: Option<&str>, context_label: &str) -> Result<FilterPredicate, Error> {
    let Some(filter_expr) = filter_expr.filter(|value| !value.is_empty()) else {
        return Ok(Box::new(|_| true));
    };
    let mut placeholders = Vec::new();
    let string_re = Regex::new(r#""[^"]*""#).expect("string regex");
    let with_strings = string_re
        .replace_all(filter_expr, |caps: &regex::Captures<'_>| {
            let index = placeholders.len();
            placeholders.push(caps.get(0).unwrap().as_str().to_string());
            format!("__STR{index}__")
        })
        .into_owned();
    let rewritten = rewrite_dsl(&with_strings);
    assert_known_idents(&rewritten, context_label)?;
    let restored = restore_strings(&rewritten, &placeholders);
    let expr = parse_expr(&restored).map_err(|message| {
        Error::new(format!("{context_label} is not a valid expression: {message}"))
    })?;
    Ok(Box::new(move |cand| truthy(&eval(&expr, cand))))
}

fn rewrite_dsl(input: &str) -> String {
    let type_re = Regex::new(r"\btype\s*(==|!=)\s*(__STR\d+__)").unwrap();
    let step = type_re.replace_all(input, |caps: &regex::Captures<'_>| {
        let op = if &caps[1] == "==" { "===" } else { "!==" };
        format!("(__name {op} {})", &caps[2])
    });
    let tag_eq = Regex::new(r"\btag\s*==\s*(__STR\d+__)").unwrap();
    let step = tag_eq.replace_all(&step, |caps: &regex::Captures<'_>| {
        format!("__tags.includes({})", &caps[1])
    });
    let tag_ne = Regex::new(r"\btag\s*!=\s*(__STR\d+__)").unwrap();
    let step = tag_ne.replace_all(&step, |caps: &regex::Captures<'_>| {
        format!("!__tags.includes({})", &caps[1])
    });
    let inherits_re = Regex::new(r"\binherits\s*(==|!=)\s*(__STR\d+__)").unwrap();
    inherits_re
        .replace_all(&step, |caps: &regex::Captures<'_>| {
            let op = if &caps[1] == "==" { "===" } else { "!==" };
            format!("(__inherits {op} {})", &caps[2])
        })
        .into_owned()
}

fn assert_known_idents(source: &str, context_label: &str) -> Result<(), Error> {
    let ident_re = Regex::new(r"[A-Za-z_][A-Za-z0-9_]*").unwrap();
    let allowed = [
        "__name",
        "__tags",
        "__inherits",
        "includes",
        "true",
        "false",
        "null",
        "undefined",
        "type",
        "tag",
        "inherits",
    ];
    for ident in ident_re.find_iter(source) {
        let text = ident.as_str();
        if text.starts_with("__STR") || allowed.contains(&text) {
            continue;
        }
        return Err(Error::new(format!(
            "{context_label}: unknown identifier or syntax near \"{text}\". Supported: `type == \"name\"`, `tag == \"kind\"`, `inherits == \"parent\"`, logical && / ||, parens."
        )));
    }
    let _ = ACCESSORS;
    Ok(())
}

fn restore_strings(source: &str, placeholders: &[String]) -> String {
    let re = Regex::new(r"__STR(\d+)__").unwrap();
    re.replace_all(source, |caps: &regex::Captures<'_>| {
        let index: usize = caps[1].parse().unwrap_or(0);
        placeholders.get(index).cloned().unwrap_or_default()
    })
    .into_owned()
}

struct Lexer<'a> {
    source: &'a str,
    index: usize,
}

impl<'a> Lexer<'a> {
    fn new(source: &'a str) -> Self {
        Self { source, index: 0 }
    }

    fn peek(&self) -> Option<char> {
        self.source[self.index..].chars().next()
    }

    fn bump(&mut self) -> Option<char> {
        let ch = self.peek()?;
        self.index += ch.len_utf8();
        Some(ch)
    }

    fn starts_with(&self, text: &str) -> bool {
        self.source[self.index..].starts_with(text)
    }

    fn tokenize(mut self) -> Result<Vec<Tok>, String> {
        let mut tokens = Vec::new();
        while let Some(ch) = self.peek() {
            if ch.is_whitespace() {
                self.bump();
                continue;
            }
            if self.starts_with("===") {
                self.index += 3;
                tokens.push(Tok::StrictEq);
                continue;
            }
            if self.starts_with("!==") {
                self.index += 3;
                tokens.push(Tok::StrictNe);
                continue;
            }
            if self.starts_with("==") {
                self.index += 2;
                tokens.push(Tok::Eq);
                continue;
            }
            if self.starts_with("!=") {
                self.index += 2;
                tokens.push(Tok::Ne);
                continue;
            }
            if self.starts_with("&&") {
                self.index += 2;
                tokens.push(Tok::And);
                continue;
            }
            if self.starts_with("||") {
                self.index += 2;
                tokens.push(Tok::Or);
                continue;
            }
            match ch {
                '!' => {
                    self.bump();
                    tokens.push(Tok::Not);
                }
                '(' => {
                    self.bump();
                    tokens.push(Tok::LParen);
                }
                ')' => {
                    self.bump();
                    tokens.push(Tok::RParen);
                }
                '.' => {
                    self.bump();
                    tokens.push(Tok::Dot);
                }
                '"' => tokens.push(self.string()?),
                '0'..='9' => tokens.push(self.number()?),
                ch if ch == '_' || ch.is_ascii_alphabetic() => tokens.push(self.ident()),
                _ => return Err("Unexpected token ')'".to_string()),
            }
        }
        tokens.push(Tok::Eof);
        Ok(tokens)
    }

    fn string(&mut self) -> Result<Tok, String> {
        self.bump();
        let start = self.index;
        while let Some(ch) = self.peek() {
            if ch == '"' {
                let text = self.source[start..self.index].to_string();
                self.bump();
                return Ok(Tok::Str(text));
            }
            self.bump();
        }
        Err("Unexpected token ')'".to_string())
    }

    fn number(&mut self) -> Result<Tok, String> {
        let start = self.index;
        while self.peek().is_some_and(|ch| ch.is_ascii_digit()) {
            self.bump();
        }
        if self.peek() == Some('.') {
            let after = self.source[self.index + 1..].chars().next();
            if after.is_some_and(|ch| ch.is_ascii_digit()) {
                self.bump();
                while self.peek().is_some_and(|ch| ch.is_ascii_digit()) {
                    self.bump();
                }
            }
        }
        let text = &self.source[start..self.index];
        let value = text.parse::<f64>().map_err(|_| "Unexpected token ')'".to_string())?;
        Ok(Tok::Num(value))
    }

    fn ident(&mut self) -> Tok {
        let start = self.index;
        while self
            .peek()
            .is_some_and(|ch| ch == '_' || ch.is_ascii_alphanumeric())
        {
            self.bump();
        }
        Tok::Ident(self.source[start..self.index].to_string())
    }
}

struct Parser {
    tokens: Vec<Tok>,
    index: usize,
}

impl Parser {
    fn parse(source: &str) -> Result<Expr, String> {
        let tokens = Lexer::new(source).tokenize()?;
        let mut parser = Parser { tokens, index: 0 };
        let expr = parser.parse_or()?;
        if !matches!(parser.peek(), Tok::Eof) {
            return Err("Unexpected token ')'".to_string());
        }
        Ok(expr)
    }

    fn peek(&self) -> &Tok {
        self.tokens.get(self.index).unwrap_or(&Tok::Eof)
    }

    fn bump(&mut self) -> Tok {
        let tok = self.peek().clone();
        if !matches!(tok, Tok::Eof) {
            self.index += 1;
        }
        tok
    }

    fn parse_or(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_and()?;
        while matches!(self.peek(), Tok::Or) {
            self.bump();
            let right = self.parse_and()?;
            left = Expr::Or(Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_and(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_unary()?;
        while matches!(self.peek(), Tok::And) {
            self.bump();
            let right = self.parse_unary()?;
            left = Expr::And(Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_unary(&mut self) -> Result<Expr, String> {
        if matches!(self.peek(), Tok::Not) {
            self.bump();
            return Ok(Expr::Not(Box::new(self.parse_unary()?)));
        }
        self.parse_cmp()
    }

    fn parse_cmp(&mut self) -> Result<Expr, String> {
        let left = self.parse_primary()?;
        let op = match self.peek() {
            Tok::Eq => CmpOp::Eq,
            Tok::StrictEq => CmpOp::StrictEq,
            Tok::Ne => CmpOp::Ne,
            Tok::StrictNe => CmpOp::StrictNe,
            _ => return Ok(left),
        };
        self.bump();
        let right = self.parse_primary()?;
        Ok(Expr::Cmp(op, Box::new(left), Box::new(right)))
    }

    fn parse_primary(&mut self) -> Result<Expr, String> {
        match self.bump() {
            Tok::Num(value) => Ok(Expr::Lit(Val::Num(value))),
            Tok::Str(value) => Ok(Expr::Lit(Val::Str(value))),
            Tok::LParen => {
                let inner = self.parse_or()?;
                if !matches!(self.peek(), Tok::RParen) {
                    return Err("Unexpected token ')'".to_string());
                }
                self.bump();
                Ok(inner)
            }
            Tok::Ident(name) => self.finish_ident(name),
            _ => Err("Unexpected token ')'".to_string()),
        }
    }

    fn finish_ident(&mut self, name: String) -> Result<Expr, String> {
        let expr = match name.as_str() {
            "true" => Expr::Lit(Val::Bool(true)),
            "false" => Expr::Lit(Val::Bool(false)),
            "null" => Expr::Lit(Val::Null),
            "undefined" => Expr::Lit(Val::Undefined),
            "__name" => Expr::Lit(Val::Name),
            "__inherits" => Expr::Lit(Val::Inherits),
            "__tags" => Expr::Lit(Val::Tags),
            _ => Expr::Lit(Val::Str(format!("__ref:{name}"))),
        };
        if matches!(self.peek(), Tok::Dot) {
            self.bump();
            let Tok::Ident(method) = self.bump() else {
                return Err("Unexpected token ')'".to_string());
            };
            if method != "includes" || !matches!(self.peek(), Tok::LParen) {
                return Err("Unexpected token ')'".to_string());
            }
            self.bump();
            let arg = self.parse_or()?;
            if !matches!(self.peek(), Tok::RParen) {
                return Err("Unexpected token ')'".to_string());
            }
            self.bump();
            return Ok(Expr::Includes(Box::new(expr), Box::new(arg)));
        }
        Ok(expr)
    }
}

fn parse_expr(source: &str) -> Result<Expr, String> {
    Parser::parse(source)
}

#[inline(never)]
fn truthy(value: &Val) -> bool {
    match value {
        Val::Bool(value) => *value,
        Val::Null | Val::Undefined => false,
        Val::Num(value) => *value != 0.0 && value.is_finite(),
        Val::Str(value) => !value.is_empty() && !value.starts_with("__ref:"),
        _ => true,
    }
}

fn eval(expr: &Expr, cand: &FilterCandidate) -> Val {
    match expr {
        Expr::Lit(Val::Name) => Val::Str(cand.name.clone()),
        Expr::Lit(Val::Inherits) => Val::Str(cand.inherits.clone().unwrap_or_default()),
        Expr::Lit(value) => value.clone(),
        Expr::Not(inner) => Val::Bool(!truthy(&eval(inner, cand))),
        Expr::And(left, right) => {
            let left = eval(left, cand);
            if !truthy(&left) {
                left
            } else {
                eval(right, cand)
            }
        }
        Expr::Or(left, right) => {
            let left = eval(left, cand);
            if truthy(&left) {
                left
            } else {
                eval(right, cand)
            }
        }
        Expr::Cmp(op, left, right) => {
            let left = eval(left, cand);
            let right = eval(right, cand);
            Val::Bool(compare(*op, &left, &right))
        }
        Expr::Includes(receiver, arg) => {
            let receiver = eval(receiver, cand);
            let arg = eval(arg, cand);
            Val::Bool(includes(&receiver, &arg, cand))
        }
    }
}

#[inline(never)]
fn includes(receiver: &Val, arg: &Val, cand: &FilterCandidate) -> bool {
    let Val::Str(needle) = arg else {
        return false;
    };
    match receiver {
        Val::Tags => cand.tags.iter().any(|tag| tag == needle),
        Val::Str(haystack) => haystack.contains(needle.as_str()),
        _ => false,
    }
}

fn compare(op: CmpOp, left: &Val, right: &Val) -> bool {
    let strict = matches!(op, CmpOp::StrictEq | CmpOp::StrictNe);
    let equal = values_equal(left, right, strict);
    match op {
        CmpOp::Eq | CmpOp::StrictEq => equal,
        CmpOp::Ne | CmpOp::StrictNe => !equal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpreter_covers_remaining_operators() {
        let pred = |expr: &str| parse_expr(expr).map(|expr| truthy(&eval(&expr, &FilterCandidate { name: "user".into(), tags: vec!["view".into()], inherits: Some("set".into()) })));
        assert_eq!(pred("null").unwrap(), false);
        assert_eq!(pred("2").unwrap(), true);
        assert_eq!(pred("1 != 2").unwrap(), true);
        assert_eq!(pred("1 !== 1").unwrap(), false);
        assert!(parse_expr("\"unterminated").is_err());
        assert!(parse_expr("1. == 1").is_err() || pred("1. == 1").is_err());
        assert!(parse_expr("1 == 1 1").is_err());
        assert_eq!(pred("mystery").unwrap(), false);
        assert!(parse_expr("__tags.(").is_err());
        assert_eq!(pred("null === undefined").unwrap(), false);
        assert_eq!(pred("null == undefined").unwrap(), true);
        assert_eq!(pred("\"\"").unwrap(), false);
        assert_eq!(pred("0").unwrap(), false);
        assert_eq!(pred("__name.includes(1)").unwrap(), false);
        assert_eq!(pred("\"user\".includes(\"u\")").ok(), None);
    }
}

#[inline(never)]
fn values_equal(left: &Val, right: &Val, strict: bool) -> bool {
    match (left, right) {
        (Val::Null, Val::Null) | (Val::Undefined, Val::Undefined) => true,
        (Val::Null, Val::Undefined) | (Val::Undefined, Val::Null) => !strict,
        (Val::Bool(a), Val::Bool(b)) => a == b,
        (Val::Num(a), Val::Num(b)) => a == b,
        (Val::Str(a), Val::Str(b)) => a == b,
        (Val::Num(number), Val::Str(text)) | (Val::Str(text), Val::Num(number)) if !strict => {
            text.parse::<f64>().ok().is_some_and(|parsed| parsed == *number)
        }
        (Val::Bool(flag), Val::Num(number)) | (Val::Num(number), Val::Bool(flag)) if !strict => {
            (*flag as i32 as f64) == *number
        }
        _ => false,
    }
}
