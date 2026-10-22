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
        var deviceDir = JsonParams.String(parameters, "deviceDir")
            ?? throw new EngineException(
                "DEVICE_DIR_REQUIRED",
                "deviceDir is required.",
                "Pass the per-device folder, i.e. <project>/source/<device>.");

        if (!Directory.Exists(deviceDir))
        {
            throw new EngineException(
                "DEVICE_DIR_NOT_FOUND",
                $"Device source directory '{deviceDir}' was not found.",
                "Pass the per-device folder written by the export step, i.e. <project>/source/<device>.");
        }

        progress.Report("ingest", $"Crawling {deviceDir}");

        var import = ExportFolderCrawler.Import(
            deviceDir,
            message => progress.Report("ingest", message));

        if (import.FilesImported == 0)
        {
            var details = import.Warnings.Count == 0
                ? "No .xml files found."
                : string.Join(" ", import.Warnings);
            throw new EngineException(
                "NO_SOURCE_FILES",
                $"Nothing importable under '{deviceDir}': {import.FilesFound} .xml file(s) found, 0 imported. {details}",
                "Point device_dir at a device folder produced by the export step.");
        }

        var device = DeviceNameOf(deviceDir);
        var dbPath = JsonParams.String(parameters, "dbPath") ?? DefaultDbPath(deviceDir, device);

        progress.Report("ingest", $"Writing {dbPath}");
        SqliteSemanticGraphStore.Save(dbPath, import.Graph);

        var byKind = new SortedDictionary<string, int>(StringComparer.Ordinal);
        foreach (var group in import.Graph.Nodes.GroupBy(node => node.Kind))
        {
            byKind[group.Key] = group.Count();
        }

        return new
        {
            device,
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
    /// Refresh the components a sync touched, without re-parsing the whole device.
    ///
    /// A conservative incremental update over the provenance a full <see cref="Ingest"/>
    /// already records (`source_components` and the two ownership tables). Every case
    /// it cannot prove safe is a coded refusal whose remediation is "run Ingest"; see
    /// <see cref="IncrementalGraphUpdate"/> for the algorithm, the one-hop closure and
    /// the atomicity guarantee.
    ///
    /// Parameters: <c>deviceDir</c> (required, absolute), <c>dbPath</c> (optional,
    /// same default as Ingest), <c>changedPaths</c> / <c>removedPaths</c>
    /// (device-relative, forward or back slashes), <c>maxComponents</c> (optional,
    /// default <see cref="IncrementalGraphUpdate.DefaultMaxComponents"/>).
    /// </summary>
    internal static object Update(JsonObject? parameters, IProgressSink progress)
    {
        var deviceDir = JsonParams.String(parameters, "deviceDir")
            ?? throw new EngineException(
                "DEVICE_DIR_REQUIRED",
                "deviceDir is required.",
                "Pass the per-device folder the database was built from, i.e. <project>/source/<device>.");

        if (!Directory.Exists(deviceDir))
        {
            throw new EngineException(
                "DEVICE_DIR_NOT_FOUND",
                $"Device source directory '{deviceDir}' was not found.",
                "Pass the per-device folder written by the export step, i.e. <project>/source/<device>.");
        }

        var changedPaths = JsonParams.StringList(parameters, "changedPaths");
        var removedPaths = JsonParams.StringList(parameters, "removedPaths");
        if (changedPaths.Count == 0 && removedPaths.Count == 0)
        {
            throw new EngineException(
                "UPDATE_NOTHING_TO_DO",
                "The request named neither changedPaths nor removedPaths.",
                "Pass at least one device-relative path that the sync changed or removed; a full rebuild is a separate operation.");
        }

        var device = DeviceNameOf(deviceDir);
        var dbPath = JsonParams.String(parameters, "dbPath") ?? DefaultDbPath(deviceDir, device);
        var maxComponents = JsonParams.Int(parameters, "maxComponents")
            ?? IncrementalGraphUpdate.DefaultMaxComponents;

        return IncrementalGraphUpdate.Run(
            deviceDir,
            dbPath,
            changedPaths,
            removedPaths,
            maxComponents,
            progress);
    }

    /// <summary>
    /// The device's name as the source tree spells it: the last segment of
    /// <c>source/&lt;device&gt;</c>. The manifest's own `device` field is authoritative for the
    /// graph (it becomes a property of the project node); the directory is what names the
    /// output folder, so the two are reported separately rather than silently reconciled.
    /// </summary>
    private static string DeviceNameOf(string deviceDir) =>
        Path.GetFileName(Path.GetFullPath(deviceDir).TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar));

    /// <summary>
    /// Default database location, by the agreed convention (docs/decisions.md **D20**):
    /// <c>&lt;root&gt;/knowledge/&lt;device&gt;/&lt;device&gt;_knowledge.db</c>, where &lt;root&gt; is the
    /// directory holding <c>source/</c> — two levels up from the device directory. One folder
    /// per device holds everything generated for that device, and several devices mean several
    /// databases. An explicit <c>dbPath</c> always wins.
    /// </summary>
    private static string DefaultDbPath(string deviceDir, string device)
    {
        var full = Path.GetFullPath(deviceDir).TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar);
        var root = Path.GetDirectoryName(Path.GetDirectoryName(full)) ?? full;
        return Path.Combine(root, "knowledge", device, device + "_knowledge.db");
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
