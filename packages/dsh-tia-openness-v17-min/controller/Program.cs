using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>
    /// The controller entry point.
    ///
    /// Three modes: a stdio server (default) that answers newline-delimited JSON
    /// requests, a one-shot CLI that performs one operation and exits, and a self
    /// test that exercises everything which does not need TIA Portal.
    ///
    /// Nothing in this file references a Siemens.Engineering type: the concrete
    /// runner is created behind <see cref="CreateRunner"/>, so a machine without a
    /// usable Openness installation still starts, prints a ready banner and answers
    /// with a structured <c>openness_unavailable</c> error.
    /// </summary>
    internal static class Program
    {
        private const string ControllerVersion = "0.1.0";

        [STAThread]
        private static int Main(string[] argv)
        {
            TrySetUtf8Console();

            Options options;
            try
            {
                options = Options.Parse(argv);
            }
            catch (ControllerException ex)
            {
                // Always one line: an argument failure must stay machine-readable
                // even though --pretty may not have been seen yet.
                WriteFrame(Frames.Result(null, null, false, null, ex, null, null, DateTime.UtcNow), false);
                return 2;
            }

            if (options.ShowHelp)
            {
                Console.Out.Write(HelpText());
                Console.Out.Flush();
                return 0;
            }

            if (options.ShowVersion)
            {
                WriteFrame(Frames.Version(ControllerVersion), true);
                return 0;
            }

            // The assembly resolution is intentionally NOT installed here. Siemens'
            // resolver is initialized lazily, right before the first operation
            // (see OpennessBootstrap), which keeps the controller able to start and
            // report a structured reason on a machine without a usable Openness
            // installation — and keeps --self-test free of Openness assemblies.
            string opennessDir = AssemblyResolver.ConfiguredOpennessDir(options.OpennessDir);

            if (options.SelfTest) return SelfTest.Run(ControllerVersion, opennessDir);

            if (!string.IsNullOrEmpty(options.Operation)) return RunOnce(options, opennessDir);

            return RunServer(options, opennessDir);
        }

        // ------------------------------------------------------------------ modes

        private static int RunServer(Options options, string opennessDir)
        {
            DiagnosticLog bannerLog = new DiagnosticLog();
            JsonObject probe = OpennessBootstrap.Probe(opennessDir, AssemblyResolver.CandidateDirectories);
            WriteFrame(Frames.Ready(ControllerVersion, opennessDir, probe, GroupMembership.Probe()), false);

            IOperationRunner runner = null;
            int served = 0;
            try
            {
                string line;
                while ((line = Console.In.ReadLine()) != null)
                {
                    if (string.IsNullOrWhiteSpace(line)) continue;

                    DiagnosticLog log = new DiagnosticLog();
                    ChangeLog changes = new ChangeLog();
                    DateTime started = DateTime.UtcNow;
                    string id = null;
                    string operation = null;

                    try
                    {
                        JsonArgs request = JsonArgs.Parse(line);
                        id = request.String("id", null);
                        string frameType = request.String("type", "operation");
                        if (!string.Equals(frameType, "operation", StringComparison.OrdinalIgnoreCase))
                        {
                            throw new ControllerException("unsupported_frame",
                                "Only 'operation' frames are accepted; the controller received type "
                                    + Text.Quote(frameType) + ".",
                                JsonObject.Of("type", frameType));
                        }

                        operation = request.String("operation", null);
                        if (string.IsNullOrEmpty(operation))
                        {
                            throw new ControllerException("invalid_params", "Every request needs an 'operation' name.",
                                JsonObject.Of("allowed", OperationCatalog.All));
                        }

                        JsonArgs parameters = request.Object("params");

                        if (runner == null)
                        {
                            runner = CreateRunner(bannerLog, opennessDir);
                        }

                        IProgressSink progress = new FrameProgressSink(id);
                        JsonObject data = runner.Invoke(operation, parameters, log, changes, progress);
                        WriteFrame(Frames.Result(id, operation, true, data, null, changes, log, started), false);
                    }
                    catch (ControllerException ex)
                    {
                        WriteFrame(Frames.Result(id, operation, false, ex.PartialData, ex, changes, log, started), false);
                    }
                    catch (Exception ex)
                    {
                        ControllerException mapped = MapFailure(ex, opennessDir);
                        WriteFrame(Frames.Result(id, operation, false, null, mapped, changes, log, started), false);
                    }

                    served++;
                }
            }
            finally
            {
                if (runner != null)
                {
                    try
                    {
                        runner.Dispose();
                    }
                    catch (Exception ex)
                    {
                        try
                        {
                            WriteFrame(JsonObject.Of(
                                "type", Protocol.LogFrame,
                                "level", "warning",
                                "message", "Shutting the Openness session down failed: " + ex.Message), false);
                        }
                        catch (Exception)
                        {
                            // The channel is already gone.
                        }
                    }
                }

                // Released after the project and the portal are gone: the resolver
                // session is what keeps the Openness assemblies resolvable.
                OpennessBootstrap.Shutdown(bannerLog);
            }

            try
            {
                DiagnosticLog shutdown = new DiagnosticLog();
                shutdown.Info("The request channel closed after " + served + " operation(s); the controller is exiting.");
                WriteFrame(Frames.Result(null, null, true, JsonObject.Of("servedOperations", served), null, null, shutdown, DateTime.UtcNow), false);
            }
            catch (Exception)
            {
                // Nothing left to write to.
            }
            return 0;
        }

        private static int RunOnce(Options options, string opennessDir)
        {
            DiagnosticLog log = new DiagnosticLog();
            ChangeLog changes = new ChangeLog();
            DateTime started = DateTime.UtcNow;

            JsonObject data = null;
            ControllerException error = null;
            IOperationRunner runner = null;
            try
            {
                JsonArgs parameters = options.BuildArguments();
                runner = CreateRunner(log, opennessDir);
                data = runner.Invoke(options.Operation, parameters, log, changes, new StderrProgressSink());
            }
            catch (ControllerException ex)
            {
                error = ex;
                data = ex.PartialData;
            }
            catch (Exception ex)
            {
                error = MapFailure(ex, opennessDir);
            }
            finally
            {
                if (runner != null)
                {
                    try
                    {
                        runner.Dispose();
                    }
                    catch (Exception ex)
                    {
                        log.Warning("Shutting the Openness session down failed: " + ex.Message);
                    }
                }
            }

            WriteFrame(Frames.Result(null, options.Operation, error == null, data, error, changes, log, started), options.Pretty);
            return error == null ? 0 : 2;
        }

        // --------------------------------------------------------------- factories

        /// <summary>
        /// Creates the Openness operation runner. Kept in its own method so that a
        /// missing or unusable Siemens.Engineering.dll surfaces as a caught
        /// failure instead of a JIT-time crash of the request loop.
        /// </summary>
        private static IOperationRunner CreateRunner(DiagnosticLog log, string opennessDir)
        {
            JsonObject probe = OpennessBootstrap.Probe(opennessDir, AssemblyResolver.CandidateDirectories);
            if (!JsonObject.ReadBool(probe, "available", false))
            {
                throw new ControllerException(
                    "openness_unavailable",
                    JsonObject.ReadString(probe, "message",
                        "TIA Portal V17 Openness is not available on this machine."),
                    probe);
            }

            // First touch of the Openness world: Siemens' resolver is initialized
            // here, before any Siemens.Engineering type is used.
            OpennessBootstrap.EnsureInitialized(opennessDir, log);

            JsonObject resolverState = OpennessBootstrap.Description;
            log.Info(JsonObject.ReadBool(resolverState, "initialized", false)
                ? "Openness is resolved by Siemens' assembly resolver "
                    + JsonObject.ReadString(resolverState, "resolverVersion", "?")
                    + " (TIA Portal V" + OpennessBootstrap.TiaPortalMajorVersion
                    + ", location source: " + JsonObject.ReadString(resolverState, "tiaPortalLocationFrom", "?") + ")."
                : "Siemens' assembly resolver is not initialized; the controller falls back to its own probe.",
                "resolver");

            try
            {
                return new OpennessOperations(log);
            }
            catch (Exception ex)
            {
                throw MapFailure(ex, opennessDir);
            }
        }

        /// <summary>
        /// Maps an unexpected exception onto the structured error vocabulary. The
        /// activation failures of the Openness assemblies are the important cases:
        /// they mean the controller cannot run at all until the installation or the
        /// build target is fixed.
        /// </summary>
        private static ControllerException MapFailure(Exception ex, string opennessDir)
        {
            if (ex is ControllerException) return (ControllerException)ex;

            if (ex is TypeLoadException || ex is FileNotFoundException || ex is FileLoadException
                || ex is BadImageFormatException || ex is MissingMethodException || ex is MissingFieldException
                || ex is TypeInitializationException || ex is System.IO.IOException)
            {
                JsonObject details = JsonObject.Of(
                    "exceptionType", ex.GetType().FullName,
                    "opennessDir", opennessDir,
                    "resolver", OpennessBootstrap.Description,
                    "processArchitecture", Environment.Is64BitProcess ? "x64" : "x86");
                details.AddIfPresent("innerException", ex.InnerException == null ? null : ex.InnerException.Message);
                details.Add("hint", "The controller is bound to TIA Portal V17 Openness and resolves it through Siemens' "
                    + "own assembly resolver. Confirm that TIA Portal V17 is installed, that this process is 64-bit, and "
                    + "that the controller was built with a NuGet restore (--openness-dir or TiaPortalLocation overrides "
                    + "the auto discovery).");
                return new ControllerException(
                    "openness_load_failed",
                    "The TIA Portal V17 Openness assemblies could not be used: " + ex.GetType().Name + ": " + ex.Message,
                    details);
            }

            JsonObject generic = JsonObject.Of(
                "exceptionType", ex.GetType().FullName,
                "hresult", "0x" + ex.HResult.ToString("X8", CultureInfo.InvariantCulture));
            generic.AddIfPresent("innerException", ex.InnerException == null ? null : ex.InnerException.Message);
            return new ControllerException("internal_error", ex.GetType().Name + ": " + ex.Message, generic);
        }

        // ---------------------------------------------------------------- helpers

        private static void TrySetUtf8Console()
        {
            try
            {
                UTF8Encoding encoding = new UTF8Encoding(false);
                Console.OutputEncoding = encoding;
                Console.InputEncoding = encoding;
            }
            catch (Exception)
            {
                // A redirected or already-owned console handle can refuse this; the
                // caller-side escaping of non-ASCII JSON keeps the channel correct.
            }
        }

        private static void WriteFrame(JsonObject frame, bool pretty)
        {
            string line = JsonWriter.Write(frame, pretty);
            Console.Out.Write(line);
            Console.Out.Write('\n');
            Console.Out.Flush();
        }

        private static string HelpText()
        {
            StringBuilder sb = new StringBuilder();
            sb.AppendLine("TiaOpennessV17Min.Controller " + ControllerVersion + " - TIA Portal V17 Openness block access.");
            sb.AppendLine();
            sb.AppendLine("Usage:");
            sb.AppendLine("  TiaOpennessV17Min.Controller [--stdio] [--openness-dir <dir>]");
            sb.AppendLine("      Serve newline-delimited JSON requests on stdin/stdout.");
            sb.AppendLine();
            sb.AppendLine("  TiaOpennessV17Min.Controller --operation <Name> [--param k=v]... [--params-json <json>] [--pretty]");
            sb.AppendLine("      Perform exactly one operation and exit (0 = ok, 2 = structured failure).");
            sb.AppendLine();
            sb.AppendLine("  TiaOpennessV17Min.Controller --self-test [--pretty]");
            sb.AppendLine("      Check the protocol, JSON, Simatic ML and whitelist behaviour without TIA Portal.");
            sb.AppendLine();
            sb.AppendLine("  TiaOpennessV17Min.Controller --version | --help");
            sb.AppendLine();
            sb.AppendLine("Whitelisted operations:");
            foreach (string name in OperationCatalog.All) sb.AppendLine("  " + name);
            sb.AppendLine();
            sb.AppendLine("Environment:");
            sb.AppendLine("  TIA_OPENNESS_V17_DIR   Preferred Openness folder (default "
                + AssemblyResolver.DefaultOpennessDir + ").");
            sb.AppendLine("  TiaPortalLocation      Read by Siemens' own assembly resolver; also set from");
            sb.AppendLine("                         --openness-dir. Registry discovery is used otherwise.");
            return sb.ToString();
        }
    }

    /// <summary>Command line options of the controller.</summary>
    internal sealed class Options
    {
        private readonly List<KeyValuePair<string, string>> _parameters = new List<KeyValuePair<string, string>>();

        public string OpennessDir;
        public bool ShowHelp;
        public bool ShowVersion;
        public bool SelfTest;
        public bool Pretty;
        public string Operation;
        public string ParamsJson;

        public static Options Parse(string[] argv)
        {
            Options options = new Options();
            if (argv == null) return options;

            for (int i = 0; i < argv.Length; i++)
            {
                string argument = argv[i];
                string inlineValue = null;
                int equals = argument == null ? -1 : argument.IndexOf('=');
                if (argument != null && argument.StartsWith("--", StringComparison.Ordinal) && equals > 0)
                {
                    inlineValue = argument.Substring(equals + 1);
                    argument = argument.Substring(0, equals);
                }

                switch (argument)
                {
                    case "--help":
                    case "-h":
                        options.ShowHelp = true;
                        break;
                    case "--version":
                    case "-V":
                        options.ShowVersion = true;
                        break;
                    case "--self-test":
                        options.SelfTest = true;
                        break;
                    case "--pretty":
                        options.Pretty = true;
                        break;
                    case "--stdio":
                        break;
                    case "--openness-dir":
                        options.OpennessDir = inlineValue ?? Next(argv, ref i, argument);
                        break;
                    case "--operation":
                        options.Operation = inlineValue ?? Next(argv, ref i, argument);
                        break;
                    case "--params-json":
                        options.ParamsJson = inlineValue ?? Next(argv, ref i, argument);
                        break;
                    case "--param":
                        string pair = inlineValue ?? Next(argv, ref i, argument);
                        int split = pair.IndexOf('=');
                        if (split <= 0)
                        {
                            throw new ControllerException("invalid_params",
                                "--param expects key=value, but received " + Text.Quote(pair) + ".");
                        }
                        options._parameters.Add(new KeyValuePair<string, string>(pair.Substring(0, split), pair.Substring(split + 1)));
                        break;
                    default:
                        throw new ControllerException("invalid_params",
                            "Unknown argument " + Text.Quote(argument) + ". Run with --help for the accepted options.");
                }
            }
            return options;
        }

        private static string Next(string[] argv, ref int index, string argument)
        {
            if (index + 1 >= argv.Length)
            {
                throw new ControllerException("invalid_params", argument + " requires a value.");
            }
            index++;
            return argv[index];
        }

        /// <summary>
        /// Builds the parameter object. Repeated <c>--param</c> keys become arrays,
        /// which is what the list-valued parameters of ImportBlocks and
        /// ExportBlocks need on the command line.
        /// </summary>
        public JsonArgs BuildArguments()
        {
            if (!string.IsNullOrWhiteSpace(ParamsJson)) return JsonArgs.Parse(ParamsJson);

            Dictionary<string, object> values = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (KeyValuePair<string, string> parameter in _parameters)
            {
                object existing;
                if (!values.TryGetValue(parameter.Key, out existing))
                {
                    values.Add(parameter.Key, Scalar(parameter.Value));
                    continue;
                }

                List<object> list = existing as List<object>;
                if (list == null)
                {
                    list = new List<object>();
                    list.Add(existing);
                    values[parameter.Key] = list;
                }
                list.Add(Scalar(parameter.Value));
            }
            return JsonArgs.FromValue(values, "parameters");
        }

        private static object Scalar(string value)
        {
            if (string.Equals(value, "true", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(value, "false", StringComparison.OrdinalIgnoreCase)) return false;
            int number;
            if (int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out number)) return number;
            return value;
        }
    }

    /// <summary>Builds the frames of the NDJSON protocol.</summary>
    internal static class Frames
    {
        public static JsonObject Version(string controllerVersion)
        {
            JsonObject frame = new JsonObject();
            frame.Add("type", Protocol.LogFrame);
            frame.Add("controller", Protocol.ControllerName);
            frame.Add("controllerVersion", controllerVersion);
            frame.Add("protocol", Protocol.Version);
            frame.Add("runtime", Environment.Version.ToString());
            frame.Add("framework", FrameRuntimeDescription());
            frame.Add("processArchitecture", Environment.Is64BitProcess ? "x64" : "x86");
            frame.Add("operations", OperationCatalog.All);
            return frame;
        }

        public static JsonObject Ready(string controllerVersion, string opennessDir, JsonObject probe, JsonObject userGroup)
        {
            JsonObject frame = new JsonObject();
            frame.Add("type", Protocol.ReadyFrame);
            frame.Add("protocol", Protocol.Version);
            frame.Add("controller", Protocol.ControllerName);
            frame.Add("controllerVersion", controllerVersion);
            frame.Add("pid", System.Diagnostics.Process.GetCurrentProcess().Id);
            frame.Add("startedAt", DateTime.UtcNow);
            frame.Add("runtime", Environment.Version.ToString());
            frame.Add("framework", FrameRuntimeDescription());
            frame.Add("processArchitecture", Environment.Is64BitProcess ? "x64" : "x86");
            frame.Add("userName", Environment.UserName);
            frame.Add("machineName", Environment.MachineName);
            frame.Add("openness", probe);
            frame.Add("opennessUserGroup", userGroup);
            frame.Add("operations", OperationCatalog.All);
            frame.Add("notes", new List<string>
            {
                "Only the five whitelisted operations are executed; the controller never evaluates caller-supplied code.",
                "Operations are serialized on one thread because Openness objects are not thread safe.",
                "Closing stdin shuts the controller down and closes the open project and the TIA Portal instance it started.",
            });
            return frame;
        }

        public static JsonObject Progress(string id, string phase, string message)
        {
            JsonObject frame = new JsonObject();
            frame.Add("type", Protocol.ProgressFrame);
            frame.AddIfPresent("id", id);
            frame.Add("phase", phase);
            frame.Add("message", message);
            frame.Add("time", DateTime.UtcNow);
            return frame;
        }

        public static JsonObject Result(string id, string operation, bool ok, JsonObject data, ControllerException error,
            ChangeLog changes, DiagnosticLog log, DateTime started)
        {
            JsonObject frame = new JsonObject();
            frame.Add("type", Protocol.ResultFrame);
            frame.Add("protocol", Protocol.Version);
            frame.AddIfPresent("id", id);
            frame.AddIfPresent("operation", operation);
            frame.Add("ok", ok);
            frame.Add("startedAt", started);
            frame.Add("durationMs", (long)(DateTime.UtcNow - started).TotalMilliseconds);
            if (data != null)
            {
                frame.Add("data", data);
                object dryRun = data["dryRun"];
                if (dryRun is bool) frame.Add("dryRun", dryRun);
            }
            if (changes != null) frame.Add("changes", changes.Items);
            if (log != null) frame.Add("diagnostics", log.Items);
            if (error != null) frame.Add("error", error.ToErrorJson());
            return frame;
        }

        private static string FrameRuntimeDescription()
        {
            try
            {
                return System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription;
            }
            catch (Exception)
            {
                return ".NET Framework";
            }
        }
    }

    /// <summary>Writes progress notifications as protocol frames.</summary>
    internal sealed class FrameProgressSink : IProgressSink
    {
        private readonly string _id;

        public FrameProgressSink(string id) { _id = id; }

        public void Report(string phase, string message)
        {
            try
            {
                string line = JsonWriter.Write(Frames.Progress(_id, phase, message), false);
                Console.Out.Write(line);
                Console.Out.Write('\n');
                Console.Out.Flush();
            }
            catch (Exception)
            {
                // Progress is best effort and must never fail a request.
            }
        }
    }

    /// <summary>Writes progress notifications to stderr, used by the one-shot CLI.</summary>
    internal sealed class StderrProgressSink : IProgressSink
    {
        public void Report(string phase, string message)
        {
            try
            {
                Console.Error.WriteLine("[" + phase + "] " + message);
                Console.Error.Flush();
            }
            catch (Exception)
            {
                // Best effort.
            }
        }
    }

    /// <summary>
    /// Reports whether the current Windows user is a member of the local group
    /// that authorises Openness access. A missing membership is the most common
    /// cause of an otherwise unexplained "access denied", so it is reported in the
    /// ready banner as a diagnostic.
    /// </summary>
    internal static class GroupMembership
    {
        public const string OpennessGroupName = "Siemens TIA Openness";

        public static JsonObject Probe()
        {
            JsonObject result = new JsonObject();
            result.Add("group", OpennessGroupName);
            try
            {
                System.Security.Principal.WindowsIdentity identity = System.Security.Principal.WindowsIdentity.GetCurrent();
                System.Security.Principal.NTAccount account = new System.Security.Principal.NTAccount(OpennessGroupName);
                System.Security.Principal.SecurityIdentifier identifier =
                    (System.Security.Principal.SecurityIdentifier)account.Translate(typeof(System.Security.Principal.SecurityIdentifier));

                bool member = false;
                foreach (System.Security.Principal.IdentityReference reference in identity.Groups)
                {
                    if (reference.Equals(identifier)) { member = true; break; }
                }

                result.Add("isMember", member);
                if (!member)
                {
                    result.Add("message", "The current Windows user is not a member of the local group '" + OpennessGroupName
                        + "'. TIA Portal Openness refuses to run for that user.");
                }
            }
            catch (Exception ex)
            {
                result.Add("isMember", null);
                result.Add("message", "Membership of '" + OpennessGroupName + "' could not be determined: " + ex.Message);
            }
            return result;
        }
    }
}
