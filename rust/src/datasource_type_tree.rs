use std::collections::{HashMap, HashSet};

use std::ops::{Deref, DerefMut};

use indexmap::IndexMap;
use serde::Serialize;

use crate::specification::Type;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct DatasourceTypeTree(pub IndexMap<String, DatasourceTypeTree>);

impl Deref for DatasourceTypeTree {
    type Target = IndexMap<String, DatasourceTypeTree>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl DerefMut for DatasourceTypeTree {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DatasourceTypeGraphEdge {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DatasourceTypeGraph {
    pub nodes: Vec<String>,
    pub edges: Vec<DatasourceTypeGraphEdge>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatasourceTypeHierarchies {
    pub first_parent_tree: DatasourceTypeTree,
    pub all_parents_tree: DatasourceTypeTree,
    pub graph: DatasourceTypeGraph,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MultiParent {
    First,
    All,
}

const ROOT: &str = "root";

fn ref_targets(references: &crate::specification::References) -> Vec<String> {
    let raw = match references {
        crate::specification::References::One(value) => vec![value.clone()],
        crate::specification::References::Pair(left, right) => vec![left.clone(), right.clone()],
    };
    raw.into_iter()
        .map(|item| item.split('.').next().unwrap_or("").to_string())
        .collect()
}

fn referenced_parents(type_def: &Type, type_names: &HashSet<String>) -> Vec<String> {
    let mut parents = Vec::new();
    let mut seen = HashSet::new();
    for field in &type_def.fields {
        let Some(references) = &field.references else {
            continue;
        };
        for parent in ref_targets(references) {
            if parent.is_empty() || parent == type_def.name || !type_names.contains(&parent) || seen.contains(&parent)
            {
                continue;
            }
            seen.insert(parent.clone());
            parents.push(parent);
        }
    }
    parents
}

fn add_child(children: &mut IndexMap<String, Vec<String>>, parent: &str, child: &str) {
    let list = children.entry(parent.to_string()).or_default();
    if !list.iter().any(|item| item == child) {
        list.push(child.to_string());
    }
}

struct Tarjan {
    index: usize,
    scc_count: usize,
    indices: HashMap<String, usize>,
    lows: HashMap<String, usize>,
    stack: Vec<String>,
    on_stack: HashSet<String>,
    scc_id: HashMap<String, usize>,
    parents: HashMap<String, Vec<String>>,
}

impl Tarjan {
    fn connect(&mut self, name: String) {
        let index = self.index;
        self.indices.insert(name.clone(), index);
        self.lows.insert(name.clone(), index);
        self.index += 1;
        self.stack.push(name.clone());
        self.on_stack.insert(name.clone());
        let parents = self.parents.get(&name).cloned().unwrap_or_default();
        for parent in parents {
            if !self.indices.contains_key(&parent) {
                self.connect(parent.clone());
                let v_low = self.lows[&name];
                let w_low = self.lows[&parent];
                self.lows.insert(name.clone(), v_low.min(w_low));
            } else if self.on_stack.contains(&parent) {
                let v_low = self.lows[&name];
                let w_index = self.indices[&parent];
                self.lows.insert(name.clone(), v_low.min(w_index));
            }
        }
        if self.lows[&name] == self.indices[&name] {
            loop {
                let item = self.stack.pop().expect("scc stack");
                self.on_stack.remove(&item);
                self.scc_id.insert(item.clone(), self.scc_count);
                if item == name {
                    break;
                }
            }
            self.scc_count += 1;
        }
    }
}

fn strongly_connected(names: &[String], parents: &HashMap<String, Vec<String>>) -> HashMap<String, usize> {
    let mut tarjan = Tarjan {
        index: 0,
        scc_count: 0,
        indices: HashMap::new(),
        lows: HashMap::new(),
        stack: Vec::new(),
        on_stack: HashSet::new(),
        scc_id: HashMap::new(),
        parents: parents.clone(),
    };
    for name in names {
        if !tarjan.indices.contains_key(name) {
            tarjan.connect(name.clone());
        }
    }
    tarjan.scc_id
}

#[inline(never)]
fn sccs_with_external_parent(
    parent_lists: &HashMap<String, Vec<String>>,
    scc_id: &HashMap<String, usize>,
) -> HashSet<usize> {
    let mut has_external = HashSet::new();
    for (name, parents) in parent_lists {
        let from = scc_id[name];
        for parent in parents {
            if let Some(to) = scc_id.get(parent) {
                if *to != from {
                    has_external.insert(from);
                }
            }
        }
    }
    has_external
}

fn build_node(
    children: &IndexMap<String, Vec<String>>,
    name: &str,
    path: &HashSet<String>,
) -> DatasourceTypeTree {
    let mut node = DatasourceTypeTree::default();
    for child in children.get(name).into_iter().flatten() {
        if path.contains(child) {
            continue;
        }
        let mut next = path.clone();
        next.insert(child.clone());
        node.insert(child.clone(), build_node(children, child, &next));
    }
    node
}

fn chosen_parents(types: &[Type], multi_parent: MultiParent) -> HashMap<String, Vec<String>> {
    let type_names: HashSet<String> = types.iter().map(|type_def| type_def.name.clone()).collect();
    let mut parent_lists = HashMap::new();
    for type_def in types {
        let parents = referenced_parents(type_def, &type_names);
        let chosen = match multi_parent {
            MultiParent::All => parents,
            MultiParent::First => parents.into_iter().take(1).collect(),
        };
        parent_lists.insert(type_def.name.clone(), chosen);
    }
    parent_lists
}

fn build_tree(types: &[Type], parent_lists: &HashMap<String, Vec<String>>) -> DatasourceTypeTree {
    let names: Vec<String> = types.iter().map(|type_def| type_def.name.clone()).collect();
    let scc_id = strongly_connected(&names, parent_lists);
    let has_external = sccs_with_external_parent(parent_lists, &scc_id);
    let mut children: IndexMap<String, Vec<String>> = IndexMap::new();
    for type_def in types {
        let scc = scc_id[&type_def.name];
        if !has_external.contains(&scc) {
            add_child(&mut children, ROOT, &type_def.name);
            continue;
        }
        for parent in &parent_lists[&type_def.name] {
            add_child(&mut children, parent, &type_def.name);
        }
    }
    let mut tree = DatasourceTypeTree::default();
    tree.insert(
        ROOT.to_string(),
        build_node(&children, ROOT, &HashSet::from([ROOT.to_string()])),
    );
    tree
}

pub fn datasource_type_tree(types: &[Type], multi_parent: MultiParent) -> DatasourceTypeTree {
    build_tree(types, &chosen_parents(types, multi_parent))
}

pub fn datasource_type_tree_first(types: &[Type]) -> DatasourceTypeTree {
    datasource_type_tree(types, MultiParent::First)
}

pub fn datasource_type_tree_all(types: &[Type]) -> DatasourceTypeTree {
    datasource_type_tree(types, MultiParent::All)
}

#[inline(never)]
pub fn datasource_type_graph(types: &[Type]) -> DatasourceTypeGraph {
    let parent_lists = chosen_parents(types, MultiParent::All);
    let mut nodes = vec![ROOT.to_string()];
    nodes.extend(types.iter().map(|type_def| type_def.name.clone()));
    let mut edges = Vec::new();
    for type_def in types {
        let parents = &parent_lists[&type_def.name];
        if parents.is_empty() {
            edges.push(DatasourceTypeGraphEdge {
                from: type_def.name.clone(),
                to: ROOT.to_string(),
            });
            continue;
        }
        for parent in parents {
            edges.push(DatasourceTypeGraphEdge {
                from: type_def.name.clone(),
                to: parent.clone(),
            });
        }
    }
    DatasourceTypeGraph { nodes, edges }
}

pub fn datasource_type_hierarchies(types: &[Type]) -> DatasourceTypeHierarchies {
    DatasourceTypeHierarchies {
        first_parent_tree: datasource_type_tree_first(types),
        all_parents_tree: datasource_type_tree_all(types),
        graph: datasource_type_graph(types),
    }
}

pub fn datasource_type_order(types: &[Type]) -> Vec<String> {
    let mut names = Vec::new();
    fn walk(node: &DatasourceTypeTree, names: &mut Vec<String>) {
        for (name, child) in node.iter() {
            names.push(name.clone());
            walk(child, names);
        }
    }
    if let Some(root) = datasource_type_tree_first(types).get(ROOT) {
        walk(root, &mut names);
    }
    names
}

pub fn datasource_type_ancestry(types: &[Type], name: &str) -> Vec<String> {
    let parent_lists = chosen_parents(types, MultiParent::All);
    if !parent_lists.contains_key(name) {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    fn walk(
        current: &str,
        path: &HashSet<String>,
        parent_lists: &HashMap<String, Vec<String>>,
        seen: &mut HashSet<String>,
        out: &mut Vec<String>,
    ) {
        for parent in &parent_lists[current] {
            if path.contains(parent) || seen.contains(parent) {
                continue;
            }
            let mut next = path.clone();
            next.insert(current.to_string());
            walk(parent, &next, parent_lists, seen, out);
            seen.insert(parent.clone());
            out.push(parent.clone());
        }
    }
    walk(name, &HashSet::from([name.to_string()]), &parent_lists, &mut seen, &mut out);
    out
}

pub fn compare_by_datasource_type_order(types: &[Type]) -> impl Fn(&str, &str) -> i32 + '_ {
    compare_by_datasource_type_order_with(types, |_| None)
}

pub fn compare_by_datasource_type_order_with<'a, F>(
    types: &'a [Type],
    inherit_of: F,
) -> impl Fn(&str, &str) -> i32 + 'a
where
    F: Fn(&str) -> Option<String> + 'a,
{
    let order = datasource_type_order(types);
    let rank: HashMap<String, i32> = order
        .iter()
        .enumerate()
        .map(|(index, name)| (name.clone(), index as i32))
        .collect();
    let span = order.len() as i32;
    move |a, b| {
        let key = |name: &str| -> (i32, String) {
            if let Some(direct) = rank.get(name) {
                return (*direct * 2, name.to_string());
            }
            if let Some(inherit) = inherit_of(name) {
                if let Some(&parent) = rank.get(&inherit) {
                    return (parent * 2 + 1, name.to_string());
                }
            }
            (span * 2, name.to_string())
        };
        let (ia, na) = key(a);
        let (ib, nb) = key(b);
        if ia != ib {
            ia - ib
        } else {
            locale_compare(&na, &nb)
        }
    }
}

fn locale_compare(a: &str, b: &str) -> i32 {
    match a.cmp(b) {
        std::cmp::Ordering::Less => -1,
        std::cmp::Ordering::Equal => 0,
        std::cmp::Ordering::Greater => 1,
    }
}

fn write_tree(out: &mut String, tree: &DatasourceTypeTree, indent: usize) {
    let pad = " ".repeat(indent);
    for (key, child) in tree.iter() {
        if child.is_empty() {
            out.push_str(&format!("{pad}{key}: {{}}\n"));
        } else {
            out.push_str(&format!("{pad}{key}:\n"));
            write_tree(out, child, indent + 2);
        }
    }
}

pub fn datasource_type_tree_yaml(tree: &DatasourceTypeTree) -> String {
    let mut out = String::new();
    write_tree(&mut out, tree, 0);
    out
}

pub fn datasource_type_tree_json(tree: &DatasourceTypeTree) -> String {
    format!("{}\n", serde_json::to_string_pretty(tree).unwrap_or_else(|_| "{}".to_string()))
}

fn xml_element(name: &str, children: &DatasourceTypeTree, indent: &str) -> String {
    if children.is_empty() {
        return format!("{indent}<{name}/>\n");
    }
    let inner = children
        .iter()
        .map(|(key, child)| xml_element(key, child, &format!("{indent}  ")))
        .collect::<String>();
    format!("{indent}<{name}>\n{inner}{indent}</{name}>\n")
}

pub fn datasource_type_tree_xml(tree: &DatasourceTypeTree) -> String {
    tree.iter()
        .map(|(key, child)| xml_element(key, child, ""))
        .collect()
}

pub fn datasource_type_graph_yaml(graph: &DatasourceTypeGraph) -> String {
    let mut out = String::from("nodes:\n");
    for name in &graph.nodes {
        out.push_str(&format!("  - {name}\n"));
    }
    out.push_str("edges:\n");
    for edge in &graph.edges {
        out.push_str(&format!("  - from: {}\n    to: {}\n", edge.from, edge.to));
    }
    out
}

pub fn datasource_type_graph_json(graph: &DatasourceTypeGraph) -> String {
    format!("{}\n", serde_json::to_string_pretty(graph).unwrap_or_else(|_| "{}".to_string()))
}

pub fn datasource_type_graph_xml(graph: &DatasourceTypeGraph) -> String {
    let nodes = graph
        .nodes
        .iter()
        .map(|name| format!("    <node>{name}</node>\n"))
        .collect::<String>();
    let edges = graph
        .edges
        .iter()
        .map(|edge| format!("    <edge from=\"{}\" to=\"{}\"/>\n", edge.from, edge.to))
        .collect::<String>();
    format!("<graph>\n  <nodes>\n{nodes}  </nodes>\n  <edges>\n{edges}  </edges>\n</graph>\n")
}
