// Self test for the engine. Everything here is a check that a successful
// compilation cannot make:
//
//   1. a SQLite round trip through the store -- the only proof that the native
//      provider (e_sqlite3) actually loads at run time;
//   2. a crawl of a real export tree through the vendored parser;
//   3. the actual operation dispatch: Ingest writes a database, Query reads it
//      back, and the read-only guard refuses a write;
//   4. the incremental Update path (B4): a D24 device tree is ingested, one block
//      is mutated and updated in place, one block is removed, the three refusal
//      codes are triggered, and a mid-batch failure is proven to roll back.
//
// It never touches the network and never needs TIA Portal. Exit code 0 means
// every check that ran succeeded.
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace EngineeringGraph.Engine;

internal static class SelfTest
{
    internal static int Run(string? deviceDir)
    {
        var failures = 0;

        failures += CheckSqliteRoundTrip();

        if (string.IsNullOrWhiteSpace(deviceDir))
        {
            Console.WriteLine("[skip] export crawl and operations (no export root given)");
        }
        else
        {
            failures += CheckExportCrawl(deviceDir);
            failures += CheckOperations(deviceDir);
            failures += CheckIncrementalUpdate(deviceDir);
        }

        Console.WriteLine(failures == 0
            ? "self-test: OK"
            : $"self-test: {failures} check(s) FAILED");
        return failures == 0 ? 0 : 1;
    }

    private static int CheckSqliteRoundTrip()
    {
        var dbPath = TempDbPath();
        try
        {
            var graph = new SemanticPlcGraph();
            graph.UpsertNode(new SemanticGraphNode(
                "self-test:project",
                SemanticNodeKind.Project,
                "self-test"));
            graph.UpsertNode(new SemanticGraphNode(
                "self-test:block",
                SemanticNodeKind.FunctionBlock,
                "SelfTest"));
            graph.UpsertEdge(new SemanticGraphEdge(
                "self-test:edge",
                "self-test:project",
                "self-test:block",
                SemanticRelationshipType.Contains));

            SqliteSemanticGraphStore.Save(dbPath, graph);
            var loaded = SqliteSemanticGraphStore.Load(dbPath);

            if (loaded.Nodes.Count != 2 || loaded.Edges.Count != 1)
            {
                Console.WriteLine(
                    $"[FAIL] sqlite round-trip: expected 2 nodes / 1 edge, got {loaded.Nodes.Count} / {loaded.Edges.Count}");
                return 1;
            }

            Console.WriteLine(
                $"[ok] sqlite round-trip: nodes={loaded.Nodes.Count} edges={loaded.Edges.Count}");
            return 0;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[FAIL] sqlite round-trip: {ex.GetType().Name}: {ex.Message}");
            return 1;
        }
        finally
        {
            TryDelete(dbPath);
        }
    }

    private static int CheckExportCrawl(string deviceDir)
    {
        try
        {
            if (!Directory.Exists(deviceDir))
            {
                Console.WriteLine($"[FAIL] export crawl: '{deviceDir}' is not a directory");
                return 1;
            }

            var result = ExportFolderCrawler.Import(
                deviceDir,
                progress: message => Console.WriteLine($"[crawl] {message}"));

            var byKind = string.Join(", ", result.Graph.Nodes
                .GroupBy(node => node.Kind)
                .OrderBy(group => group.Key, StringComparer.Ordinal)
                .Select(group => $"{group.Key}={group.Count()}"));

            Console.WriteLine(
                $"[ok] export crawl ({result.Source}): filesFound={result.FilesFound} filesImported={result.FilesImported} " +
                $"nodes={result.Graph.Nodes.Count} edges={result.Graph.Edges.Count}");
            Console.WriteLine($"[crawl] by kind: {byKind}");

            foreach (var warning in result.Warnings)
            {
                Console.WriteLine($"[crawl] warning: {warning}");
            }

            if (result.FilesImported == 0)
            {
                Console.WriteLine("[FAIL] export crawl: nothing was imported");
                return 1;
            }

            return 0;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[FAIL] export crawl: {ex.GetType().Name}: {ex.Message}");
            return 1;
        }
    }

