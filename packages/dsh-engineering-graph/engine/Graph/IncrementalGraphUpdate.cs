// The incremental graph update (`Update`): refresh the components a sync touched,
// instead of re-parsing the whole device.
//
// Why it exists: a full `Ingest` of a real project re-reads and re-parses every
// exported file (measured: 1376 source files, ~30 s, ~450 MB database). A sync that
// changed three blocks does not need that, and the provenance the database already
// carries (`source_components` + `source_component_nodes` + `source_component_edges`)
// is exactly what is needed to replace only those components.
//
// The algorithm is deliberately CONSERVATIVE — every case it cannot prove safe is
// refused with a code whose remediation is "run Ingest", never guessed:
//
//   1. the database must exist and carry component provenance, otherwise
//      `UPDATE_REQUIRES_FULL_REBUILD`;
//   2. each changed device-relative path must be the `relative_path` of exactly one
//      stored component (exact match, no case folding, no path guessing), otherwise
//      `UPDATE_UNKNOWN_COMPONENT`;
//   3. one dependency hop: every component that owns an edge pointing at a node of a
//      changed or removed component is added to the replacement set, because
//      replacing a component can delete the nodes its neighbours' edges point at
//      (see the note on ordering below), otherwise `UPDATE_TOO_LARGE` when the batch
//      exceeds `maxComponents`;
//   4. every component in the batch is re-imported with the importer that stored it
//      and replaced through `ComponentProvenanceStore.ApplyReplace`;
//   5. removed paths are deleted through `ComponentProvenanceStore.ApplyDelete`,
//      after the replacements;
//   6. the whole batch runs in ONE transaction: a failure at any point leaves the
//      database exactly as it was (see `ComponentProvenanceStore.Session`).
//
// Ordering, and why it is part of the algorithm rather than an implementation detail:
// a replacement deletes the old nodes of the component it replaces when nothing else
// references them, and `graph_edges` has an ON DELETE CASCADE to `graph_nodes`, so a
// neighbour's edge can disappear with the node it pointed at. Replacements therefore
// run in a deterministic order — the changed components first, then the dependency
// closure — so the closure is re-imported *after* its targets have settled and its
// edges are written against the final node ids. When the node ids did not change
// (the common case: they are derived from the block/tag names), nothing is lost;
// when they did, a full rebuild is the honest answer and the next sync's comparison
// will not match anyway.
//
// NOT covered here (documented, not silently approximated): this operation updates
// block XML, DB XML, UDT XML and tag-table XML as stored by the manifest; it does not
// re-derive anything outside those files. Changes to the export's *category set*
// (a block moved between `blocks/` groups → different `relative_path`) are refused
// as `UPDATE_IDENTITY_CHANGED`, and tag-table/UDT/type wide changes are the caller's
// decision to force a full ingest — the engine will update them if they are named,
// but the supported incremental case is a direct block XML change.
using System.Xml;
using Microsoft.Data.Sqlite;

namespace EngineeringGraph.Engine;

internal static class IncrementalGraphUpdate
{
    /// <summary>Default cap on the components one update may touch; matches the tool default.</summary>
    internal const int DefaultMaxComponents = 50;

    internal sealed record Result(
        string Device,
        string DbPath,
        int Changed,
        int Removed,
        int Closure,
        IReadOnlyList<string> ChangedComponents,
        IReadOnlyList<string> ClosureComponents,
        IReadOnlyList<string> RemovedComponents,
        IReadOnlyList<string> IgnoredRemovedPaths,
        int MaxComponents,
        long Nodes,
        long Edges);

    private sealed record Candidate(string ComponentKey, string RelativePath);

