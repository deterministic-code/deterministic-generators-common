using System.Text.Json;

namespace Deterministic.Generators.Common;

public sealed class DatasourceTypeNode : Dictionary<string, DatasourceTypeNode>
{
    public DatasourceTypeNode() : base(StringComparer.Ordinal) { }
}

public sealed class DatasourceTypeGraphEdge
{
    public required string From { get; init; }
    public required string To { get; init; }
}

public sealed class DatasourceTypeGraph
{
    public required List<string> Nodes { get; init; }
    public required List<DatasourceTypeGraphEdge> Edges { get; init; }
}

public sealed class DatasourceTypeHierarchies
{
    public required DatasourceTypeNode FirstParentTree { get; init; }
    public required DatasourceTypeNode AllParentsTree { get; init; }
    public required DatasourceTypeGraph Graph { get; init; }
}

public static class TypeTrees
{
    private const string Root = "root";

    public static DatasourceTypeNode DatasourceTypeTree(IReadOnlyList<TypeModel> types, string multiParent = "first") =>
        BuildTree(types, ChosenParents(types, multiParent));

    public static DatasourceTypeNode DatasourceTypeTreeFirst(IReadOnlyList<TypeModel> types) =>
        DatasourceTypeTree(types, "first");

    public static DatasourceTypeNode DatasourceTypeTreeAll(IReadOnlyList<TypeModel> types) =>
        DatasourceTypeTree(types, "all");

    public static DatasourceTypeGraph DatasourceTypeGraph(IReadOnlyList<TypeModel> types)
    {
        var parents = ChosenParents(types, "all");
        var nodes = new List<string> { Root };
        nodes.AddRange(types.Select(type => type.Name));
        var edges = new List<DatasourceTypeGraphEdge>();
        foreach (var type in types)
        {
            var list = parents[type.Name];
            if (list.Count == 0)
            {
                edges.Add(new DatasourceTypeGraphEdge { From = type.Name, To = Root });
                continue;
            }
            foreach (var parent in list)
                edges.Add(new DatasourceTypeGraphEdge { From = type.Name, To = parent });
        }
        return new DatasourceTypeGraph { Nodes = nodes, Edges = edges };
    }

    public static DatasourceTypeHierarchies DatasourceTypeHierarchies(IReadOnlyList<TypeModel> types) =>
        new()
        {
            FirstParentTree = DatasourceTypeTreeFirst(types),
            AllParentsTree = DatasourceTypeTreeAll(types),
            Graph = DatasourceTypeGraph(types),
        };

    public static List<string> DatasourceTypeOrder(IReadOnlyList<TypeModel> types)
    {
        var names = new List<string>();
        void Walk(DatasourceTypeNode node)
        {
            foreach (var (name, child) in node)
            {
                names.Add(name);
                Walk(child);
            }
        }
        Walk(DatasourceTypeTreeFirst(types)[Root]);
        return names;
    }

    public static List<string> DatasourceTypeAncestry(IReadOnlyList<TypeModel> types, string name)
    {
        var parents = ChosenParents(types, "all");
        if (!parents.ContainsKey(name)) return [];
        var output = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        void Walk(string current, HashSet<string> path)
        {
            foreach (var parent in parents[current])
            {
                if (path.Contains(parent) || seen.Contains(parent)) continue;
                var next = new HashSet<string>(path, StringComparer.Ordinal) { current };
                Walk(parent, next);
                seen.Add(parent);
                output.Add(parent);
            }
        }
        Walk(name, new HashSet<string>(StringComparer.Ordinal) { name });
        return output;
    }