    /// <summary>
    /// Drives the same dispatch the protocol uses, so this covers ingestion,
    /// querying and the read-only guard rather than the operations in isolation.
    /// </summary>
    private static int CheckOperations(string deviceDir)
    {
        var dbPath = TempDbPath();
        try
        {
            var ingest = Program.Execute(
                "self-test",
                OperationCatalog.Ingest,
                new JsonObject { ["deviceDir"] = deviceDir, ["dbPath"] = dbPath },
                NullProgressSink.Instance);

            var ingestError = DescribeError(ingest);
            if (ingestError is not null)
            {
                Console.WriteLine($"[FAIL] ingest: {ingestError}");
                return 1;
            }

            var ingestData = ingest["data"] as JsonObject;
            Console.WriteLine(
                $"[ok] ingest: filesFound={ingestData?["filesFound"]} filesImported={ingestData?["filesImported"]} " +
                $"nodes={ingestData?["nodes"]} edges={ingestData?["edges"]}");

            var query = Program.Execute(
                "self-test",
                OperationCatalog.Query,
                new JsonObject
                {
                    ["dbPath"] = dbPath,
                    ["sql"] = "SELECT kind, COUNT(*) AS count FROM graph_nodes GROUP BY kind ORDER BY kind;",
                },
                NullProgressSink.Instance);

            var queryError = DescribeError(query);
            if (queryError is not null)
            {
                Console.WriteLine($"[FAIL] query: {queryError}");
                return 1;
            }

            var queryData = query["data"] as JsonObject;
            var columns = queryData?["columns"] as JsonArray;
            if (columns is null)
            {
                Console.WriteLine("[FAIL] query: the result carried no columns");
                return 1;
            }

            var rows = queryData?["rows"] as JsonArray;
            Console.WriteLine($"[ok] query: columns={columns.Count} rows={rows?.Count ?? 0}");

            // The read-only guard must refuse a write even though the caller is the
            // engine itself: it is the backstop, not a convenience.
            var write = Program.Execute(
                "self-test",
                OperationCatalog.Query,
                new JsonObject { ["dbPath"] = dbPath, ["sql"] = "DROP TABLE graph_nodes;" },
                NullProgressSink.Instance);

            var writeCode = (write["error"] as JsonObject)?["code"]?.GetValue<string>();
            if (write["ok"]?.GetValue<bool>() != false || writeCode != "QUERY_REJECTED")
            {
                Console.WriteLine($"[FAIL] read-only guard: a DROP was not rejected with QUERY_REJECTED (got {writeCode ?? "ok=true"})");
                return 1;
            }

            Console.WriteLine("[ok] read-only guard: DROP rejected with QUERY_REJECTED");
            return 0;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[FAIL] operations: {ex.GetType().Name}: {ex.Message}");
            return 1;
        }
        finally
        {
            TryDelete(dbPath);
        }
    }

