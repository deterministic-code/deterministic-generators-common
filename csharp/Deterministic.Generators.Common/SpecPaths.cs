namespace Deterministic.Generators.Common;

public static class SpecPaths
{
    public const string SpecRepo = "deterministic-specifications";

    public static string SpecRelPath(string subdir, string name) => Path.Combine(subdir, name);

    public static async Task<string?> FindAncestorPath(string relPath, string? start = null)
    {
        var current = Path.GetFullPath(start ?? AppContext.BaseDirectory);
        var root = Path.GetPathRoot(current) ?? Path.DirectorySeparatorChar.ToString();
        for (;;)
        {
            var candidate = Path.Combine(current, relPath);
            if (await Exists(candidate)) return candidate;
            var sibling = Path.Combine(current, SpecRepo, relPath);
            if (await Exists(sibling)) return sibling;
            if (PathsEqual(current, root)) return null;
            var trimmed = Path.TrimEndingDirectorySeparator(current);
            var parent = Path.GetDirectoryName(trimmed);
            if (string.IsNullOrEmpty(parent) || PathsEqual(parent, trimmed)) return null;
            current = parent;
        }
    }

    public static Task<string?> FindSpecPath(string subdir, string name, string? start = null) =>
        FindAncestorPath(Path.Combine(subdir, name), start);

    public static async Task<string> ResolveSpecPath(string subdir, string name, string? start = null)
    {
        var found = await FindSpecPath(subdir, name, start);
        if (found is not null) return found;
        throw new InvalidOperationException($"spec file not found: {SpecRelPath(subdir, name)}");
    }

    static async Task<bool> Exists(string path)
    {
        try
        {
            await using var stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite);
            return true;
        }
        catch (UnauthorizedAccessException)
        {
            return Directory.Exists(path);
        }
        catch (IOException)
        {
            return Directory.Exists(path);
        }
        catch
        {
            return Directory.Exists(path);
        }
    }

    static bool PathsEqual(string a, string b) =>
        string.Equals(
            Path.TrimEndingDirectorySeparator(a),
            Path.TrimEndingDirectorySeparator(b),
            StringComparison.Ordinal);
}
