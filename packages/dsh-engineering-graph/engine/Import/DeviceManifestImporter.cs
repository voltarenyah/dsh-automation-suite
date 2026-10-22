// Import one device's source tree driven by family 1's manifest.
//
// The manifest is the authoritative index: it decides WHICH files belong to this
// device and in what order they are processed, so disk scanning is only used to
// report what the manifest failed to mention. That is the whole point of the D24
// layout — the export already knows its own contents, and re-deriving them from
// directory names is how the id pollution and the cross-group call breakage
// happened in the first place (see docs/decisions.md D20).
//
// Two deliberate choices worth knowing:
//
//   * `deviceName` is empty for every import. One database is one device (D13),
//     so qualifying ids with the device name would add nothing and would make
//     every id churn if the device were renamed. The device name is recorded as a
//     property on the project node instead.
//   * `sourcePath` is the manifest's `group`, NOT a directory path. That is the
//     clean user-group path ("010_Cell/"), free of the category segment that the
//     relative directory would carry ("blocks/010_Cell").
//
// Component provenance IS registered here since B4 (the incremental `Update`
// operation). It used to be deliberately omitted ("it waits for the freshness
// step instead") for one reason: the manifest's own `sha256` hashes the file bytes
// including `<DocumentInfo><Created>`, which changes on every export, so it cannot
// be a normalized identity. That objection is answered by not using the manifest's
// hash at all: `content_hash` is SHA-256 of the file bytes computed here, exactly
// what the legacy manifest importer and the crawler already store, and it is only a
// change key — `Update` is driven by an explicit `changedPaths` list, never by
// comparing hashes. Without provenance rows a real 1376-file device tree could not
// be updated at all, and every sync would have to re-parse the whole export.
namespace EngineeringGraph.Engine;

internal static class DeviceManifestImporter
{
    internal static ExportFolderImportResult Import(string deviceDir, Action<string>? progress)
    {
        if (string.IsNullOrWhiteSpace(deviceDir) || !Directory.Exists(deviceDir))
        {
            throw new EngineException(
                "DEVICE_DIR_NOT_FOUND",
                $"Device source directory '{deviceDir}' was not found.",
                "Pass the per-device directory, i.e. <project>/source/<device> — the one that holds "
                + $"{DeviceManifest.FileName} plus blocks/, types/ and tag_tables/.");
        }

        var fullRoot = Path.GetFullPath(deviceDir);
        var manifest = DeviceManifests.Read(fullRoot);
        var entries = manifest.Blocks ?? new List<DeviceManifestEntry>();
        var warnings = new List<string>();
        var device = DeviceOf(manifest, fullRoot);

        var graph = new SemanticPlcGraph();
        var project = ProjectNode(manifest, device, fullRoot);
        graph.UpsertNode(project);

        var imported = 0;
        var missing = 0;
        var mentioned = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var byCategory = new SortedDictionary<string, int>(StringComparer.Ordinal);

        foreach (var entry in entries)
        {
            var name = entry.Name ?? "(unnamed)";
            string absolutePath;
            try
            {
                absolutePath = DeviceManifests.ResolveFile(fullRoot, entry, out _);
            }
            catch (ArgumentException ex)
            {
                warnings.Add($"skipped '{name}': {ex.Message}");
                continue;
            }

            if (string.IsNullOrWhiteSpace(absolutePath) || !File.Exists(absolutePath))
            {
                missing++;
                warnings.Add($"manifest entry '{name}' ({entry.Category}) is missing on disk: {absolutePath}");
                continue;
            }

            mentioned.Add(DeviceManifests.RelativeFile(fullRoot, absolutePath));

            try
            {
                var component = ImportEntryTracked(fullRoot, entry, absolutePath, graph, project);
                graph.RegisterComponentImport(component);
                imported++;
                var category = NormalizeCategory(entry.Category);
                byCategory[category] = byCategory.TryGetValue(category, out var count) ? count + 1 : 1;
            }
            catch (Exception ex) when (ex is not EngineException)
            {
                // One bad file must not lose the other 1300: report and continue.
                warnings.Add($"skipped '{name}': {ex.GetType().Name}: {ex.Message}");
            }

            if (progress is not null && (imported % 100 == 0 || imported == entries.Count))
            {
                progress($"ingest: {imported}/{entries.Count} files (manifest)");
            }
        }

        foreach (var failure in manifest.Failures ?? new List<DeviceManifestFailure>())
        {
            warnings.Add(
                $"export failed: '{failure.Name}' ({failure.Category}) — {failure.Code}: {failure.Message}");
        }

        foreach (var stray in UnlistedFiles(fullRoot, mentioned))
        {
            warnings.Add($"not in manifest, ignored: {stray}");
        }

        if (imported + missing != entries.Count)
        {
            warnings.Add(
                $"manifest carries {entries.Count} file entries; {imported} imported, {missing} missing, "
                + $"{entries.Count - imported - missing} skipped");
        }

        TiaXmlSemanticGraphImporter.LinkSymbolsToDbMembers(graph);
        return new ExportFolderImportResult(graph, entries.Count, imported, warnings, "manifest");
    }

