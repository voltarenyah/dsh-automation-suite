using System;
using System.Collections.Generic;
using System.Globalization;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>Transport constants shared by every frame on the NDJSON channel.</summary>
    internal static class Protocol
    {
        /// <summary>Bumped whenever a frame or error-code meaning changes.</summary>
        public const int Version = 1;

        public const string ControllerName = "TiaOpennessV17Min.Controller";

        /// <summary>Frame written once by the controller when the stdio channel is ready.</summary>
        public const string ReadyFrame = "ready";

        /// <summary>Frame carrying one request outcome.</summary>
        public const string ResultFrame = "result";

        /// <summary>Frame carrying one in-flight progress notification for a request.</summary>
        public const string ProgressFrame = "progress";

        /// <summary>Frame carrying an asynchronous controller-level note (not tied to a request).</summary>
        public const string LogFrame = "log";
    }

    /// <summary>
    /// The complete set of Openness operations the controller will execute.
    ///
    /// This is a security boundary, not a convenience list: the controller never
    /// evaluates caller-supplied code and never dispatches a name outside this
    /// catalog. Anything else is rejected with <c>unsupported_operation</c>.
    ///
    /// The order is part of the wire contract: it is what the ready frame and
    /// <c>--help</c> print, and <c>scripts/coverage/build-matrix.mjs</c> compares
    /// the list with <c>src/protocol.ts</c>'s <c>OPERATIONS</c> entry by entry.
    /// </summary>
    internal static class OperationCatalog
    {
        // The original block read/write surface.
        public const string OpenProject = "OpenProject";
        public const string ExportBlocks = "ExportBlocks";
        public const string ImportBlocks = "ImportBlocks";
        public const string CompilePlc = "CompilePlc";
        public const string CloseProject = "CloseProject";

        // "Functions for projects and project data" (OperationsProject.cs).
        public const string CreateProject = "CreateProject";
        public const string SaveProject = "SaveProject";
        public const string ArchiveProject = "ArchiveProject";
        public const string ProjectInfo = "ProjectInfo";
        public const string ProjectLanguages = "ProjectLanguages";
        public const string ProjectTexts = "ProjectTexts";
        public const string UpdateProject = "UpdateProject";
        public const string PortalSettings = "PortalSettings";

        // "Functions for accessing the data of a PLC device" (OperationsPlc.cs).
        public const string ListPlcObjects = "ListPlcObjects";
        public const string CreatePlcObjects = "CreatePlcObjects";
        public const string DeletePlcObjects = "DeletePlcObjects";
        public const string WriteTags = "WriteTags";
        public const string SetBlockAttributes = "SetBlockAttributes";
        public const string ProtectBlocks = "ProtectBlocks";
        public const string GenerateSource = "GenerateSource";
        public const string WatchAndForceTables = "WatchAndForceTables";
        public const string SoftwareUnits = "SoftwareUnits";

        // "F-related Openness" (OperationsSafety.cs).
        public const string SafetyStatus = "SafetyStatus";
        public const string SetSafetySettings = "SetSafetySettings";
        public const string SafetySignatures = "SafetySignatures";

        private static readonly string[] Names =
        {
            OpenProject, ExportBlocks, ImportBlocks, CompilePlc, CloseProject,
            CreateProject, SaveProject, ArchiveProject, ProjectInfo, ProjectLanguages, ProjectTexts, UpdateProject,
            PortalSettings,
            ListPlcObjects, CreatePlcObjects, DeletePlcObjects, WriteTags, SetBlockAttributes, ProtectBlocks,
            GenerateSource, WatchAndForceTables, SoftwareUnits,
            SafetyStatus, SetSafetySettings, SafetySignatures,
        };

        /// <summary>The whitelist in declaration order; used by diagnostics and the self test.</summary>
        public static IList<string> All { get { return Array.AsReadOnly(Names); } }

        public static bool IsAllowed(string operation)
        {
            if (string.IsNullOrEmpty(operation)) return false;
            for (int i = 0; i < Names.Length; i++)
            {
                if (string.Equals(Names[i], operation, StringComparison.Ordinal)) return true;
            }
            return false;
        }
    }

    /// <summary>
    /// A structured operation failure. The code is stable and part of the wire
    /// contract; the message is written for a human reading a tool result.
    /// </summary>
    internal sealed class ControllerException : Exception
    {
        public ControllerException(string code, string message)
            : this(code, message, null, null)
        {
        }

        public ControllerException(string code, string message, JsonObject details)
            : this(code, message, details, null)
        {
        }

        public ControllerException(string code, string message, JsonObject details, JsonObject partialData)
            : base(message)
        {
            Code = code;
            Details = details;
            PartialData = partialData;
        }

        /// <summary>Stable machine-readable error code.</summary>
        public string Code { get; private set; }

        /// <summary>Extra error context placed under <c>error.details</c>.</summary>
        public JsonObject Details { get; private set; }

        /// <summary>
        /// Data that is still meaningful after the failure (for example, the
        /// verification report of a write that was applied but failed
        /// verification). Placed under <c>data</c> even when <c>ok</c> is false.
        /// </summary>
        public JsonObject PartialData { get; private set; }

        public JsonObject ToErrorJson()
        {
            JsonObject error = new JsonObject();
            error.Add("code", Code);
            error.Add("message", Message);
            if (Details != null) error.Add("details", Details);
            return error;
        }
    }

    /// <summary>Ordered diagnostic log attached to one request outcome.</summary>
    internal sealed class DiagnosticLog
    {
        private readonly List<JsonObject> _items = new List<JsonObject>();

        public void Info(string message) { Add("info", message, null); }

        public void Info(string message, string source) { Add("info", message, source); }

        public void Warning(string message) { Add("warning", message, null); }

        public void Warning(string message, string source) { Add("warning", message, source); }

        public void Error(string message) { Add("error", message, null); }

        public void Error(string message, string source) { Add("error", message, source); }

        public void Add(string level, string message, string source)
        {
            JsonObject item = new JsonObject();
            item.Add("level", level);
            item.Add("message", message);
            if (!string.IsNullOrEmpty(source)) item.Add("source", source);
            _items.Add(item);
        }

        public IList<JsonObject> Items { get { return _items; } }

        public bool HasErrors
        {
            get
            {
                foreach (JsonObject item in _items)
                {
                    foreach (KeyValuePair<string, object> pair in item)
                    {
                        if (pair.Key == "level" && Equals(pair.Value, "error")) return true;
                    }
                }
                return false;
            }
        }
    }

    /// <summary>Ordered record of what the operation actually did to the project or the file system.</summary>
    internal sealed class ChangeLog
    {
        private readonly List<JsonObject> _items = new List<JsonObject>();

        public void Add(string kind, string target, string action) { Add(kind, target, action, null); }

        public void Add(string kind, string target, string action, string detail)
        {
            JsonObject item = new JsonObject();
            item.Add("kind", kind);
            item.Add("target", target);
            item.Add("action", action);
            if (!string.IsNullOrEmpty(detail)) item.Add("detail", detail);
            _items.Add(item);
        }

        public IList<JsonObject> Items { get { return _items; } }

        public int Count { get { return _items.Count; } }
    }

    /// <summary>
    /// Progress sink for one in-flight request. The stdio server writes a
    /// <c>progress</c> frame per notification; the one-shot CLI writes to stderr.
    /// </summary>
    internal interface IProgressSink
    {
        void Report(string phase, string message);
    }

    /// <summary>Progress sink that discards notifications.</summary>
    internal sealed class NullProgressSink : IProgressSink
    {
        public static readonly NullProgressSink Instance = new NullProgressSink();

        public void Report(string phase, string message) { }
    }

    /// <summary>Progress sink that collects notifications into the request diagnostics.</summary>
    internal sealed class DiagnosticProgressSink : IProgressSink
    {
        private readonly DiagnosticLog _log;

        public DiagnosticProgressSink(DiagnosticLog log) { _log = log; }

        public void Report(string phase, string message) { _log.Info(message, "progress:" + phase); }
    }

    /// <summary>Small helpers shared by the operation implementations.</summary>
    internal static class Text
    {
        public static string Elapsed(long milliseconds)
        {
            if (milliseconds < 1000) return milliseconds.ToString(CultureInfo.InvariantCulture) + " ms";
            return (milliseconds / 1000.0).ToString("0.0", CultureInfo.InvariantCulture) + " s";
        }

        public static string Quote(string value)
        {
            return value == null ? "<null>" : "'" + value + "'";
        }
    }
}
