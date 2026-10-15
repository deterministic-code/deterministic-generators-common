mod catalog;
mod datasource_model;
mod defaults;
mod include;
mod models;
mod positions;
mod resolve;
mod schema;
mod seeds;
mod type_model;

#[cfg(test)]
mod samples_test;
#[cfg(test)]
mod parity_test;
#[cfg(test)]
mod semantics_parity;

use std::sync::Arc;

pub use catalog::{load_field_type_catalog, parse_field_type_catalog};
pub use datasource_model::{check_datasource, with_sibling_types};
pub use defaults::check_field_default_semantics;
pub use include::{check_include_cycles, check_include_filters, match_types_filter};
pub use models::{check_route_model, check_service_model};
pub use positions::{entries, parse_yaml_with_positions, single_key, string_list};
pub use resolve::{
    find_ancestor_path, find_spec_path, resolve_spec_path, spec_rel_path, SPEC_FILES,
};
pub use schema::{
    ajv_from_kind, error_from_unknown, format_ajv_error, yaml_error_offset, AjvError,
    SpecValidationError, SpecValidationResult, SpecValidator, ValidateOptions,
};
pub use seeds::{check_seeds, seeds_need_companions, with_sibling_companions};
pub use type_model::{check_type_model, index_type_fields};

use include::with_include_file_path;
use schema::AfterSchemaFn;

fn boxed(check: fn(&positions::ParsedYaml, &ValidateOptions) -> SpecValidationResult) -> AfterSchemaFn {
    Box::new(check)
}

pub struct TypesValidator(SpecValidator);
pub struct DatasourceValidator(SpecValidator);
pub struct DatasourceSeedsValidator(SpecValidator);
pub struct RoutesValidator(SpecValidator);
pub struct RoutesApiValidator(SpecValidator);
pub struct ServicesValidator(SpecValidator);
pub struct FrontendBindingsValidator(SpecValidator);

impl TypesValidator {
    pub fn new() -> Self {
        Self(
            SpecValidator::from_ref("backend", "types.spec.yaml")
                .with_after(vec![
                    boxed(check_field_default_semantics),
                    boxed(check_type_model),
                    boxed(check_include_filters),
                    boxed(check_include_cycles),
                ])
                .with_file_options(Box::new(include_file_options)),
        )
    }
    pub fn validate(&self, text: &str) -> SpecValidationResult {
        self.0.validate(text, &ValidateOptions::default())
    }
    pub fn validate_file(&self, path: &str) -> Result<SpecValidationResult, String> {
        self.0.validate_file(path, &ValidateOptions::default())
    }
}

fn include_file_options(path: &str, options: &ValidateOptions) -> ValidateOptions {
    with_include_file_path(path, options)
}

fn datasource_file_options(path: &str, options: &ValidateOptions) -> ValidateOptions {
    with_sibling_types(path, options)
}

fn seeds_file_options(path: &str, options: &ValidateOptions) -> ValidateOptions {
    with_sibling_companions(path, options)
}

impl Default for TypesValidator {
    fn default() -> Self {
        Self::new()
    }
}

impl DatasourceValidator {
    pub fn new() -> Self {
        Self(
            SpecValidator::from_ref("backend", "datasource.spec.yaml")
                .with_after(vec![
                    boxed(check_datasource),
                    boxed(check_include_filters),
                    boxed(check_include_cycles),
                ])
                .with_file_options(Box::new(datasource_file_options)),
        )
    }
    pub fn validate(&self, text: &str) -> SpecValidationResult {
        self.0.validate(text, &ValidateOptions::default())
    }
    pub fn validate_with(&self, text: &str, options: &ValidateOptions) -> SpecValidationResult {
        self.0.validate(text, options)
    }
    pub fn validate_file(&self, path: &str) -> Result<SpecValidationResult, String> {
        self.0.validate_file(path, &ValidateOptions::default())
    }
}

impl DatasourceSeedsValidator {
    pub fn new() -> Self {
        Self(
            SpecValidator::from_ref("backend", "datasource-seeds.spec.yaml")
                .with_after(vec![boxed(check_seeds)])
                .with_file_options(Box::new(seeds_file_options)),
        )
    }
    pub fn validate(&self, text: &str) -> SpecValidationResult {
        self.0.validate(text, &ValidateOptions::default())
    }
    pub fn validate_with(&self, text: &str, options: &ValidateOptions) -> SpecValidationResult {
        self.0.validate(text, options)
    }
    pub fn validate_file(&self, path: &str) -> Result<SpecValidationResult, String> {
        self.0.validate_file(path, &ValidateOptions::default())
    }
}

impl RoutesValidator {
    pub fn new() -> Self {
        Self(
            SpecValidator::from_ref("backend", "routes.spec.yaml")
                .with_after(vec![
                    boxed(check_route_model),
                    boxed(check_include_filters),
                    boxed(check_include_cycles),
                ])
                .with_file_options(Box::new(include_file_options)),
        )
    }
    pub fn validate(&self, text: &str) -> SpecValidationResult {
        self.0.validate(text, &ValidateOptions::default())
    }
    pub fn validate_file(&self, path: &str) -> Result<SpecValidationResult, String> {
        self.0.validate_file(path, &ValidateOptions::default())
    }
}

