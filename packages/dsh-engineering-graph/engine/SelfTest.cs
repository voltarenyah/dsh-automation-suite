// Self test for the engine. Everything here is a check that a successful
// compilation cannot make:
//
//   1. a SQLite round trip through the store -- the only proof that the native
//      provider (e_sqlite3) actually loads at run time;
//   2. a crawl of a real export tree through the vendored parser;
//   3. the actual operation dispatch: Ingest writes a database, Query reads it
//      back, and the read-only guard refuses a write.
//
// It never touches the network and never needs TIA Portal. Exit code 0 means
// every check that ran succeeded.
using System.Text.Json.Nodes;

namespace EngineeringGraph.Engine;

internal static class SelfTest
{
    internal static int Run(string? exportRoot)
    {
        var failures = 0;

        failures += CheckSqliteRoundTrip();

        if (string.IsNullOrWhiteSpace(exportRoot))
        {
            Console.WriteLine("[skip] export crawl and operations (no export root given)");
        }
        else
        {
            failures += CheckExportCrawl(exportRoot);
            failures += CheckOperations(exportRoot);
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

    private static int CheckExportCrawl(string exportRoot)
    {
        try
        {
            if (!Directory.Exists(exportRoot))
            {
                Console.WriteLine($"[FAIL] export crawl: '{exportRoot}' is not a directory");
                return 1;
            }

            var result = ExportFolderCrawler.Import(
                exportRoot,
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
    private static int CheckOperations(string exportRoot)
    {
        var dbPath = TempDbPath();
        try
        {
            var ingest = Program.Execute(
                "self-test",
                OperationCatalog.Ingest,
                new JsonObject { ["exportRoot"] = exportRoot, ["dbPath"] = dbPath },
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
}
