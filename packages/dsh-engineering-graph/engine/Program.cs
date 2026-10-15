// Entry point for the dsh-engineering-graph engine.
//
// Four modes:
//
//   (no arguments)        serve the NDJSON operation protocol on stdio
//   --call <Op> [json]    run one operation once, print its result frame, exit
//   --self-test [root]    exercise the engine without a protocol peer
//   --version | --help    report identity / usage
//
// stdout carries frames and nothing else -- every human-readable note goes to
// stderr, exactly as the TIA Openness plugin's controller does, because a diagnostic on stdout
// would corrupt the channel.
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace EngineeringGraph.Engine;

internal static class Program
{
    /// <summary>UTF-8 without a BOM: the channel's contract, and a BOM would corrupt the first frame.</summary>
    private static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false);

    private static int Main(string[] args)
    {
        PinStandardStreams();

        if (args.Length > 0)
        {
            switch (args[0])
            {
                case "--version" or "-v":
                    Console.WriteLine($"{Protocol.EngineName} protocol {Protocol.Version}");
                    return 0;
                case "--help" or "-h":
                    PrintHelp();
                    return 0;
                case "--self-test":
                    return SelfTest.Run(args.Length > 1 ? args[1] : null);
                case "--call":
                    return CallOnce(args);
                default:
                    Console.Error.WriteLine($"unknown argument '{args[0]}' (try --help)");
                    return 2;
            }
        }

        return ServeStdio();
    }

    /// <summary>
    /// Pin stdout/stdin/stderr to UTF-8 instead of inheriting the environment.
    ///
    /// `Console.Out` is created against the console's code page when a console is
    /// attached -- a legacy page in many locales -- and that silently turns every
    /// non-ASCII code point into '?'. Redirected stdio already defaults to UTF-8, so
    /// the observable behaviour used to depend on *how* the engine was launched: the
    /// plugin's pipe was lossless while a human running <c>--call</c> in a terminal
    /// saw mangled non-ASCII. Network titles and object names in real projects are
    /// routinely non-ASCII, so the behaviour must not depend on the launch mode.
    ///
    /// Re-wrapping the streams (rather than assigning <c>Console.OutputEncoding</c>)
    /// is deliberate: that property mutates the *caller's* console code page, which
    /// is a side effect this process has no business causing.
    ///
    /// The line terminator is LF, per NDJSON. Autoflush keeps a frame from being lost
    /// when the process exits immediately after writing it.
    /// </summary>
    private static void PinStandardStreams()
    {
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), Utf8)
        {
            AutoFlush = true,
            NewLine = "\n",
        });
        Console.SetIn(new StreamReader(Console.OpenStandardInput(), Utf8));
        Console.SetError(new StreamWriter(Console.OpenStandardError(), Utf8)
        {
            AutoFlush = true,
            NewLine = "\n",
        });
    }

    private static void PrintHelp()
    {
        Console.WriteLine($"{Protocol.EngineName} (protocol {Protocol.Version})");
        Console.WriteLine();
        Console.WriteLine("Usage:");
        Console.WriteLine("  EngineeringGraph.Engine                 serve the NDJSON protocol on stdio");
        Console.WriteLine("  EngineeringGraph.Engine --call <Op> [json]");
        Console.WriteLine("  EngineeringGraph.Engine --self-test [exportRoot]");
        Console.WriteLine("  EngineeringGraph.Engine --version | --help");
        Console.WriteLine();
        Console.WriteLine("Operations: " + string.Join(", ", OperationCatalog.All));
    }

    /// <summary>
    /// One-shot CLI: run a single operation and print its result frame. This is
    /// how the engine is exercised end to end without a TypeScript peer, and how
    /// a human debugs a failing operation.
    /// </summary>
    private static int CallOnce(string[] args)
    {
        if (args.Length < 2)
        {
            Console.Error.WriteLine("--call needs an operation name (try --help)");
            return 2;
        }

        JsonObject? parameters = null;
        if (args.Length > 2 && !string.IsNullOrWhiteSpace(args[2]))
        {
            try
            {
                parameters = JsonNode.Parse(args[2]) as JsonObject;
            }
            catch (JsonException ex)
            {
                Console.Error.WriteLine($"params are not a JSON object: {ex.Message}");
                return 2;
            }

            if (parameters is null)
            {
                Console.Error.WriteLine("params must be a JSON object, e.g. '{\"dbPath\":\"x.db\"}'");
                return 2;
            }
        }

        var frame = Execute("cli", args[1], parameters, NullProgressSink.Instance);
        Console.WriteLine(frame.ToJsonString(Json.Wire));
        return frame["ok"]?.GetValue<bool>() == true ? 0 : 1;
    }

    /// <summary>
    /// Serve the protocol: announce readiness, then answer one request per line
    /// until stdin closes. Requests are serialized -- one at a time, in order --
    /// because the engine holds no concurrency of its own.
    /// </summary>
    private static int ServeStdio()
    {
        var stdout = Console.Out;
        WriteFrame(stdout, ReadyFrame());
        Console.Error.WriteLine($"{Protocol.EngineName}: ready (protocol {Protocol.Version}), operations: {string.Join(", ", OperationCatalog.All)}");

        string? line;
        while ((line = Console.In.ReadLine()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            JsonObject? request;
            try
            {
                request = JsonNode.Parse(line) as JsonObject;
            }
            catch (JsonException ex)
            {
                WriteFrame(stdout, ResultFrame(
                    null,
                    null,
                    null,
                    new EngineException(
                        "bad_request",
                        $"The request is not valid JSON: {ex.Message}",
                        "Send exactly one JSON object per line."),
                    0));
                continue;
            }

            if (request is null)
            {
                WriteFrame(stdout, ResultFrame(
                    null,
                    null,
                    null,
                    new EngineException(
                        "bad_request",
                        "The request is not a JSON object.",
                        "Send exactly one JSON object per line."),
                    0));
                continue;
            }

            var id = JsonParams.String(request, "id");
            var type = JsonParams.String(request, "type") ?? Protocol.OperationRequest;
            if (!string.Equals(type, Protocol.OperationRequest, StringComparison.OrdinalIgnoreCase))
            {
                WriteFrame(stdout, ResultFrame(
                    id,
                    null,
                    null,
                    new EngineException(
                        "unsupported_frame",
                        $"Frame type '{type}' is not supported.",
                        $"Send type '{Protocol.OperationRequest}'."),
                    0));
                continue;
            }

            var operation = JsonParams.String(request, "operation");
            var parameters = request["params"] as JsonObject;
            var frame = Execute(id, operation, parameters, new FrameProgressSink(stdout, id));
            WriteFrame(stdout, frame);
        }

        return 0;
    }

    /// <summary>
    /// Dispatch one operation, turning every failure into an error frame.
    /// Internal so the self test drives the same path the protocol does.
    /// </summary>
    internal static JsonObject Execute(
        string? id,
        string? operation,
        JsonObject? parameters,
        IProgressSink progress)
    {
        var started = Stopwatch.StartNew();

        if (!OperationCatalog.IsAllowed(operation))
        {
            return ResultFrame(
                id,
                operation,
                null,
                new EngineException(
                    "unsupported_operation",
                    $"'{operation ?? "(missing)"}' is not an operation this engine executes.",
                    $"Allowed operations: {string.Join(", ", OperationCatalog.All)}."),
                started.ElapsedMilliseconds);
        }

        try
        {
            var data = operation switch
            {
                OperationCatalog.GetSchema => Operations.GetSchema(parameters),
                OperationCatalog.Ingest => Operations.Ingest(parameters, progress),
                OperationCatalog.Query => Operations.Query(parameters),
                _ => throw new EngineException(
                    "unsupported_operation",
                    $"'{operation}' is not implemented.",
                    $"Allowed operations: {string.Join(", ", OperationCatalog.All)}."),
            };

            return ResultFrame(id, operation, data, null, started.ElapsedMilliseconds);
        }
        catch (EngineException ex)
        {
            return ResultFrame(id, operation, null, ex, started.ElapsedMilliseconds);
        }
        catch (Exception ex)
        {
            // An unexpected exception is an engine defect, not a caller error, and
            // saying so keeps the caller from hunting for a mistake it did not make.
            return ResultFrame(
                id,
                operation,
                null,
                new EngineException(
                    "internal_error",
                    $"{ex.GetType().Name}: {ex.Message}",
                    "This is an engine defect rather than a caller error."),
                started.ElapsedMilliseconds);
        }
    }

    private static JsonObject ReadyFrame() => new()
    {
        ["type"] = Protocol.ReadyFrame,
        ["protocol"] = Protocol.Version,
        ["engine"] = Protocol.EngineName,
        ["runtime"] = Environment.Version.ToString(),
        ["processArchitecture"] = Environment.Is64BitProcess ? "x64" : "x86",
        ["pid"] = Environment.ProcessId,
        ["operations"] = new JsonArray(OperationCatalog.All
            .Select(name => (JsonNode)JsonValue.Create(name)!)
            .ToArray()),
    };

    private static JsonObject ResultFrame(
        string? id,
        string? operation,
        object? data,
        EngineException? error,
        long durationMs)
    {
        var frame = new JsonObject
        {
            ["type"] = Protocol.ResultFrame,
            ["protocol"] = Protocol.Version,
            ["ok"] = error is null,
            ["durationMs"] = durationMs,
        };

        if (id is not null)
        {
            frame["id"] = id;
        }

        if (operation is not null)
        {
            frame["operation"] = operation;
        }

        if (data is not null)
        {
            frame["data"] = JsonSerializer.SerializeToNode(data, Json.Wire);
        }

        if (error is not null)
        {
            var errorNode = new JsonObject
            {
                ["code"] = error.Code,
                ["message"] = error.Message,
            };
            if (error.Remediation is not null)
            {
                errorNode["remediation"] = error.Remediation;
            }

            frame["error"] = errorNode;
        }

        return frame;
    }

    private static void WriteFrame(TextWriter writer, JsonObject frame)
    {
        writer.WriteLine(frame.ToJsonString(Json.Wire));
        writer.Flush();
    }

    /// <summary>Progress sink that emits <c>progress</c> frames for one request.</summary>
    private sealed class FrameProgressSink : IProgressSink
    {
        private readonly TextWriter _writer;
        private readonly string? _id;

        internal FrameProgressSink(TextWriter writer, string? id)
        {
            _writer = writer;
            _id = id;
        }

        public void Report(string phase, string message)
        {
            var frame = new JsonObject
            {
                ["type"] = Protocol.ProgressFrame,
                ["phase"] = phase,
                ["message"] = message,
            };
            if (_id is not null)
            {
                frame["id"] = _id;
            }

            WriteFrame(_writer, frame);
        }
    }
}