    /// <summary>
    /// Re-import ONE file of a D24 device tree, as its own component graph.
    ///
    /// This is the single-component half of <see cref="Import"/>, used by
    /// `ComponentProvenanceStore.ImportComponent` for the incremental update. It has
    /// to produce exactly the component key and relative path the full import stored
    /// (that is what `Replace`'s identity check compares), so both paths go through
    /// <see cref="ImportEntryTracked"/> and neither re-derives the identity.
    ///
    /// A path the manifest does not list is refused rather than parsed: the manifest
    /// is the authoritative index of this device, so a file outside it was never
    /// imported, and quietly adding it would make the database a mix of two
    /// different export states.
    /// </summary>
    internal static (SemanticPlcGraph Graph, ComponentImport Component) ImportComponent(
        string deviceDir,
        string relativePath)
    {
        if (string.IsNullOrWhiteSpace(deviceDir) || !Directory.Exists(deviceDir))
        {
            throw new EngineException(
                "DEVICE_DIR_NOT_FOUND",
                $"Device source directory '{deviceDir}' was not found.",
                "Pass the per-device directory, i.e. <project>/source/<device>.");
        }

        var fullRoot = Path.GetFullPath(deviceDir);
        var manifest = DeviceManifests.Read(fullRoot);
        var wanted = NormalizeRelative(relativePath);
        var entry = (manifest.Blocks ?? new List<DeviceManifestEntry>())
            .FirstOrDefault(candidate =>
            {
                if (string.IsNullOrWhiteSpace(candidate.Category) ||
                    string.IsNullOrWhiteSpace(candidate.Name))
                {
                    return false;
                }

                // Three spellings can name the same stored component: the path this
                // tree implies (outputDir + category + group + name), the path the
                // export actually resolved to (a moved tree falls back to the
                // recorded absolute `file`), and the recorded `file` itself (the
                // export writes the real on-disk name, which may carry TIA's
                // `[OB1]`-style suffix that `name` does not). Any one of them naming
                // the wanted component means this entry is it.
                var recomputed = DeviceManifests.RecomputePath(fullRoot, candidate);
                if (recomputed is not null &&
                    PathsMatch(fullRoot, recomputed, wanted))
                {
                    return true;
                }

                if (!string.IsNullOrWhiteSpace(candidate.File) &&
                    PathsMatch(fullRoot, candidate.File!, wanted))
                {
                    return true;
                }

                var resolved = DeviceManifests.ResolveFile(fullRoot, candidate, out _);
                return !string.IsNullOrWhiteSpace(resolved) &&
                    PathsMatch(fullRoot, resolved, wanted);
            });
        if (entry is null)
        {
            throw new ComponentIdentityMismatchException(
                $"Component path '{wanted}' is not present in {DeviceManifest.FileName}.");
        }

        var absolutePath = DeviceManifests.ResolveFile(fullRoot, entry, out _);
        if (string.IsNullOrWhiteSpace(absolutePath) || !File.Exists(absolutePath))
        {
            throw new FileNotFoundException(
                $"Source component '{wanted}' was not found under '{fullRoot}'.",
                absolutePath);
        }

        var device = DeviceOf(manifest, fullRoot);
        var graph = new SemanticPlcGraph();
        var project = ProjectNode(manifest, device, fullRoot);
        graph.UpsertNode(project);
        var component = ImportEntryTracked(fullRoot, entry, absolutePath, graph, project);
        TiaXmlSemanticGraphImporter.LinkSymbolsToDbMembers(graph);
        return (graph, component);
    }

