// The engine's operations.
//
// SQL and validation logic are ported near-verbatim from the source library's
// MCP tool layer (Tools/KnowledgeTools.cs in the origin repository). That layer
// is *not* vendored as a whole -- it is coupled to the MCP SDK and to a
// CallToolResult envelope this engine does not have -- so the parts an operation
// needs were carried across function by function, keeping the statements
// unchanged. The origin line ranges are noted at each function.
//
// Deliberately NOT ported in this slice: the freshness/status logic (it lives in
// the consuming application in the origin, not in the engine; see
// docs/decisions.md D13) and the two audit columns the origin added later.
using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;
using System.Text.Json.Nodes;

namespace EngineeringGraph.Engine;

internal static class Operations
{
    /// <summary>Default row cap for <c>Query</c>; matches the origin.</summary>
    internal const int DefaultMaxRows = 200;

    /// <summary>Hard row cap for <c>Query</c>; matches the origin.</summary>
    internal const int HardMaxRows = 1000;

    private static string? _schemaVersion;

    /// <summary>
    /// The static schema payload: DDL, node kinds, edge types and example queries.
    /// No database is touched.
    /// </summary>
    /// <remarks>Ported from KnowledgeTools.SchemaPayload / ComputeSchemaVersion.</remarks>
    internal static object GetSchema(JsonObject? parameters)
    {
        var knownVersion = JsonParams.String(parameters, "knownVersion");
        var version = _schemaVersion ??= ComputeSchemaVersion();

        if (knownVersion is not null &&
            string.Equals(knownVersion, version, StringComparison.OrdinalIgnoreCase))
        {
            return new { version, unchanged = true };
        }

        return new
        {
            version,
            ddl = PlcSemanticGraphSqliteSchema.CreateScript,
            nodeKinds = SchemaVocabulary.NodeKinds,
            edgeTypes = SchemaVocabulary.EdgeTypes,
            exampleQueries = SchemaVocabulary.ExampleQueries,
            operations = OperationCatalog.All,
        };
    }