    /// <summary>
    /// Refresh the named components of one device database.
    ///
    /// Throws <see cref="EngineException"/> for every refusal, with a stable code; the
    /// caller (the `Update` operation) forwards code, message and remediation to the
    /// wire unchanged.
    /// </summary>
    /// <param name="deviceDir">The device's export directory, e.g. <c>&lt;project&gt;/source/&lt;device&gt;</c>.</param>
    /// <param name="dbPath">The database to update in place. It must already exist.</param>
    /// <param name="changedPaths">Device-relative paths (<c>blocks/010/FC.xml</c>) of files whose content changed.</param>
    /// <param name="removedPaths">Device-relative paths of files deleted from the tree. Unknown ones are ignored.</param>
    /// <param name="maxComponents">Upper bound on changed + closure + removed components.</param>
    /// <param name="progress">Receives one note per component as it is replaced or removed.</param>
    internal static Result Run(
        string deviceDir,
        string dbPath,
        IReadOnlyList<string> changedPaths,
        IReadOnlyList<string> removedPaths,
        int maxComponents,
        IProgressSink progress)
    {
        var device = Path.GetFileName(Path.GetFullPath(deviceDir).TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar));
        var cap = maxComponents <= 0 ? DefaultMaxComponents : maxComponents;

        // 1. The database must exist and carry provenance. Both are preconditions of
        //    every later step, and both mean the same thing to the caller: this
        //    database cannot be updated in place, run a full Ingest.
        if (!File.Exists(dbPath))
        {
            throw new EngineException(
                "UPDATE_REQUIRES_FULL_REBUILD",
                $"The knowledge database '{dbPath}' does not exist, so there is nothing to update.",
                "Run Ingest for this device first; update is the incremental path over an existing, provenance-carrying database.");
        }

        var changed = NormalizePaths(changedPaths, "changedPaths");
        var removed = NormalizePaths(removedPaths, "removedPaths");
        var removedSet = removed.ToHashSet(StringComparer.Ordinal);
        var conflict = changed.FirstOrDefault(path => removedSet.Contains(path));
        if (conflict is not null)
        {
            throw new EngineException(
                "UPDATE_PATH_CONFLICT",
                $"'{conflict}' is listed in both changedPaths and removedPaths.",
                "List a file either as changed (still exists, content changed) or as removed (deleted), never both.");
        }

        progress.Report("update", $"Updating {device} from {deviceDir}");