    public static Func<string, string, int> CompareByDatasourceTypeOrder(
        IReadOnlyList<TypeModel> types,
        Func<string, string?>? inheritOf = null)
    {
        inheritOf ??= _ => null;
        var order = DatasourceTypeOrder(types);
        var rank = order.Select((item, index) => (item, index)).ToDictionary(x => x.item, x => x.index, StringComparer.Ordinal);
        (int Rank, string Name) Key(string name)
        {
            if (rank.TryGetValue(name, out var direct)) return (direct * 2, name);
            var inherit = inheritOf(name);
            if (inherit is not null && rank.TryGetValue(inherit, out var parent))
                return (parent * 2 + 1, name);
            return (order.Count * 2, name);
        }
        return (a, b) =>
        {
            var (ia, na) = Key(a);
            var (ib, nb) = Key(b);
            var delta = ia - ib;
            return delta != 0 ? delta : string.Compare(na, nb, StringComparison.Ordinal);
        };
    }

    public static string DatasourceTypeTreeYaml(DatasourceTypeNode tree) => EmitMap(tree, 0);

    public static string DatasourceTypeTreeJson(DatasourceTypeNode tree) =>
        JsonSerializer.Serialize(tree, JsonOptions) + "\n";

    public static string DatasourceTypeTreeXml(DatasourceTypeNode tree) =>
        string.Concat(tree.Select(pair => XmlElement(pair.Key, pair.Value, "")));

    public static string DatasourceTypeGraphYaml(DatasourceTypeGraph graph)
    {
        var lines = new List<string> { "nodes:" };
        lines.AddRange(graph.Nodes.Select(name => $"  - {name}"));
        lines.Add("edges:");
        foreach (var edge in graph.Edges)
        {
            lines.Add($"  - from: {edge.From}");
            lines.Add($"    to: {edge.To}");
        }
        return string.Join('\n', lines) + "\n";
    }

    public static string DatasourceTypeGraphJson(DatasourceTypeGraph graph) =>
        JsonSerializer.Serialize(graph, JsonOptions) + "\n";

    public static string DatasourceTypeGraphXml(DatasourceTypeGraph graph)
    {
        var nodes = string.Concat(graph.Nodes.Select(name => $"    <node>{name}</node>\n"));
        var edges = string.Concat(graph.Edges.Select(edge => $"    <edge from=\"{edge.From}\" to=\"{edge.To}\"/>\n"));
        return $"<graph>\n  <nodes>\n{nodes}  </nodes>\n  <edges>\n{edges}  </edges>\n</graph>\n";
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private static List<string> RefTargets(object? references)
    {
        var raw = references switch
        {
            string s => new[] { s },
            string[] arr => arr,
            IReadOnlyList<string> list => list.ToArray(),
            _ => [],
        };
        return raw.Select(reference =>
        {
            var dot = reference.Split('.')[0];
            return dot;
        }).ToList();
    }

    private static List<string> ReferencedParents(TypeModel type, HashSet<string> names)
    {
        var parents = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var field in type.Fields)
        {
            if (field.References is null) continue;
            foreach (var parent in RefTargets(field.References))
            {
                if (parent.Length == 0 || parent == type.Name || !names.Contains(parent) || seen.Contains(parent))
                    continue;
                seen.Add(parent);
                parents.Add(parent);
            }
        }
        return parents;
    }

    private static void AddChild(Dictionary<string, List<string>> children, string parent, string child)
    {
        if (!children.TryGetValue(parent, out var list))
        {
            children[parent] = [child];
            return;
        }
        if (!list.Contains(child)) list.Add(child);
    }