    /// <summary>Stable hash over the whole static payload.</summary>
    /// <remarks>Ported from KnowledgeTools.ComputeSchemaVersion.</remarks>
    private static string ComputeSchemaVersion()
    {
        var builder = new StringBuilder();
        builder.Append(PlcSemanticGraphSqliteSchema.CreateScript);
        foreach (var kind in SchemaVocabulary.NodeKinds)
        {
            builder.Append('|').Append(kind);
        }

        foreach (var edgeType in SchemaVocabulary.EdgeTypes)
        {
            builder.Append('|').Append(edgeType);
        }

        foreach (var query in SchemaVocabulary.ExampleQueries)
        {
            builder.Append('|').Append(query.Name).Append(':').Append(query.Sql);
        }

        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(builder.ToString())))
            .ToLowerInvariant();
    }

    /// <summary>
    /// Build (or rebuild) one device database from one export root. A full
    /// rebuild -- delete everything, bulk insert in one transaction.
    /// </summary>
    /// <remarks>Ported from KnowledgeTools.Ingest (the single-source path only).</remarks>
    internal static object Ingest(JsonObject? parameters, IProgressSink progress)
    {
        var exportRoot = JsonParams.String(parameters, "exportRoot")
            ?? throw new EngineException(
                "EXPORT_ROOT_REQUIRED",
                "exportRoot is required.",
                "Pass the device export folder, i.e. the directory that mcp-engineering / the TIA Openness plugin filled.");

        if (!Directory.Exists(exportRoot))
        {
            throw new EngineException(
                "EXPORT_ROOT_NOT_FOUND",
                $"Export root '{exportRoot}' was not found.",
                "Pass the folder filled by the export step (it contains the block XML, and usually _tia-openness-manifest.json).");
        }

        progress.Report("ingest", $"Crawling {exportRoot}");

        var import = ExportFolderCrawler.Import(
            exportRoot,
            message => progress.Report("ingest", message));

        if (import.FilesImported == 0)
        {
            var details = import.Warnings.Count == 0
                ? "No .xml files found."
                : string.Join(" ", import.Warnings);
            throw new EngineException(
                "NO_SOURCE_FILES",
                $"Nothing importable under '{exportRoot}': {import.FilesFound} .xml file(s) found, 0 imported. {details}",
                "Point exportRoot at a folder of TIA Openness block exports (SW.Blocks.* content).");
        }

        var dbPath = JsonParams.String(parameters, "dbPath")
            ?? Path.Combine(exportRoot, "plc-knowledge.db");

        progress.Report("ingest", $"Writing {dbPath}");
        SqliteSemanticGraphStore.Save(dbPath, import.Graph);

        var byKind = new SortedDictionary<string, int>(StringComparer.Ordinal);
        foreach (var group in import.Graph.Nodes.GroupBy(node => node.Kind))
        {
            byKind[group.Key] = group.Count();
        }

        return new
        {
            dbPath,
            source = import.Source,
            filesFound = import.FilesFound,
            filesImported = import.FilesImported,
            nodes = import.Graph.Nodes.Count,
            edges = import.Graph.Edges.Count,
            byKind,
            warnings = import.Warnings,
        };
    }

    /// <summary>
    /// Run one read-only SQL statement against a device database.
    ///
    /// Read-only is enforced twice on purpose: the statement is checked before it
    /// is sent, and the connection is opened in read-only mode as the backstop.
    /// </summary>
    /// <remarks>Ported from KnowledgeTools.RunQuery / ExecuteWithSchemaHint / ValidateReadOnlyStatement.</remarks>
    internal static object Query(JsonObject? parameters)
    {
        var dbPath = JsonParams.String(parameters, "dbPath")
            ?? throw new EngineException(
                "DB_PATH_REQUIRED",
                "dbPath is required.",
                "Pass the plc-knowledge.db produced by Ingest.");

        if (!File.Exists(dbPath))
        {
            throw new EngineException(
                "DB_NOT_FOUND",
                $"Database '{dbPath}' was not found.",
                "Run the Ingest operation first, or check the dbPath.");
        }

        var sql = JsonParams.String(parameters, "sql")
            ?? throw new EngineException(
                "SQL_REQUIRED",
                "sql is required.",
                "Pass a single SELECT, WITH or EXPLAIN statement.");

        var statement = ValidateReadOnlyStatement(sql);
        var limit = Math.Clamp(
            JsonParams.Int(parameters, "maxRows") ?? DefaultMaxRows,
            1,
            HardMaxRows);

        SqliteSemanticGraphStore.EnsureSqliteInitialized();
        var connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = dbPath,
            Mode = SqliteOpenMode.ReadOnly,
        }.ToString();

        using var connection = new SqliteConnection(connectionString);
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = statement;

        using var reader = ExecuteWithSchemaHint(command, connection);
        var columns = Enumerable.Range(0, reader.FieldCount).Select(reader.GetName).ToArray();
        var rows = new List<object?[]>();
        var truncated = false;

        while (reader.Read())
        {
            if (rows.Count == limit)
            {
                truncated = true;
                break;
            }

            var row = new object?[reader.FieldCount];
            for (var index = 0; index < row.Length; index++)
            {
                var value = reader.IsDBNull(index) ? null : reader.GetValue(index);
                row[index] = value is byte[] bytes ? Convert.ToBase64String(bytes) : value;
            }

            rows.Add(row);
        }

        return new { dbPath, columns, rows, rowCount = rows.Count, truncated };
    }

    /// <summary>
    /// Executes the reader; on SQLite errors (the model often guesses table names)
    /// the failure names the tables that actually exist, so the caller can correct
    /// the statement in its next round instead of giving up.
    /// </summary>
    private static SqliteDataReader ExecuteWithSchemaHint(SqliteCommand command, SqliteConnection connection)
    {
        try
        {
            return command.ExecuteReader();
        }
        catch (SqliteException ex)
        {
            throw new EngineException(
                "QUERY_INVALID_SQL",
                ex.Message,
                $"Check the statement against GetSchema (ddl + exampleQueries). Tables in this db: {ReadTableNames(connection)}.");
        }
    }

    private static string ReadTableNames(SqliteConnection connection)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;";
        using var reader = command.ExecuteReader();
        var names = new List<string>();
        while (reader.Read())
        {
            names.Add(reader.GetString(0));
        }

        return string.Join(", ", names);
    }

    private static string ValidateReadOnlyStatement(string sql)
    {
        if (string.IsNullOrWhiteSpace(sql))
        {
            throw new EngineException(
                "QUERY_REJECTED",
                "SQL must not be empty.",
                "Pass a single SELECT, WITH or EXPLAIN statement.");
        }

        var statement = sql.Trim();
        if (statement.EndsWith(';'))
        {
            statement = statement[..^1].TrimEnd();
        }

        if (statement.Length == 0 || statement.Contains(';'))
        {
            throw new EngineException(
                "QUERY_REJECTED",
                "Only a single statement is allowed.",
                "Remove the extra statements and run them as separate Query calls.");
        }

        if (!statement.StartsWith("SELECT", StringComparison.OrdinalIgnoreCase) &&
            !statement.StartsWith("WITH", StringComparison.OrdinalIgnoreCase) &&
            !statement.StartsWith("EXPLAIN", StringComparison.OrdinalIgnoreCase))
        {
            throw new EngineException(
                "QUERY_REJECTED",
                "Only read-only SELECT, WITH or EXPLAIN statements are allowed.",
                "Rewrite as a SELECT; the connection is opened read-only as a backstop.");
        }

        return statement;
    }
}