    /// <summary>
    /// The incremental `Update` operation against a real D24 device tree.
    ///
    /// A plain fixture crawl (like <see cref="CheckExportCrawl"/>) would not be enough:
    /// the production layout is the manifest one, and it is the one whose component
    /// provenance this check has to prove. So the tree is built under the OS temp
    /// directory from two real exports plus a hand-written `_manifest.json`, ingested,
    /// then mutated the way a sync would mutate it.
    /// </summary>
    private static int CheckIncrementalUpdate(string fixturesDir)
    {
        var root = Path.Combine(Path.GetTempPath(), $"{Protocol.EngineName}-update-{Guid.NewGuid():N}");
        var deviceDir = Path.Combine(root, "source", "UpdateFixture");
        var dbPath = Path.Combine(root, "knowledge", "UpdateFixture", "UpdateFixture_knowledge.db");
        const string mainRelative = "blocks/Main [OB1].xml";
        const string fcRelative = "blocks/010_Cell/FC_LAD_SimulateCylinder_Call [FC1].xml";
        const string sclRelative = "blocks/SclAssign [FC10].xml";

        try
        {
            var blocksDir = Path.Combine(deviceDir, "blocks");
            var groupDir = Path.Combine(blocksDir, "010_Cell");
            Directory.CreateDirectory(groupDir);
            var mainPath = Path.Combine(blocksDir, "Main [OB1].xml");
            var fcPath = Path.Combine(groupDir, "FC_LAD_SimulateCylinder_Call [FC1].xml");
            var sclPath = Path.Combine(blocksDir, "SclAssign [FC10].xml");
            File.Copy(Path.Combine(fixturesDir, "Main [OB1].xml"), mainPath);
            File.Copy(
                Path.Combine(fixturesDir, "FC_LAD_SimulateCylinder_Call [FC1].xml"),
                fcPath);
            File.Copy(Path.Combine(fixturesDir, "SclAssign [FC10].xml"), sclPath);
            WriteDeviceManifest(
                deviceDir,
                ("blocks", "Main", "", mainPath, "OB"),
                ("blocks", "FC_LAD_SimulateCylinder_Call", "010_Cell/", fcPath, "FC"),
                ("blocks", "SclAssign", "", sclPath, "FC"));

            var ingest = Program.Execute(
                "self-test",
                OperationCatalog.Ingest,
                new JsonObject { ["deviceDir"] = deviceDir, ["dbPath"] = dbPath },
                NullProgressSink.Instance);
            var ingestError = DescribeError(ingest);
            if (ingestError is not null)
            {
                Console.WriteLine($"[FAIL] incremental update: ingest failed: {ingestError}");
                return 1;
            }

            var componentsBefore = ScalarLong(dbPath, "SELECT COUNT(*) FROM source_components;");
            var hashBefore = ScalarString(
                dbPath,
                "SELECT content_hash FROM source_components WHERE relative_path = $path;",
                ("$path", fcRelative));
            var mainNodesBefore = ComponentNodeCount(dbPath, mainRelative);
            var nodesBefore = ScalarLong(dbPath, "SELECT COUNT(*) FROM graph_nodes;");
            var edgesBefore = ScalarLong(dbPath, "SELECT COUNT(*) FROM graph_edges;");
            if (componentsBefore != 3 ||
                hashBefore is null ||
                mainNodesBefore == 0 ||
                nodesBefore == 0 ||
                edgesBefore == 0)
            {
                Console.WriteLine(
                    $"[FAIL] incremental update: the manifest ingest left no usable provenance " +
                    $"(components={componentsBefore} hash={(hashBefore is null ? "null" : "set")} " +
                    $"mainNodes={mainNodesBefore} nodes={nodesBefore} edges={edgesBefore})");
                return 1;
            }

            if (ScalarLong(dbPath, "SELECT COUNT(*) FROM graph_nodes WHERE id = 'symbol:btn_forward';") != 1)
            {
                Console.WriteLine("[FAIL] incremental update: the fixture's symbol:btn_forward was not imported");
                return 1;
            }

            // 1. Mutate one block exactly like a rename of an interface member: the
            //    interface declaration and the network access are the same text, so a
            //    single replace changes both.
            var mutated = File.ReadAllText(fcPath).Replace(
                "\"btn_forward\"",
                "\"btn_forward_renamed\"",
                StringComparison.Ordinal);
            File.WriteAllText(fcPath, mutated);

            var update = Program.Execute(
                "self-test",
                OperationCatalog.Update,
                new JsonObject
                {
                    ["deviceDir"] = deviceDir,
                    ["dbPath"] = dbPath,
                    ["changedPaths"] = new JsonArray(fcRelative),
                },
                NullProgressSink.Instance);
            var updateError = DescribeError(update);
            if (updateError is not null)
            {
                Console.WriteLine($"[FAIL] incremental update: update failed: {updateError}");
                return 1;
            }

            var data = update["data"] as JsonObject;
            var changed = data?["changed"]?.GetValue<int>() ?? -1;
            var closure = data?["closure"]?.GetValue<int>() ?? -1;
            var removed = data?["removed"]?.GetValue<int>() ?? -1;
            var closurePaths = (data?["closureComponents"] as JsonArray)?
                .Select(node => node?.GetValue<string>() ?? string.Empty)
                .ToArray() ?? Array.Empty<string>();
            var hashAfter = ScalarString(
                dbPath,
                "SELECT content_hash FROM source_components WHERE relative_path = $path;",
                ("$path", fcRelative));
            var expectedHash = ComponentKeys.ContentHashOf(File.ReadAllBytes(fcPath));
            var mainNodesAfter = ComponentNodeCount(dbPath, mainRelative);
            var callsSurvived = ScalarLong(
                dbPath,
                """
                SELECT COUNT(*)
                FROM graph_edges
                WHERE type = 'CALLS'
                  AND from_node_id = 'block:Main'
                  AND to_node_id = 'block:FC_LAD_SimulateCylinder_Call';
                """);
            var oldSymbolGone = ScalarLong(dbPath, "SELECT COUNT(*) FROM graph_nodes WHERE id = 'symbol:btn_forward';") == 0;
            var newSymbolPresent = ScalarLong(
                dbPath,
                "SELECT COUNT(*) FROM graph_nodes WHERE id = 'symbol:btn_forward_renamed';") == 1;

            if (changed != 1 || closure < 1 || removed != 0 ||
                !closurePaths.Contains(mainRelative, StringComparer.Ordinal) ||
                hashAfter is null || string.Equals(hashAfter, hashBefore, StringComparison.Ordinal) ||
                !string.Equals(hashAfter, expectedHash, StringComparison.Ordinal) ||
                !oldSymbolGone || !newSymbolPresent ||
                mainNodesAfter != mainNodesBefore ||
                callsSurvived != 1)
            {
                Console.WriteLine(
                    $"[FAIL] incremental update: changed={changed} closure={closure} removed={removed} " +
                    $"closurePaths=[{string.Join(", ", closurePaths)}] " +
                    $"hashChanged={!string.Equals(hashAfter, hashBefore, StringComparison.Ordinal)} " +
                    $"hashMatchesFile={string.Equals(hashAfter, expectedHash, StringComparison.Ordinal)} " +
                    $"oldSymbolGone={oldSymbolGone} newSymbolPresent={newSymbolPresent} " +
                    $"mainNodes={mainNodesBefore}->{mainNodesAfter} callsSurvived={callsSurvived}");
                return 1;
            }

            // The database still opens as a graph after an in-place update.
            var loaded = SqliteSemanticGraphStore.Load(dbPath);
            if (loaded.Nodes.Count == 0)
            {
                Console.WriteLine("[FAIL] incremental update: the updated database loads as an empty graph");
                return 1;
            }

            Console.WriteLine(
                $"[ok] incremental update: changed={changed} closure={closure} " +
                $"closurePaths=[{string.Join(", ", closurePaths)}] " +
                $"nodes={data?["nodes"]} edges={data?["edges"]}");

            // 2. A deleted block is removed from the database, and its neighbours keep
            //    their node counts.
            File.Delete(sclPath);
            var mainNodesBeforeRemoval = ComponentNodeCount(dbPath, mainRelative);
            var removal = Program.Execute(
                "self-test",
                OperationCatalog.Update,
                new JsonObject
                {
                    ["deviceDir"] = deviceDir,
                    ["dbPath"] = dbPath,
                    ["removedPaths"] = new JsonArray(sclRelative, "blocks/NotInTheDatabase.xml"),
                },
                NullProgressSink.Instance);
            var removalError = DescribeError(removal);
            if (removalError is not null)
            {
                Console.WriteLine($"[FAIL] incremental removal: {removalError}");
                return 1;
            }

            var removalData = removal["data"] as JsonObject;
            var removedCount = removalData?["removed"]?.GetValue<int>() ?? -1;
            var ignored = (removalData?["ignoredRemovedPaths"] as JsonArray)?
                .Select(node => node?.GetValue<string>() ?? string.Empty)
                .ToArray() ?? Array.Empty<string>();
            var sclComponentGone = ScalarLong(
                dbPath,
                "SELECT COUNT(*) FROM source_components WHERE relative_path = $path;",
                ("$path", sclRelative)) == 0;
            var sclNodeGone = ScalarLong(
                dbPath,
                "SELECT COUNT(*) FROM graph_nodes WHERE id = 'block:SclAssign';") == 0;
            if (removedCount != 1 || !sclComponentGone || !sclNodeGone ||
                !ignored.Contains("blocks/NotInTheDatabase.xml", StringComparer.Ordinal) ||
                ComponentNodeCount(dbPath, mainRelative) != mainNodesBeforeRemoval)
            {
                Console.WriteLine(
                    $"[FAIL] incremental removal: removed={removedCount} componentGone={sclComponentGone} " +
                    $"nodeGone={sclNodeGone} ignored=[{string.Join(", ", ignored)}]");
                return 1;
            }

            Console.WriteLine(
                $"[ok] incremental removal: removed={removedCount} ignoredUnknown={ignored.Length} " +
                $"nodes={removalData?["nodes"]} edges={removalData?["edges"]}");

            // 3. The refusal codes: a database without provenance, an unknown changed
            //    path, and a batch over the component cap.
            var plainDb = Path.Combine(root, "plain.db");
            SqliteSemanticGraphStore.Save(plainDb, new SemanticPlcGraph());
            var requiresRebuild = Program.Execute(
                "self-test",
                OperationCatalog.Update,
                new JsonObject
                {
                    ["deviceDir"] = deviceDir,
                    ["dbPath"] = plainDb,
                    ["changedPaths"] = new JsonArray(fcRelative),
                },
                NullProgressSink.Instance);
            var unknown = Program.Execute(
                "self-test",
                OperationCatalog.Update,
                new JsonObject
                {
                    ["deviceDir"] = deviceDir,
                    ["dbPath"] = dbPath,
                    ["changedPaths"] = new JsonArray("blocks/NotInTheDatabase.xml"),
                },
                NullProgressSink.Instance);
            var tooLarge = Program.Execute(
                "self-test",
                OperationCatalog.Update,
                new JsonObject
                {
                    ["deviceDir"] = deviceDir,
                    ["dbPath"] = dbPath,
                    ["changedPaths"] = new JsonArray(fcRelative, mainRelative),
                    ["maxComponents"] = 1,
                },
                NullProgressSink.Instance);

            var requiresRebuildCode = ErrorCode(requiresRebuild);
            var unknownCode = ErrorCode(unknown);
            var tooLargeCode = ErrorCode(tooLarge);
            if (requiresRebuildCode != "UPDATE_REQUIRES_FULL_REBUILD" ||
                unknownCode != "UPDATE_UNKNOWN_COMPONENT" ||
                tooLargeCode != "UPDATE_TOO_LARGE")
            {
                Console.WriteLine(
                    $"[FAIL] update refusals: expected REQUIRES_FULL_REBUILD/UNKNOWN_COMPONENT/TOO_LARGE, " +
                    $"got {requiresRebuildCode ?? "ok"} / {unknownCode ?? "ok"} / {tooLargeCode ?? "ok"}");
                return 1;
            }

            Console.WriteLine(
                "[ok] update refusals: UPDATE_REQUIRES_FULL_REBUILD, UPDATE_UNKNOWN_COMPONENT, UPDATE_TOO_LARGE");

            // 4. Atomicity: the first changed component (the FC, sorted first) has
            //    already been replaced inside the transaction when the second one's
            //    file turns out to be missing. The whole batch must be rolled back.
            var hashBeforeFailedBatch = ScalarString(
                dbPath,
                "SELECT content_hash FROM source_components WHERE relative_path = $path;",
                ("$path", fcRelative));
            var nodesBeforeFailedBatch = ScalarLong(dbPath, "SELECT COUNT(*) FROM graph_nodes;");
            var edgesBeforeFailedBatch = ScalarLong(dbPath, "SELECT COUNT(*) FROM graph_edges;");
            var backup = mainPath + ".bak";
            File.Move(mainPath, backup);
            var failedBatch = Program.Execute(
                "self-test",
                OperationCatalog.Update,
                new JsonObject
                {
                    ["deviceDir"] = deviceDir,
                    ["dbPath"] = dbPath,
                    ["changedPaths"] = new JsonArray(fcRelative, mainRelative),
                },
                NullProgressSink.Instance);
            var failedCode = ErrorCode(failedBatch);
            File.Move(backup, mainPath);
            var hashAfterFailedBatch = ScalarString(
                dbPath,
                "SELECT content_hash FROM source_components WHERE relative_path = $path;",
                ("$path", fcRelative));
            var nodesAfterFailedBatch = ScalarLong(dbPath, "SELECT COUNT(*) FROM graph_nodes;");
            var edgesAfterFailedBatch = ScalarLong(dbPath, "SELECT COUNT(*) FROM graph_edges;");
            if (failedCode != "UPDATE_SOURCE_MISSING" ||
                !string.Equals(hashAfterFailedBatch, hashBeforeFailedBatch, StringComparison.Ordinal) ||
                nodesAfterFailedBatch != nodesBeforeFailedBatch ||
                edgesAfterFailedBatch != edgesBeforeFailedBatch)
            {
                Console.WriteLine(
                    $"[FAIL] update atomicity: {DescribeError(failedBatch) ?? "ok"} " +
                    $"hashRestored={string.Equals(hashAfterFailedBatch, hashBeforeFailedBatch, StringComparison.Ordinal)} " +
                    $"nodes={nodesBeforeFailedBatch}->{nodesAfterFailedBatch} " +
                    $"edges={edgesBeforeFailedBatch}->{edgesAfterFailedBatch}");
                return 1;
            }

            Console.WriteLine("[ok] update atomicity: a failed batch left the database unchanged");
            return 0;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[FAIL] incremental update: {ex.GetType().Name}: {ex.Message}");
            return 1;
        }
        finally
        {
            TryDeleteDirectory(root);
        }
    }

