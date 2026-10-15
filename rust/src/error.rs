use std::fmt;

/// Error whose display text matches the TypeScript `Error.message`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub String);

impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_and_std_error() {
        let err = Error::new("hello");
        assert_eq!(err.to_string(), "hello");
        assert_eq!(format!("{err:?}"), "Error(\"hello\")");
        let boxed: Box<dyn std::error::Error> = Box::new(err.clone());
        assert_eq!(boxed.to_string(), "hello");
        assert_eq!(err, Error("hello".into()));
    }
}
