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
// NOT done here: component provenance (`RegisterComponentImport`). Provenance
// exists to drive partial updates, and the change key it needs must be a
// NORMALISED content hash — the manifest's `sha256` hashes the file bytes,
// including `<DocumentInfo><Created>`, which changes on every export. Registering
// a key we already know is wrong would bake in exactly the defect D13 warns about,
// so it waits for the freshness step instead.
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
        var device = string.IsNullOrWhiteSpace(manifest.Device)
            ? Path.GetFileName(fullRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
            : manifest.Device!;

        var graph = new SemanticPlcGraph();
        var project = new SemanticGraphNode(
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
                ImportEntry(File.ReadAllText(absolutePath), entry, fullRoot, absolutePath, graph, project);
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