    /// <summary>Write the family-1 `_manifest.json` for the self test's device tree.</summary>
    private static void WriteDeviceManifest(
        string deviceDir,
        params (string Category, string Name, string Group, string File, string SimaticType)[] entries)
    {
        var device = Path.GetFileName(deviceDir);
        var blocks = new JsonArray();
        foreach (var entry in entries)
        {
            blocks.Add(new JsonObject
            {
                ["category"] = entry.Category,
                ["name"] = entry.Name,
                ["group"] = entry.Group,
                ["file"] = entry.File,
                ["simaticType"] = entry.SimaticType,
            });
        }

        var manifest = new JsonObject
        {
            ["schemaVersion"] = 1,
            ["generatedBy"] = "self-test",
            ["device"] = device,
            ["software"] = device,
            ["outputDir"] = deviceDir,
            ["failureCount"] = 0,
            ["blocks"] = blocks,
        };
        File.WriteAllText(
            Path.Combine(deviceDir, DeviceManifest.FileName),
            manifest.ToJsonString(Json.Wire));
    }

    /// <summary>How many graph nodes the component at one relative path owns.</summary>
    private static long ComponentNodeCount(string dbPath, string relativePath) =>
        ScalarLong(
            dbPath,
            """
            SELECT COUNT(*)
            FROM source_component_nodes ownership
            WHERE ownership.component_key = (
                SELECT component_key FROM source_components WHERE relative_path = $path
            );
            """,
            ("$path", relativePath));

