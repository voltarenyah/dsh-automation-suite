// Transport layer for the engine's NDJSON channel.
//
// The shape is deliberately the same as the TIA Openness plugin's controller protocol
// (packages/dsh-tia-openness-v17-min/controller/Protocol.cs): a `ready` frame when
// the channel is up, one `result` frame per request, optional `progress` frames
// in between. Two things differ, both on purpose:
//
//   * JSON is System.Text.Json, not a hand-rolled writer. The TIA Openness plugin needed that
//     because it targets net48 with no dependencies; this engine is net8.
//   * Failures carry `code` / `message` / `remediation` / `details`, which is
//     the TIA Openness plugin's `code`/`message`/`details` plus the `remediation` field the
//     family-3 source used for every tool error. Keeping both loses nothing and
//     lets the TypeScript half render either.
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace EngineeringGraph.Engine;

/// <summary>Wire serialization settings, shared by every frame and by the self test.</summary>
internal static class Json
{
    internal static readonly JsonSerializerOptions Wire = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        // Non-ASCII text is kept readable instead of \uXXXX-escaped: network titles
        // and translated logic are routinely Chinese, and escaping roughly triples
        // their size on the wire.
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false,
    };
}

/// <summary>Transport constants shared by every frame on the NDJSON channel.</summary>
internal static class Protocol
{
    /// <summary>Bumped whenever a frame or error-code meaning changes.</summary>
    internal const string EngineName = "EngineeringGraph.Engine";

    /// <summary>Version of the frame contract, independent of the assembly version.</summary>
    internal const int Version = 1;

    /// <summary>Written once, when the stdio channel is ready for requests.</summary>
    internal const string ReadyFrame = "ready";

    /// <summary>Carries one request outcome.</summary>
    internal const string ResultFrame = "result";

    /// <summary>Carries one in-flight progress notification.</summary>
    internal const string ProgressFrame = "progress";

    /// <summary>Request type the server accepts; anything else is rejected.</summary>
    internal const string OperationRequest = "operation";
}

/// <summary>
/// The complete set of operations the engine will execute.
///
/// This is a security boundary, not a convenience list: the engine never
/// evaluates caller-supplied code and never dispatches a name outside this
/// catalog. Anything else is rejected with <c>unsupported_operation</c>.
///
/// The order is part of the wire contract -- it is what the ready frame prints --
/// and <c>src/protocol.ts</c>'s <c>OPERATIONS</c> must agree with it entry by
/// entry. <c>test/05-protocol.test.mjs</c> enforces that.
/// </summary>
internal static class OperationCatalog
{
    internal const string GetSchema = "GetSchema";
    internal const string Ingest = "Ingest";
    internal const string Query = "Query";

    private static readonly string[] Names = { GetSchema, Ingest, Query };

    /// <summary>The whitelist in declaration order; used by the ready frame and the self test.</summary>
    internal static IReadOnlyList<string> All => Names;

    internal static bool IsAllowed(string? operation) =>
        operation is not null && Array.IndexOf(Names, operation) >= 0;
}

/// <summary>
/// A structured operation failure. The code is stable and part of the wire
/// contract; the message is written for a human reading a tool result.
/// </summary>
internal sealed class EngineException : Exception
{
    internal EngineException(string code, string message, string? remediation = null)
        : base(message)
    {
        Code = code;
        Remediation = remediation;
    }

    /// <summary>Stable machine-readable error code.</summary>
    internal string Code { get; }

    /// <summary>What the caller should do next; rendered to the model as-is.</summary>
    internal string? Remediation { get; }
}

/// <summary>Progress sink for one in-flight request.</summary>
internal interface IProgressSink
{
    void Report(string phase, string message);
}

/// <summary>Progress sink that discards notifications.</summary>
internal sealed class NullProgressSink : IProgressSink
{
    internal static readonly NullProgressSink Instance = new();

    public void Report(string phase, string message)
    {
    }
}

/// <summary>
/// Typed reads over a request's <c>params</c> object. A missing value is null
/// rather than an exception, so each operation decides what is required.
/// </summary>
internal static class JsonParams
{
    internal static string? String(JsonObject? parameters, string name)
    {
        if (parameters is null || !parameters.TryGetPropertyValue(name, out var node) || node is null)
        {
            return null;
        }

        var value = node.GetValueKind() == System.Text.Json.JsonValueKind.String
            ? node.GetValue<string>()
            : node.ToJsonString().Trim('"');
        return string.IsNullOrWhiteSpace(value) ? null : value;
    }

    internal static int? Int(JsonObject? parameters, string name)
    {
        if (parameters is null || !parameters.TryGetPropertyValue(name, out var node) || node is null)
        {
            return null;
        }

        try
        {
            return node.GetValueKind() == System.Text.Json.JsonValueKind.Number
                ? node.GetValue<int>()
                : int.TryParse(node.ToString(), out var parsed) ? parsed : null;
        }
        catch (Exception ex) when (ex is InvalidOperationException or FormatException)
        {
            return null;
        }
    }
}
