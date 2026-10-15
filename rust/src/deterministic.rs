use std::collections::HashSet;

use indexmap::IndexMap;

use crate::specification::{
    CustomRouteEntry, CustomServiceEntry, DatasourceTable, ParsedRoutes,
    ParsedServices, SeedRow, Type,
};

pub const HEALTH_SERVICE_NAME: &str = "HealthCheckService";
pub const HEALTH_SERVICE_METHOD: &str = "check";
pub const HEALTH_ROUTE_NAME: &str = "getHealth";
pub const HEALTH_ROUTE_PATH: &str = "/api/health";

#[derive(Debug, Clone, PartialEq)]
pub struct Deterministic {
    pub types: Vec<Type>,
    pub expanded_types: Vec<Type>,
    pub datasource: Vec<DatasourceTable>,
    pub datasource_seeds: IndexMap<String, Vec<SeedRow>>,
    pub services: ParsedServices,
    pub routes: ParsedRoutes,
}

impl Deterministic {
    pub fn new(
        types: Vec<Type>,
        expanded_types: Vec<Type>,
        datasource: Vec<DatasourceTable>,
        datasource_seeds: IndexMap<String, Vec<SeedRow>>,
        services: ParsedServices,
        routes: ParsedRoutes,
    ) -> Self {
        Self {
            types,
            expanded_types,
            datasource,
            datasource_seeds,
            services,
            routes,
        }
    }
}

fn seed_service() -> CustomServiceEntry {
    CustomServiceEntry {
        name: HEALTH_SERVICE_NAME.to_string(),
        module: None,
        methods: vec![HEALTH_SERVICE_METHOD.to_string()],
    }
}

fn seed_route() -> CustomRouteEntry {
    CustomRouteEntry {
        name: HEALTH_ROUTE_NAME.to_string(),
        path: Some(HEALTH_ROUTE_PATH.to_string()),
        method: Some("GET".to_string()),
        entity: None,
        request: None,
        response: None,
        module: None,
        route_class: None,
    }
}

fn prepend<T: Clone>(list: Vec<T>, index: Option<usize>, seed: T) -> Vec<T> {
    match index {
        Some(0) => list,
        Some(idx) => {
            let mut out = Vec::with_capacity(list.len());
            out.push(list[idx].clone());
            out.extend(list.iter().take(idx).cloned());
            out.extend(list.into_iter().skip(idx + 1));
            out
        }
        None => {
            let mut out = Vec::with_capacity(list.len() + 1);
            out.push(seed);
            out.extend(list);
            out
        }
    }
}

/// Product default: HealthCheckService + GET /api/health first in customs.
pub fn ensure_health(deterministic: Deterministic) -> Deterministic {
    let service_index = deterministic
        .services
        .customs
        .iter()
        .position(|service| service.name == HEALTH_SERVICE_NAME);
    let route_index = deterministic
        .routes
        .customs
        .iter()
        .position(|route| route.path.as_deref() == Some(HEALTH_ROUTE_PATH));
    let services = ParsedServices {
        generics: deterministic.services.generics,
        customs: prepend(deterministic.services.customs, service_index, seed_service()),
    };
    let routes = ParsedRoutes {
        candidates: deterministic.routes.candidates,
        customs: prepend(deterministic.routes.customs, route_index, seed_route()),
        nested: deterministic.routes.nested,
        children_only: deterministic.routes.children_only,
        datasource: deterministic.routes.datasource,
    };
    Deterministic {
        types: deterministic.types,
        expanded_types: deterministic.expanded_types,
        datasource: deterministic.datasource,
        datasource_seeds: deterministic.datasource_seeds,
        services,
        routes,
    }
}

pub fn empty_routes(datasource: Vec<DatasourceTable>) -> ParsedRoutes {
    ParsedRoutes {
        candidates: Vec::new(),
        customs: Vec::new(),
        nested: Vec::new(),
        children_only: HashSet::new(),
        datasource,
    }
}

pub fn empty_services() -> ParsedServices {
    ParsedServices {
        generics: Vec::new(),
        customs: Vec::new(),
    }
}
