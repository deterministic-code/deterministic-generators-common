using System.Text.Json;

namespace Deterministic.Generators.Common;

public static class FrontendFrameworks
{
    public static readonly string[] All = ["vite", "next", "svelte", "angular"];
}

public sealed class SettingsModel
{
    public required string ApplicationName { get; init; }
    public required string FrontendFramework { get; init; }
    public required bool FullStack { get; init; }
    public required string SchemaVersion { get; init; }
    public required bool SimpleDoc { get; init; }
    public required bool DescriptionDoc { get; init; }
    public required bool CreateIndex { get; init; }
    public string? LibraryReferenceMode { get; init; }
}

public static class Settings
{
    public static SettingsModel FromSettings(IReadOnlyDictionary<string, string> raw)
    {
        raw.TryGetValue("comments", out var comments);
        raw.TryGetValue("frontend_generate_framework", out var frontendFramework);
        if (frontendFramework is not null && frontendFramework.Length > 0
            && !FrontendFrameworks.All.Contains(frontendFramework))
        {
            var allowed = string.Join(", ", FrontendFrameworks.All.Select(name => JsonSerializer.Serialize(name)));
            throw new InvalidOperationException(
                $"settings.frontend_generate_framework must be {allowed}, got {JsonSerializer.Serialize(frontendFramework)}");
        }
        raw.TryGetValue("application_name", out var applicationName);
        raw.TryGetValue("application_tier", out var tier);
        raw.TryGetValue("codegen.schema_version", out var schemaVersion);
        raw.TryGetValue("codegen.create_index", out var createIndex);
        raw.TryGetValue("languages.typescript.library_reference_mode", out var libraryMode);
        return new SettingsModel
        {
            ApplicationName = string.IsNullOrEmpty(applicationName) ? "generated-frontend" : applicationName,
            FrontendFramework = string.IsNullOrEmpty(frontendFramework) ? "vite" : frontendFramework,
            FullStack = tier == "full-stack",
            SchemaVersion = schemaVersion ?? "1.0",
            SimpleDoc = comments != "none" && comments != "description",
            DescriptionDoc = comments == "description",
            CreateIndex = createIndex != "false",
            LibraryReferenceMode = libraryMode,
        };
    }
}