impl RoutesApiValidator {
    pub fn new() -> Self {
        Self(
            SpecValidator::from_ref("backend", "routes-api.spec.yaml").with_after(vec![boxed(check_route_model)]),
        )
    }
    pub fn validate(&self, text: &str) -> SpecValidationResult {
        self.0.validate(text, &ValidateOptions::default())
    }
    pub fn validate_file(&self, path: &str) -> Result<SpecValidationResult, String> {
        self.0.validate_file(path, &ValidateOptions::default())
    }
}

impl ServicesValidator {
    pub fn new() -> Self {
        Self(
            SpecValidator::from_ref("backend", "services.spec.yaml")
                .with_after(vec![
                    boxed(check_service_model),
                    boxed(check_include_filters),
                    boxed(check_include_cycles),
                ])
                .with_file_options(Box::new(include_file_options)),
        )
    }
    pub fn validate(&self, text: &str) -> SpecValidationResult {
        self.0.validate(text, &ValidateOptions::default())
    }
    pub fn validate_file(&self, path: &str) -> Result<SpecValidationResult, String> {
        self.0.validate_file(path, &ValidateOptions::default())
    }
}

impl FrontendBindingsValidator {
    pub fn new() -> Self {
        Self(SpecValidator::from_ref("frontend", "bindings.spec.yaml"))
    }
    pub fn validate(&self, text: &str) -> SpecValidationResult {
        self.0.validate(text, &ValidateOptions::default())
    }
    pub fn validate_file(&self, path: &str) -> Result<SpecValidationResult, String> {
        self.0.validate_file(path, &ValidateOptions::default())
    }
}

pub fn spec_validator_ref(subdir: &str, name: &str) -> SpecValidator {
    SpecValidator::from_ref(subdir, name)
}

pub fn spec_validator_path(path: impl Into<String>) -> SpecValidator {
    SpecValidator::from_path(path)
}

pub fn spec_validator_thunk(thunk: impl Fn() -> String + Send + Sync + 'static) -> SpecValidator {
    SpecValidator::from_thunk(thunk)
}

pub fn shared_types_validator() -> Arc<TypesValidator> {
    Arc::new(TypesValidator::new())
}

impl Default for DatasourceValidator {
    fn default() -> Self {
        Self::new()
    }
}
impl Default for DatasourceSeedsValidator {
    fn default() -> Self {
        Self::new()
    }
}
impl Default for RoutesValidator {
    fn default() -> Self {
        Self::new()
    }
}
impl Default for RoutesApiValidator {
    fn default() -> Self {
        Self::new()
    }
}
impl Default for ServicesValidator {
    fn default() -> Self {
        Self::new()
    }
}
impl Default for FrontendBindingsValidator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod facade_defaults {
    use super::*;

    #[test]
    fn constructors_and_defaults() {
        let _ = TypesValidator::default();
        let _ = DatasourceValidator::default();
        let _ = DatasourceSeedsValidator::default();
        let _ = RoutesValidator::default();
        let _ = RoutesApiValidator::default();
        let _ = ServicesValidator::default();
        let _ = FrontendBindingsValidator::default();
        let _ = shared_types_validator();
        let opts = ValidateOptions::default();
        let v = spec_validator_ref("backend", "app.spec.yaml");
        let r = v.validate("version: \"1.0.0\"\n", &opts);
        let _ = r.valid;
        let missing = spec_validator_path("/no/such/spec.yaml");
        let _ = missing.validate("version: \"1.0.0\"\n", &opts);
        let thunk = spec_validator_thunk(|| {
            resolve_spec_path(
                "backend",
                "types.spec.yaml",
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")),
            )
            .unwrap()
            .display()
            .to_string()
        });
        let _ = thunk.validate("version: \"1.0.0\"\ntypes: []\n", &opts);
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let _ = TypesValidator::new().validate_file(tmp.path().to_str().unwrap());
        let _ = DatasourceValidator::new().validate_file(tmp.path().to_str().unwrap());
        let _ = DatasourceSeedsValidator::new().validate_file(tmp.path().to_str().unwrap());
        let _ = RoutesValidator::new().validate_file(tmp.path().to_str().unwrap());
        let _ = RoutesApiValidator::new().validate_file(tmp.path().to_str().unwrap());
        let _ = ServicesValidator::new().validate_file(tmp.path().to_str().unwrap());
        let _ = FrontendBindingsValidator::new().validate_file(tmp.path().to_str().unwrap());
        let _ = DatasourceValidator::new().validate_with("version: \"1.0.0\"\ntypes: []\n", &ValidateOptions::default());
        let _ = DatasourceSeedsValidator::new().validate_with("version: \"1.0.0\"\nseeds: []\n", &ValidateOptions::default());
    }
}
