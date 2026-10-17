// Family 1's own export manifest (`_tia-openness-manifest.json`), read as the
// authoritative index for ONE device's source tree.
//
// Written by the interface plugin's export (docs/OUTPUT-CONTRACT.md §3, the D24
// layout: `blocks/` + `types/` + `tag_tables/` + this file at the device root).
//
// Field notes were taken from a REAL 1376-object manifest rather than from the
// doc, because the doc and the file disagree in three places:
//
//   * the doc lists `counts` / `objectCount` / `blockCount`; the real file has
//     none of them (only `failureCount`), so totals are derived from `blocks[]`;
//   * the doc lists an `element` field per entry; real entries carry
//     `simaticType` instead and no `element` at all, so dispatch uses `category`;
//   * `group` is ABSENT (not empty-string) for objects in the root group.
//
// Every field here is therefore nullable and every absence degrades instead of
// throwing: a manifest we can read at all is better than no graph.
using System.Text.Json;

namespace EngineeringGraph.Engine;

internal sealed class DeviceManifest
{
    /// <summary>The file's fixed name at the device root.</summary>
    internal const string FileName = "_tia-openness-manifest.json";

    /// <summary>
    /// Declared as <see cref="JsonElement"/> because its JSON type is not fixed: the
    /// documented shape and the real file both use the NUMBER <c>1</c>, while the
    /// contract text renders it as <c>"1.0"</c> elsewhere in this family's history.
    /// A typed <c>string</c> here made the whole read throw (<c>MANIFEST_INVALID</c>)
    /// on a perfectly good 1376-object manifest — measured, not hypothetical.
    /// </summary>
    public JsonElement? SchemaVersion { get; set; }

    public string? GeneratedBy { get; set; }

    public string? Device { get; set; }

    public string? Software { get; set; }

    public string? OutputDir { get; set; }

    public int? FailureCount { get; set; }

    public List<DeviceManifestEntry>? Blocks { get; set; }

    public List<DeviceManifestFailure>? Failures { get; set; }
}

internal sealed class DeviceManifestEntry
{
    /// <summary><c>blocks</c> | <c>types</c> | <c>tag_tables</c>; the dispatch key.</summary>
    public string? Category { get; set; }

    public string? Name { get; set; }

    /// <summary>User-group path with a trailing slash; absent for the root group.</summary>
    public string? Group { get; set; }

    /// <summary>Absolute path as written by the exporter.</summary>
    public string? File { get; set; }

    /// <summary><c>OB</c> | <c>FB</c> | <c>FC</c> | <c>GlobalDB</c> | <c>InstanceDB</c> | <c>PlcStruct</c> | <c>PlcTagTable</c> …</summary>
    public string? SimaticType { get; set; }

    public string? DeclaredNumber { get; set; }

    public string? ProgrammingLanguage { get; set; }

    public bool? Verified { get; set; }
}

internal sealed class DeviceManifestFailure
{
    public string? Category { get; set; }

    public string? Name { get; set; }

    public string? Group { get; set; }

    public string? Code { get; set; }

    public string? Message { get; set; }
}

internal static class DeviceManifests
{
    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    /// <summary>Is the family-1 manifest present at this device root?</summary>
    internal static bool Exists(string deviceDir) =>
        System.IO.File.Exists(Path.Combine(deviceDir, DeviceManifest.FileName));

    internal static DeviceManifest Read(string deviceDir)
    {
        var path = Path.Combine(deviceDir, DeviceManifest.FileName);
        try
        {
            return JsonSerializer.Deserialize<DeviceManifest>(
                       System.IO.File.ReadAllText(path),
                       Options)
                   ?? new DeviceManifest();
        }
        catch (JsonException ex)
        {
            throw new EngineException(
                "MANIFEST_INVALID",
                $"{DeviceManifest.FileName} is not valid JSON: {ex.Message}",
                "Re-run the export, or point deviceDir at a directory that has one.");
        }
        catch (IOException ex)
        {
            throw new EngineException(
                "MANIFEST_INVALID",
                $"{DeviceManifest.FileName} could not be read: {ex.Message}",
                "Check that the file is not locked by another process.");
        }
    }

    /// <summary>
    /// Where an entry's XML actually is.
    ///
    /// The recorded <c>file</c> is absolute, so it survives being read on the machine
    /// that wrote it and breaks as soon as the tree is moved, renamed or copied — a
    /// gap the interface plugin's own gap analysis already records
    /// (`MANIFEST-GAP-ANALYSIS.md` §1: "缺可移植路径"). So the path is RECOMPUTED from
    /// <c>outputDir + category + group + name</c> first and only falls back to the
    /// recorded absolute path. When the two disagree the caller is told, because a
    /// silent choice could read a stale file.
    /// </summary>
    internal static string ResolveFile(string deviceDir, DeviceManifestEntry entry, out bool recomputed)
    {
        var recomputedPath = RecomputePath(deviceDir, entry);
        var recorded = entry.File;

        if (recomputedPath is not null && System.IO.File.Exists(recomputedPath))
        {
            recomputed = true;
            return recomputedPath;
        }

        if (!string.IsNullOrWhiteSpace(recorded) && System.IO.File.Exists(recorded))
        {
            recomputed = false;
            return recorded;
        }

        recomputed = recomputedPath is not null;
        return recomputedPath ?? recorded ?? string.Empty;
    }

    /// <summary>The path implied by outputDir + category + group + name, or null if that cannot be built.</summary>
    internal static string? RecomputePath(string deviceDir, DeviceManifestEntry entry)
    {
        if (string.IsNullOrWhiteSpace(entry.Category) || string.IsNullOrWhiteSpace(entry.Name))
        {
            return null;
        }

        var parts = new List<string> { deviceDir, entry.Category };
        var group = entry.Group?.Replace('\\', '/').Trim('/');
        if (!string.IsNullOrEmpty(group))
        {
            parts.AddRange(group.Split('/', StringSplitOptions.RemoveEmptyEntries));
        }

        parts.Add(entry.Name + ".xml");
        return Path.Combine(parts.ToArray());
    }

    /// <summary>The entry's path relative to the device root, for reporting and for <c>sourceFile</c>.</summary>
    internal static string RelativeFile(string deviceDir, string absolutePath)
    {
        var relative = Path.GetRelativePath(deviceDir, absolutePath);
        return relative.Replace('\\', '/');
    }
}