        try
        {
            using var session = ComponentProvenanceStore.Session.Open(dbPath);

            // 2. Map the changed paths onto stored components. Exact match only: a
            //    path that is not a stored `relative_path` was never imported, and
            //    guessing which component the caller meant is what a full rebuild
            //    exists to avoid.
            var changedComponents = new List<Candidate>();
            foreach (var path in changed)
            {
                var stored = Lookup(session.Connection, session.Transaction, path)
                    ?? throw new EngineException(
                        "UPDATE_UNKNOWN_COMPONENT",
                        $"'{path}' is not a component of the knowledge database at '{dbPath}'.",
                        "Pass the device-relative path exactly as the export wrote it (e.g. blocks/010_Cell/FC.xml), or run a full Ingest if the export layout changed.");
                changedComponents.Add(stored);
            }

            // Removed paths: a file that was never imported has nothing to remove, so
            // an unknown removed path is reported rather than refused (a sync reports
            // deletions that this database may never have covered).
            var removedComponents = new List<Candidate>();
            var ignoredRemoved = new List<string>();
            foreach (var path in removed)
            {
                var stored = Lookup(session.Connection, session.Transaction, path);
                if (stored is null)
                {
                    ignoredRemoved.Add(path);
                    continue;
                }

                removedComponents.Add(stored);
            }

            // 3. One dependency hop over the OLD graph state: components owning an
            //    edge that points at a node of a changed or removed component.
            var seeded = changedComponents
                .Concat(removedComponents)
                .Select(candidate => candidate.ComponentKey)
                .ToHashSet(StringComparer.Ordinal);
            var closureCandidates = FindInboundOwners(
                    session.Connection,
                    session.Transaction,
                    seeded)
                .Where(candidate => !seeded.Contains(candidate.ComponentKey))
                .ToList();

            var total = changedComponents.Count + closureCandidates.Count + removedComponents.Count;
            if (total > cap)
            {
                throw new EngineException(
                    "UPDATE_TOO_LARGE",
                    $"This update would touch {total} component(s) " +
                    $"({changedComponents.Count} changed, {closureCandidates.Count} in the dependency closure, " +
                    $"{removedComponents.Count} removed), over the limit of {cap}.",
                    "Run a full Ingest for this device: an update this wide is cheaper as a rebuild and cannot drift.");
            }

            // 4. Replacements: changed first (sorted), then the dependency closure
            //    (sorted) — NOT one interleaved list. See the file header for why this
            //    order is required.
            var orderedReplacements = changedComponents
                .OrderBy(candidate => candidate.RelativePath, StringComparer.Ordinal)
                .Concat(closureCandidates.OrderBy(candidate => candidate.RelativePath, StringComparer.Ordinal))
                .ToArray();
            foreach (var candidate in orderedReplacements)
            {
                progress.Report("update", $"Replacing {candidate.RelativePath}");
                var replacement = ImportComponent(deviceDir, candidate.RelativePath);
                ComponentProvenanceStore.ApplyReplace(
                    session.Connection,
                    session.Transaction,
                    replacement.Graph,
                    replacement.Component);
            }

            // 5. Removals, after the closure has been re-imported: a neighbour that
            //    still references the removed block keeps its edge, and the node then
            //    survives as a placeholder instead of being torn out mid-batch.
            foreach (var candidate in removedComponents.OrderBy(
                         candidate => candidate.RelativePath,
                         StringComparer.Ordinal))
            {
                progress.Report("update", $"Removing {candidate.RelativePath}");
                ComponentProvenanceStore.ApplyDelete(
                    session.Connection,
                    session.Transaction,
                    candidate.ComponentKey);
            }

            var (nodes, edges) = CountGraph(session.Connection, session.Transaction);
            session.CommitAfterRebuild();

            progress.Report(
                "update",
                $"Updated {changedComponents.Count} changed + {closureCandidates.Count} closure, " +
                $"removed {removedComponents.Count} component(s)");

            return new Result(
                device,
                dbPath,
                changedComponents.Count,
                removedComponents.Count,
                closureCandidates.Count,
                changedComponents.Select(candidate => candidate.RelativePath).OrderBy(path => path, StringComparer.Ordinal).ToArray(),
                closureCandidates.Select(candidate => candidate.RelativePath).OrderBy(path => path, StringComparer.Ordinal).ToArray(),
                removedComponents.Select(candidate => candidate.RelativePath).OrderBy(path => path, StringComparer.Ordinal).ToArray(),
                ignoredRemoved,
                cap,
                nodes,
                edges);
        }
        catch (ComponentProvenanceUnavailableException ex)
        {
            throw new EngineException(
                "UPDATE_REQUIRES_FULL_REBUILD",
                ex.Message,
                "Run Ingest for this device: only a database written by this engine version records the component provenance an update needs.");
        }
        catch (ComponentIdentityMismatchException ex)
        {
            throw new EngineException(
                "UPDATE_IDENTITY_CHANGED",
                $"{ex.Message} The file's stored identity (component key and relative path) no longer matches the export.",
                "Run a full Ingest for this device: a component whose identity changed (a block moved to another group, or the manifest no longer lists it) cannot be replaced in place.");
        }
    }

    /// <summary>
    /// Import one component, translating the importers' exceptions into the update's
    /// own codes. The transaction is rolled back by the caller's `using` when one of
    /// these escapes.
    /// </summary>
    private static (SemanticPlcGraph Graph, ComponentImport Component) ImportComponent(
        string deviceDir,
        string relativePath)
    {
        try
        {
            return ComponentProvenanceStore.ImportComponent(deviceDir, relativePath);
        }
        catch (ComponentIdentityMismatchException)
        {
            throw;
        }
        catch (ManifestInvalidException ex)
        {
            throw new EngineException(
                "UPDATE_SOURCE_UNREADABLE",
                $"'{relativePath}' could not be imported: {ex.Message}",
                "Fix the export (re-run the sync that produced this file) or run a full Ingest, which reports per-file warnings instead of refusing the batch.");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or XmlException)
        {
            throw new EngineException(
                "UPDATE_SOURCE_MISSING",
                $"'{relativePath}' could not be read: {ex.Message}",
                "A file listed as changed must still exist. List deleted files in removedPaths, or run a full Ingest.");
        }
    }

    /// <summary>
    /// The exact stored component for one device-relative path, or null.
    ///
    /// `relative_path` is UNIQUE in the schema, so at most one row matches; the match
    /// is ordinal (SQLite's default `=`), which is what "exact, no guessing" means.
    /// </summary>
    private static Candidate? Lookup(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string relativePath)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            SELECT component_key, relative_path
            FROM source_components
            WHERE relative_path = $relative_path;
            """;
        command.Parameters.AddWithValue("$relative_path", relativePath);
        using var reader = command.ExecuteReader();
        return reader.Read()
            ? new Candidate(reader.GetString(0), reader.GetString(1))
            : null;
    }

    /// <summary>
    /// Components that own an edge pointing at one of the seeded components' nodes.
    ///
    /// This is the one-hop closure the MVP agreed on. It reads the ownership tables
    /// rather than the graph alone, because "which component owns this edge" is
    /// exactly what tells a replacement from a bystander.
    /// </summary>
    private static IReadOnlyList<Candidate> FindInboundOwners(
        SqliteConnection connection,
        SqliteTransaction transaction,
        IReadOnlyCollection<string> seededComponentKeys)
    {
        if (seededComponentKeys.Count == 0)
        {
            return Array.Empty<Candidate>();
        }

        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        var parameterNames = new List<string>();
        var index = 0;
        foreach (var key in seededComponentKeys.OrderBy(value => value, StringComparer.Ordinal))
        {
            var name = $"$seeded{index++}";
            parameterNames.Add(name);
            command.Parameters.AddWithValue(name, key);
        }

        command.CommandText = $"""
            SELECT DISTINCT owner.component_key, stored.relative_path
            FROM source_component_nodes target
            JOIN graph_edges edge ON edge.to_node_id = target.node_id
            JOIN source_component_edges owner ON owner.edge_id = edge.id
            JOIN source_components stored ON stored.component_key = owner.component_key
            WHERE target.component_key IN ({string.Join(", ", parameterNames)})
            ORDER BY stored.relative_path;
            """;
        using var reader = command.ExecuteReader();
        var owners = new List<Candidate>();
        while (reader.Read())
        {
            owners.Add(new Candidate(reader.GetString(0), reader.GetString(1)));
        }

        return owners;
    }

    private static (long Nodes, long Edges) CountGraph(
        SqliteConnection connection,
        SqliteTransaction transaction)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT (SELECT COUNT(*) FROM graph_nodes), (SELECT COUNT(*) FROM graph_edges);";
        using var reader = command.ExecuteReader();
        return reader.Read()
            ? (reader.GetInt64(0), reader.GetInt64(1))
            : (0, 0);
    }

    /// <summary>
    /// Validate and normalize the caller's paths to the spelling the provenance table
    /// stores: forward slashes, no leading slash, no `.` or `..` segment.
    ///
    /// A rooted path or a traversal segment is refused (`UPDATE_PATH_INVALID`) rather
    /// than resolved: these are *device-relative* paths, and accepting an absolute one
    /// would silently point at a file outside the device the database describes.
    /// </summary>
    private static IReadOnlyList<string> NormalizePaths(
        IReadOnlyList<string>? paths,
        string parameterName)
    {
        if (paths is null || paths.Count == 0)
        {
            return Array.Empty<string>();
        }

        var normalized = new List<string>(paths.Count);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var raw in paths)
        {
            if (string.IsNullOrWhiteSpace(raw))
            {
                throw new EngineException(
                    "UPDATE_PATH_INVALID",
                    $"{parameterName} contains an empty path.",
                    "Pass device-relative paths such as blocks/010_Cell/FC.xml.");
            }

            var slashed = raw.Trim().Replace('\\', '/');
            var rooted = slashed.StartsWith('/') ||
                (slashed.Length > 1 && slashed[1] == ':');
            var segments = slashed.Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (rooted || segments.Length == 0 ||
                segments.Any(segment => segment == "." || segment == ".."))
            {
                throw new EngineException(
                    "UPDATE_PATH_INVALID",
                    $"'{raw}' is not a device-relative path.",
                    "Pass the path as the export wrote it, relative to the device directory (e.g. blocks/010_Cell/FC.xml).");
            }

            var value = string.Join('/', segments);
            if (seen.Add(value))
            {
                normalized.Add(value);
            }
        }

        return normalized;
    }
}
