// Self test for the vendored engine. Two independent checks:
//
//   1. a SQLite round trip through SqliteSemanticGraphStore — this is the only
//      thing that proves the native provider (e_sqlite3) actually loads at run
//      time, which compilation never proves;
//   2. when an export root is passed, a crawl of that tree through
//      ExportFolderCrawler — the real parse path (Simatic ML XML -> graph).
//
// Exit code 0 means every check that ran succeeded. It never touches the network
// and never needs TIA Portal.
namespace EngineeringGraph.Engine;

internal static class SelfTest
{
    internal static int Run(string? exportRoot)
    {
        var failures = 0;

        failures += CheckSqliteRoundTrip();
        if (!string.IsNullOrWhiteSpace(exportRoot))
        {
            failures += CheckExportCrawl(exportRoot);
        }
        else
        {
            Console.WriteLine("[skip] export crawl (no export root given)");
        }

        Console.WriteLine(failures == 0
            ? "self-test: OK"
            : $"self-test: {failures} check(s) FAILED");
        return failures == 0 ? 0 : 1;
    }

    private static int CheckSqliteRoundTrip()
    {
        var dbPath = Path.Combine(
            Path.GetTempPath(),
            $"{BuildInfo.Name}-self-test-{Guid.NewGuid():N}.db");
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
                $"[ok] sqlite round-trip: nodes={loaded.Nodes.Count} edges={loaded.Edges.Count} db={Path.GetFileName(dbPath)}");
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

            var byKind = result.Graph.Nodes
                .GroupBy(node => node.Kind)
                .OrderBy(group => group.Key, StringComparer.Ordinal)
                .Select(group => $"{group.Key}={group.Count()}");

            Console.WriteLine(
                $"[ok] export crawl ({result.Source}): filesFound={result.FilesFound} filesImported={result.FilesImported} " +
                $"nodes={result.Graph.Nodes.Count} edges={result.Graph.Edges.Count}");
            Console.WriteLine($"[crawl] by kind: {string.Join(", ", byKind)}");

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
