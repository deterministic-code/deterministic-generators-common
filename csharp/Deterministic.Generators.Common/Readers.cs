namespace Deterministic.Generators.Common;

public interface IDeterministicReader
{
    Task<string> Read(string name);
    Task<bool> Exists(string name);
}

public sealed class MemoryReader : IDeterministicReader
{
    private readonly IReadOnlyDictionary<string, string> _files;

    public MemoryReader(IReadOnlyDictionary<string, string> files) => _files = files;

    public Task<string> Read(string name)
    {
        if (!_files.ContainsKey(name))
            throw new InvalidOperationException($"deterministic reader: missing {name}");
        return Task.FromResult(_files[name]);
    }

    public Task<bool> Exists(string name) => Task.FromResult(_files.ContainsKey(name));
}

public sealed class FileReader : IDeterministicReader
{
    private readonly string _dir;

    public FileReader(string root) => _dir = Path.GetFullPath(root);

    public async Task<string> Read(string name)
    {
        var path = Path.Combine(_dir, name);
        try
        {
            return await File.ReadAllTextAsync(path);
        }
        catch
        {
            throw new InvalidOperationException($"deterministic reader: missing {name} in {_dir}");
        }
    }

    public Task<bool> Exists(string name)
    {
        var path = Path.Combine(_dir, name);
        return Task.FromResult(File.Exists(path) || Directory.Exists(path));
    }
}