    /// <summary>One scalar count/string read through a fresh read-only connection.</summary>
    private static long ScalarLong(
        string dbPath,
        string sql,
        params (string Name, string Value)[] parameters) =>
        Convert.ToInt64(Scalar(dbPath, sql, parameters));

    private static string? ScalarString(
        string dbPath,
        string sql,
        params (string Name, string Value)[] parameters)
    {
        var value = Scalar(dbPath, sql, parameters);
        return value is null || value == DBNull.Value ? null : Convert.ToString(value);
    }

    private static object? Scalar(
        string dbPath,
        string sql,
        params (string Name, string Value)[] parameters)
    {
        SqliteSemanticGraphStore.EnsureSqliteInitialized();
        using var connection = new SqliteConnection($"Data Source={dbPath}");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        foreach (var parameter in parameters)
        {
            command.Parameters.AddWithValue(parameter.Name, parameter.Value);
        }

        var value = command.ExecuteScalar();
        return value;
    }

    private static string? ErrorCode(JsonObject frame) =>
        frame["ok"]?.GetValue<bool>() == true
            ? null
            : (frame["error"] as JsonObject)?["code"]?.GetValue<string>();

    private static string? DescribeError(JsonObject frame)
    {
        if (frame["ok"]?.GetValue<bool>() == true)
        {
            return null;
        }

        var error = frame["error"] as JsonObject;
        return $"{error?["code"]}: {error?["message"]}";
    }

    private static string TempDbPath() =>
        Path.Combine(Path.GetTempPath(), $"{Protocol.EngineName}-self-test-{Guid.NewGuid():N}.db");

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
            // A leftover temp file must not turn a passing self test into a failure.
        }
    }

    /// <summary>
    /// Best-effort removal of a temp directory this check created under the OS temp
    /// folder. No junction or link is involved, so a recursive delete is safe here.
    /// </summary>
    private static void TryDeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path))
            {
                Directory.Delete(path, recursive: true);
            }
        }
        catch
        {
            // Same rule as TryDelete: cleanup cannot fail the check.
        }
    }
}