    private static string DeviceOf(DeviceManifest manifest, string fullRoot) =>
        string.IsNullOrWhiteSpace(manifest.Device)
            ? Path.GetFileName(fullRoot.TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar))
            : manifest.Device!;

    private static SemanticGraphNode ProjectNode(
        DeviceManifest manifest,
        string device,
        string fullRoot) =>
        new(
            $"project:{device}",
            SemanticNodeKind.Project,
            device,
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["device"] = device,
                ["software"] = manifest.Software ?? string.Empty,
                ["exportRoot"] = fullRoot,
                ["manifest"] = DeviceManifest.FileName,
                ["generatedBy"] = manifest.GeneratedBy ?? string.Empty,
            });

    /// <summary>
    /// Import one entry while recording the node/edge ids it touched, and turn that
    /// into the <see cref="ComponentImport"/> provenance row that identifies it.
    /// </summary>
    private static ComponentImport ImportEntryTracked(
        string deviceDir,
        DeviceManifestEntry entry,
        string absolutePath,
        SemanticPlcGraph graph,
        SemanticGraphNode project)
    {
        var relative = DeviceManifests.RelativeFile(deviceDir, absolutePath);
        var bytes = File.ReadAllBytes(absolutePath);
        var xml = DecodeXml(bytes);
        var touches = graph.CaptureTouches(
            () => ImportEntry(xml, entry, deviceDir, absolutePath, graph, project));
        return new ComponentImport(
            ComponentKeys.ForPath(relative),
            relative,
            ComponentKeys.ContentHashOf(bytes),
            touches.NodeIds,
            touches.EdgeIds);
    }

    /// <summary>UTF-8 with BOM detection, the same decoding the other importers use.</summary>
    private static string DecodeXml(byte[] bytes)
    {
        using var stream = new MemoryStream(bytes, writable: false);
        using var reader = new StreamReader(
            stream,
            System.Text.Encoding.UTF8,
            detectEncodingFromByteOrderMarks: true);
        return reader.ReadToEnd();
    }

    private static string NormalizeRelative(string path) =>
        path.Replace('\\', '/').TrimStart('/');

    /// <summary>
    /// Does <paramref name="candidatePath"/> (absolute or relative) spell the given
    /// device-relative path? Case-insensitive because the stored path came from the
    /// filesystem and Windows does not distinguish case.
    /// </summary>
    private static bool PathsMatch(string deviceDir, string candidatePath, string wanted) =>
        string.Equals(
            NormalizeRelative(DeviceManifests.RelativeFile(deviceDir, candidatePath)),
            wanted,
            StringComparison.OrdinalIgnoreCase);

    private static void ImportEntry(
        string xml,
        DeviceManifestEntry entry,
        string deviceDir,
        string absolutePath,
        SemanticPlcGraph graph,
        SemanticGraphNode project)
    {
        var relative = DeviceManifests.RelativeFile(deviceDir, absolutePath);
        var group = entry.Group?.Replace('\\', '/').Trim('/') ?? string.Empty;
        var name = entry.Name ?? Path.GetFileNameWithoutExtension(absolutePath);

        // Empty on purpose — see the file header.
        const string deviceName = "";

        switch (NormalizeCategory(entry.Category))
        {
            case "types":
                TiaXmlSemanticGraphImporter.ImportUdtXml(xml, relative, group, graph, deviceName);
                Contains(graph, project, TiaXmlSemanticGraphImporter.UdtId(deviceName, name));
                break;

            case "tag_tables":
                TiaXmlSemanticGraphImporter.ImportTagTableXml(xml, relative, group, graph, deviceName);
                // Tag tables get no project CONTAINS edge; that is the origin's
                // documented behaviour and nothing here needs to change it.
                break;

            default:
                if (IsDataBlock(entry))
                {
                    TiaXmlSemanticGraphImporter.ImportDbXml(xml, relative, group, graph, deviceName);
                    Contains(graph, project, TiaXmlSemanticGraphImporter.DbId(deviceName, name));
                }
                else
                {
                    TiaXmlSemanticGraphImporter.ImportBlockXml(
                        xml,
                        new ProgramBlockComponent(name, entry.SimaticType ?? "FB", group, relative),
                        graph,
                        deviceName);
                    Contains(graph, project, TiaXmlSemanticGraphImporter.BlockId(deviceName, name));
                }

                break;
        }
    }

    private static void Contains(SemanticPlcGraph graph, SemanticGraphNode project, string targetId) =>
        TiaXmlSemanticGraphImporter.AddEdgeIfTargetExists(
            graph,
            project.Id,
            targetId,
            SemanticRelationshipType.Contains);

    /// <summary>
    /// Is this a data block? `simaticType` answers it for every real entry
    /// (<c>GlobalDB</c> / <c>InstanceDB</c> / <c>ArrayDB</c> / <c>DB</c>, and Safety's
    /// <c>F_DB</c>); the XML root is only read when the manifest omits the field.
    /// </summary>
    private static bool IsDataBlock(DeviceManifestEntry entry)
    {
        var simaticType = entry.SimaticType;
        if (!string.IsNullOrWhiteSpace(simaticType))
        {
            return simaticType.EndsWith("DB", StringComparison.OrdinalIgnoreCase);
        }

        return false;
    }

    private static string NormalizeCategory(string? category) =>
        string.IsNullOrWhiteSpace(category) ? "blocks" : category.Trim().ToLowerInvariant();

    /// <summary>On-disk XML the manifest never mentions — reported, never imported.</summary>
    private static IEnumerable<string> UnlistedFiles(string deviceDir, HashSet<string> mentioned)
    {
        foreach (var category in new[] { "blocks", "types", "tag_tables" })
        {
            var directory = Path.Combine(deviceDir, category);
            if (!Directory.Exists(directory))
            {
                continue;
            }

            foreach (var file in Directory.EnumerateFiles(directory, "*.xml", SearchOption.AllDirectories))
            {
                var relative = DeviceManifests.RelativeFile(deviceDir, file);
                if (!mentioned.Contains(relative))
                {
                    yield return relative;
                }
            }
        }
    }
}
