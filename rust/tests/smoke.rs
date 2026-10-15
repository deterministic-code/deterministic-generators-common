use std::collections::HashMap;

use deterministic_generators_common::{
    memory_reader, DatasourceSeedsValidator, DatasourceValidator, DeterministicParser,
    FrontendBindingsValidator, RoutesApiValidator, RoutesValidator, ServicesValidator,
    TypesValidator, TYPES_YAML,
};

const VALID: &str = "version: 1.0.0
types:
  - user:
      fields:
        - email:
            type: string
";

#[test]
fn types_document_validates_and_parses() {
    let result = TypesValidator::new().validate(VALID);
    assert!(result.valid, "{:?}", result.errors);
    let mut files = HashMap::new();
    files.insert(TYPES_YAML.to_string(), VALID.to_string());
    let parsed = DeterministicParser::new(memory_reader(files))
        .parse(&HashMap::new())
        .expect("parse");
    assert!(parsed.services.customs.iter().any(|service| service.name == "HealthCheckService"));
    assert!(parsed.routes.customs.iter().any(|route| route.path.as_deref() == Some("/api/health")));
}

#[test]
fn facades_accept_minimal_documents() {
    assert!(DatasourceValidator::new().validate("version: 1.0.0\ntypes: []\n").valid);
    assert!(DatasourceSeedsValidator::new().validate("version: 1.0.0\nseeds: []\n").valid);
    assert!(ServicesValidator::new().validate("version: 1.0.0\nservices: []\n").valid);
    assert!(RoutesValidator::new().validate("version: 1.0.0\nroutes: []\n").valid);
    assert!(RoutesApiValidator::new().validate("version: 1.0.0\nroutes: []\ncomponents: {}\n").valid);
    assert!(FrontendBindingsValidator::new().validate("version: 1.0.0\ndatasources: []\n").valid);
}

#[test]
fn missing_version_is_reported() {
    let result = TypesValidator::new().validate("types: []\n");
    assert!(!result.valid);
    let message = &result.errors[0].message;
    assert!(
        message.contains("required property 'version'") || message.contains("missing required property version"),
        "{message}"
    );
}