    private static Dictionary<string, int> StronglyConnected(
        IReadOnlyList<string> names,
        Func<string, IReadOnlyList<string>> parentsOf)
    {
        var index = 0;
        var sccCount = 0;
        var indices = new Dictionary<string, int>(StringComparer.Ordinal);
        var lows = new Dictionary<string, int>(StringComparer.Ordinal);
        var stack = new List<string>();
        var onStack = new HashSet<string>(StringComparer.Ordinal);
        var sccId = new Dictionary<string, int>(StringComparer.Ordinal);

        void Connect(string v)
        {
            indices[v] = index;
            lows[v] = index;
            index++;
            stack.Add(v);
            onStack.Add(v);
            foreach (var w in parentsOf(v))
            {
                if (!indices.ContainsKey(w))
                {
                    Connect(w);
                    if (lows.TryGetValue(v, out var vLow) && lows.TryGetValue(w, out var wLow))
                        lows[v] = Math.Min(vLow, wLow);
                }
                else if (onStack.Contains(w) && lows.TryGetValue(v, out var low) && indices.TryGetValue(w, out var wIndex))
                {
                    lows[v] = Math.Min(low, wIndex);
                }
            }
            if (lows[v] == indices[v])
            {
                string w;
                do
                {
                    w = stack[^1];
                    stack.RemoveAt(stack.Count - 1);
                    onStack.Remove(w);
                    sccId[w] = sccCount;
                } while (w != v);
                sccCount++;
            }
        }

        foreach (var name in names)
        {
            if (!indices.ContainsKey(name)) Connect(name);
        }
        return sccId;
    }

    private static HashSet<int> SccsWithExternalParent(
        Dictionary<string, List<string>> parentLists,
        Dictionary<string, int> sccId)
    {
        var hasExternal = new HashSet<int>();
        foreach (var (name, parents) in parentLists)
        {
            var from = sccId[name];
            foreach (var parent in parents)
            {
                if (sccId[parent] != from) hasExternal.Add(from);
            }
        }
        return hasExternal;
    }

    private static DatasourceTypeNode BuildNode(
        Dictionary<string, List<string>> children,
        string name,
        HashSet<string> path)
    {
        var node = new DatasourceTypeNode();
        if (!children.TryGetValue(name, out var kids)) return node;
        foreach (var child in kids)
        {
            if (path.Contains(child)) continue;
            node[child] = BuildNode(children, child, new HashSet<string>(path, StringComparer.Ordinal) { child });
        }
        return node;
    }

    private static Dictionary<string, List<string>> ChosenParents(IReadOnlyList<TypeModel> types, string multiParent)
    {
        var names = types.Select(type => type.Name).ToHashSet(StringComparer.Ordinal);
        var lists = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var type in types)
        {
            var parents = ReferencedParents(type, names);
            lists[type.Name] = multiParent == "all" ? parents : parents.Take(1).ToList();
        }
        return lists;
    }

    private static DatasourceTypeNode BuildTree(
        IReadOnlyList<TypeModel> types,
        Dictionary<string, List<string>> parentLists)
    {
        var names = types.Select(type => type.Name).ToList();
        var sccId = StronglyConnected(names, name => parentLists[name]);
        var hasExternal = SccsWithExternalParent(parentLists, sccId);
        var children = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var type in types)
        {
            var scc = sccId[type.Name];
            var parents = parentLists[type.Name];
            if (!hasExternal.Contains(scc))
            {
                AddChild(children, Root, type.Name);
                continue;
            }
            foreach (var parent in parents) AddChild(children, parent, type.Name);
        }
        var tree = new DatasourceTypeNode { [Root] = BuildNode(children, Root, new HashSet<string>(StringComparer.Ordinal) { Root }) };
        return tree;
    }

    private static string EmitMap(DatasourceTypeNode node, int indent)
    {
        if (node.Count == 0) return "{}\n";
        var pad = new string(' ', indent);
        var lines = new List<string>();
        foreach (var (key, child) in node)
        {
            if (child.Count == 0)
            {
                lines.Add($"{pad}{key}: {{}}");
                continue;
            }
            lines.Add($"{pad}{key}:");
            var inner = EmitMap(child, indent + 2);
            lines.Add(inner.TrimEnd('\n'));
        }
        return string.Join('\n', lines) + "\n";
    }

    private static string XmlElement(string name, DatasourceTypeNode children, string indent)
    {
        if (children.Count == 0) return $"{indent}<{name}/>\n";
        var inner = string.Concat(children.Select(pair => XmlElement(pair.Key, pair.Value, indent + "  ")));
        return $"{indent}<{name}>\n{inner}{indent}</{name}>\n";
    }
}
