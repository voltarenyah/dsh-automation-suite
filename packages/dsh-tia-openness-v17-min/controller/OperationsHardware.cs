using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using Siemens.Engineering;
using Siemens.Engineering.Cax;
using Siemens.Engineering.HW;
using Siemens.Engineering.HW.Features;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>
    /// The manual chapter "Importing/exporting hardware data": the CAx export of the
    /// project's hardware configuration.
    ///
    /// The manual topic "Export of CAx data" documents the only entry point:
    /// <c>project.GetService&lt;CaxProvider&gt;()</c> and
    /// <c>CaxProvider.Export(projectToExport, exportFilePath, logFilePath)</c>, where
    /// the second argument is the AML file and the third is TIA's log file. The
    /// result is a single AutomationML document (CAEX schema 2.15) covering the whole
    /// project — there is no <c>CaxExportOptions</c> in V17, so the export has no
    /// range or filter argument: project level means every device in one file.
    ///
    /// <para><b>What the return value means.</b> Measured on 2026-11-02 against
    /// <c>PEI_SinoARP_SWT2</c>: <c>Export</c> returned <c>false</c> while the log
    /// ended with "Exporting of the CAx data is completed (errors: 1, warnings: 0)"
    /// and the 1.4 MB AML was written completely. The single "error" was
    /// "device HMI_1 is being skipped. The required attribute TypeIdentifier is
    /// invalid or missing." — i.e. one object CAx cannot represent. So the boolean is
    /// "every object was exported", not "a file was produced": a <c>false</c> with a
    /// valid file is a partial success and is reported as data, not as a failure.</para>
    ///
    /// Only the read direction exists here. AML parsing is deliberately out of scope:
    /// the caller gets the file, its SHA-256, the log counters and the log's ERROR
    /// lines, not a structured model of the configuration.
    /// </summary>
    internal sealed partial class OpennessOperations
    {
        /// <summary>The file name used when the caller does not choose one.</summary>
        internal const string DefaultHardwareFileName = "globalHardware.aml";

        /// <summary>The only extension TIA accepts for a CAx export.</summary>
        private const string HardwareFileExtension = ".aml";

        /// <summary>The root element every CAEX 2.15 document opens with.</summary>
        private const string CaxRootMarker = "CAEXFile";

        /// <summary>
        /// How much of TIA's log is echoed into the payload — the <b>tail</b>, because
        /// the per-object progress fills the head and the summary/ERROR lines land at
        /// the end.
        /// </summary>
        private const int LogTailChars = 4000;

        /// <summary>Cap on the log file read at all; a 1 MB log is all INFO noise.</summary>
        private const long LogReadLimitBytes = 8L * 1024 * 1024;

        /// <summary>Cap on the ERROR lines carried in the payload.</summary>
        private const int LogProblemsLimit = 20;

        /// <summary>TIA's summary line: "… is completed (errors: 1, warnings: 0)".</summary>
        private static readonly Regex LogSummaryPattern =
            new Regex(@"completed\s*\(\s*errors\s*:\s*(\d+)\s*,\s*warnings\s*:\s*(\d+)\s*\)",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        /// <summary>One log line of the form "02.11.2026 12:36:27 PM: ERROR: …".</summary>
        private static readonly Regex LogProblemPattern =
            new Regex(@":\s*ERROR\s*:\s*(?<text>.+)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        /// <summary>
        /// TIA's per-device refusal: "device HMI_1 is being skipped. The required attribute
        /// TypeIdentifier is invalid or missing."
        /// </summary>
        private static readonly Regex SkippedDevicePattern =
            new Regex(@"device\s+(?<name>.+?)\s+is\s+being\s+skipped",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        // ------------------------------------------------ ExportHardwareConfig

        private JsonObject ExportHardwareConfig(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string outputDir;
            try
            {
                outputDir = Path.GetFullPath(p.RequiredString("output_dir").Trim().Trim('"'));
            }
            catch (Exception ex)
            {
                throw new ControllerException("invalid_params", "'output_dir' is not a valid path: " + ex.Message);
            }

            string fileName = HardwareFileName(p.String("file_name", null));
            bool overwrite = p.Bool("overwrite", true);

            string amlPath = Path.Combine(outputDir, fileName);
            // TIA writes the log as a sibling file. Deriving its name from the AML name
            // keeps one export to one predictable pair instead of scattering logs.
            string logPath = Path.ChangeExtension(amlPath, ".log");

            if (File.Exists(amlPath) && !overwrite)
            {
                throw new ControllerException(
                    "output_exists",
                    "The hardware configuration file " + Text.Quote(amlPath)
                        + " already exists and 'overwrite' is false. Pass overwrite=true to replace it, "
                        + "or choose another file_name.",
                    JsonObject.Of("path", amlPath));
            }

            try
            {
                Directory.CreateDirectory(outputDir);
            }
            catch (Exception ex)
            {
                throw new ControllerException("invalid_params",
                    "The output directory " + Text.Quote(outputDir) + " could not be created: " + ex.Message);
            }

            // A stale log from an earlier run must not be mistaken for this run's log.
            TryDelete(logPath, log);

            bool exported;
            int deviceCount;
            string logText;
            List<JsonObject> problems;
            List<JsonObject> notInAml;
            using (ExclusiveAccessScope scope = _host.BeginExclusiveAccess("CAx export of the hardware configuration"))
            {
                CaxProvider cax = CaxProviderOf();
                progress.Report("hardware", "Exporting the hardware configuration to " + amlPath + ".");

                try
                {
                    exported = cax.Export(_host.Project, new FileInfo(amlPath), new FileInfo(logPath));
                }
                catch (Exception ex)
                {
                    throw OpennessHost.OpennessFailure(
                        "cax_export_failed",
                        "TIA Portal refused to export the hardware configuration to " + Text.Quote(amlPath)
                            + ": " + ex.Message
                            + LogHint(logPath),
                        ex);
                }

                // Read back inside the same session: the log says what TIA skipped, and
                // the project model fills in those devices so the AML's gap is described
                // instead of merely reported.
                logText = ReadLog(logPath, log);
                problems = ParseLogProblems(logText);
                List<Device> devices = AllDevices();
                deviceCount = devices.Count;
                notInAml = DescribeMissingFromAml(problems, devices, log);
            }

            JsonObject counters = ParseLogCounters(logText);

            // The boolean is "every object was exported". Only a missing or empty file
            // means the export itself failed; a false with a valid file is a partial
            // success and must still be delivered.
            if (!File.Exists(amlPath) || new FileInfo(amlPath).Length == 0)
            {
                string what = exported
                    ? "TIA Portal reported a successful export, but no file exists at "
                    : "TIA Portal produced no file at ";
                throw new ControllerException(
                    exported ? "verification_failed" : "cax_export_failed",
                    what + Text.Quote(amlPath) + ". " + LogHint(logPath),
                    JsonObject.Of(
                        "path", amlPath,
                        "logPath", File.Exists(logPath) ? logPath : null,
                        "logSummary", counters,
                        "logProblems", problems,
                        "logExcerpt", Tail(logText, LogTailChars)));
            }

            JsonObject verified = VerifyCaxFile(amlPath);

            if (!exported)
            {
                log.Warning("TIA Portal reported that objects were skipped during the hardware export"
                    + (counters == null ? string.Empty : " (log: errors " + counters["errors"] + ", warnings " + counters["warnings"] + ")")
                    + ". The file itself was written and verified; see data.logProblems.");
            }
            else
            {
                log.Info("Exported the hardware configuration to " + Text.Quote(amlPath) + ".");
            }

            JsonObject data = new JsonObject();
            data.Add("file", amlPath);
            data.Add("fileName", fileName);
            data.Add("outputDir", outputDir);
            data.Add("bytes", verified["bytes"]);
            data.Add("sha256", verified["sha256"]);
            data.Add("rootElement", verified["rootElement"]);
            // The flat composition, the ungrouped system group and nested user groups,
            // de-duplicated by name — Project.Devices alone undercounts badly.
            data.Add("deviceCount", deviceCount);
            // What the AML does not contain, described from the project model: CAx has no
            // class model for HMI devices, so without this the AML's inventory gap is
            // visible only as one line in a 108 KB log.
            data.Add("notInAml", notInAml);
            data.Add("notInAmlCount", notInAml.Count);
            if (notInAml.Count > 0)
            {
                data.Add("notInAmlNote",
                    "Devices TIA's CAx export left out. They are absent from the AML, not empty: CAx has no class "
                        + "model for them (the manual's \"Export of CAx data\" excludes HMI devices other than "
                        + "push-button/key panels), so their identity and network addresses below come from the "
                        + "project object model instead.");
            }
            // TIA's boolean means "every object was exported". Kept verbatim next to the
            // log counters so a caller can tell "complete" from "some objects skipped".
            data.Add("allObjectsExported", exported);
            data.Add("logSummary", counters);
            data.Add("logProblems", problems);
            data.Add("logPath", File.Exists(logPath) ? logPath : null);
            data.Add("logExcerpt", Tail(logText, LogTailChars));
            data.Add("dryRun", false);

            changes.Add("file", amlPath, "written",
                "CAx/AML hardware configuration export (" + verified["bytes"] + " bytes, sha256 " + verified["sha256"]
                    + (exported ? string.Empty : ", objects skipped") + ")");
            return data;
        }

        // ------------------------------------------------------------- helpers

        /// <summary>
        /// Every device the project holds, not just the flat composition.
        ///
        /// Measured 2026-11-02: <c>PEI_SinoARP_SWT2</c> reports exactly **1** device
        /// through <c>Project.Devices</c> while the CAx log exports dozens of them from
        /// nested device user groups. So the count walks all three sources — the flat
        /// composition, the "ungrouped devices" system group and the user groups, which
        /// nest — and de-duplicates by name (TIA keeps device names unique inside one
        /// project). This is what the AML is expected to cover, not "one device".
        /// </summary>
        private List<Device> AllDevices()
        {
            List<Device> all = new List<Device>();
            HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (Device device in _host.CollectDevices())
            {
                if (seen.Add(device.Name)) all.Add(device);
            }
            return all;
        }

        /// <summary>
        /// Describes the devices the AML does not carry, so the gap is data instead of a
        /// log line the caller has to find.
        ///
        /// Two independent signals, because either alone can stay silent: the CAx log
        /// names what TIA skipped (with its own reason), and a device whose software is
        /// an HMI target is a type CAx cannot represent even if TIA reports no error. The
        /// runtime type name is compared as a string so this file does not take a compile
        /// time dependency on the whole <c>Siemens.Engineering.Hmi</c> surface just to
        /// recognise one type.
        /// </summary>
        private List<JsonObject> DescribeMissingFromAml(List<JsonObject> problems, List<Device> devices,
            DiagnosticLog log)
        {
            Dictionary<string, string> skipped = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (problems != null)
            {
                foreach (JsonObject problem in problems)
                {
                    string text = JsonObject.ReadString(problem, "message", null);
                    if (string.IsNullOrEmpty(text)) continue;
                    Match match = SkippedDevicePattern.Match(text);
                    if (!match.Success) continue;
                    string name = match.Groups["name"].Value.Trim();
                    if (name.Length > 0) skipped[name] = text;
                }
            }

            List<JsonObject> rows = new List<JsonObject>();
            foreach (Device device in devices)
            {
                string reason;
                bool skippedByLog = skipped.TryGetValue(device.Name, out reason);
                string kind = SoftwareKind(device, log);
                if (!skippedByLog && kind == null) continue;

                JsonObject row = new JsonObject();
                row.Add("device", device.Name);
                row.AddIfPresent("kind", kind);
                row.AddIfPresent("reason", reason);
                // Best effort: the CAx message says the type identifier is invalid or
                // missing *in the CAx class model*, which does not mean the Openness
                // attribute is empty.
                row.AddIfPresent("typeIdentifier", DeviceAttribute(device, "TypeIdentifier"));
                row.AddIfPresent("typeName", DeviceAttribute(device, "TypeName"));
                row.AddIfPresent("orderNumber", DeviceAttribute(device, "OrderNumber"));
                row.Add("deviceItemCount", OpennessHost.FlattenDeviceItems(device).Count);
                row.Add("nodes", DescribeNodes(device));
                rows.Add(row);
            }
            return rows;
        }

        /// <summary>The device's configured network nodes — the fields an AML would carry.</summary>
        private List<JsonObject> DescribeNodes(Device device)
        {
            List<JsonObject> rows = new List<JsonObject>();
            foreach (OpennessHost.OfflineNodeInfo node in _host.DescribeOfflineNodes(device))
            {
                JsonObject row = new JsonObject();
                row.Add("deviceItem", node.DeviceItem);
                row.Add("node", node.Node);
                row.AddIfPresent("address", node.Address);
                row.AddIfPresent("subnetMask", node.SubnetMask);
                row.AddIfPresent("pnDeviceName", node.PnDeviceName);
                row.AddIfPresent("netType", node.NetType);
                row.AddIfPresent("interfaceType", node.InterfaceType);
                row.AddIfPresent("subnet", node.Subnet);
                rows.Add(row);
            }
            return rows;
        }

        /// <summary>"hmi" when the device's software is an HMI target, otherwise null.</summary>
        private static string SoftwareKind(Device device, DiagnosticLog log)
        {
            foreach (DeviceItem item in OpennessHost.FlattenDeviceItems(device))
            {
                SoftwareContainer container;
                try
                {
                    container = item.GetService<SoftwareContainer>();
                }
                catch (Exception ex)
                {
                    log.Warning("The software container of " + Text.Quote(device.Name) + "/" + Text.Quote(item.Name)
                        + " could not be read: " + ex.Message);
                    continue;
                }
                if (container == null || container.Software == null) continue;
                if (string.Equals(container.Software.GetType().Name, "HmiTarget", StringComparison.Ordinal)) return "hmi";
            }
            return null;
        }

        /// <summary>Reads one device attribute, tolerating the ones this type does not expose.</summary>
        private static string DeviceAttribute(Device device, string name)
        {
            try
            {
                object value = device.GetAttribute(name);
                return value == null ? null : Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture);
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// Validates the caller's file name.
        ///
        /// A name carrying a directory part would silently escape <c>output_dir</c>, so
        /// it is refused rather than normalised; the extension has to be <c>.aml</c>
        /// because that is what TIA writes.
        /// </summary>
        private static string HardwareFileName(string requested)
        {
            string name = string.IsNullOrWhiteSpace(requested)
                ? DefaultHardwareFileName
                : requested.Trim().Trim('"');

            if (string.IsNullOrWhiteSpace(name) || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0
                || name.IndexOf('\\') >= 0 || name.IndexOf('/') >= 0)
            {
                throw new ControllerException("invalid_params",
                    "'file_name' must be a plain file name without a directory part; it received "
                        + Text.Quote(requested) + ".");
            }

            if (!string.Equals(Path.GetExtension(name), HardwareFileExtension, StringComparison.OrdinalIgnoreCase))
            {
                throw new ControllerException("invalid_params",
                    "'file_name' must end with " + HardwareFileExtension + "; it received " + Text.Quote(name)
                        + ". TIA Portal writes a CAx export as AutomationML, and the extension is part of the format.");
            }

            return name;
        }

        /// <summary>Resolves the CAx service, or explains why this project has none.</summary>
        private CaxProvider CaxProviderOf()
        {
            CaxProvider cax;
            try
            {
                cax = _host.Project.GetService<CaxProvider>();
            }
            catch (Exception ex)
            {
                throw OpennessHost.OpennessFailure(
                    "cax_unavailable",
                    "The CAx (AML export) service could not be obtained from the open project: " + ex.Message,
                    ex);
            }

            if (cax == null)
            {
                // The manual's example checks for null as well, so a null service is a
                // documented state, not an impossible one.
                throw new ControllerException(
                    "cax_unavailable",
                    "The open project exposes no CAx service (CaxProvider), so its hardware configuration cannot be "
                        + "exported as AML. Reload the project, or use a TIA Portal installation that still ships "
                        + "the CAx export.",
                    JsonObject.Of("project", JsonObject.ReadString(_host.DescribeSession(), "projectName", null)));
            }

            return cax;
        }

        /// <summary>
        /// Reads the written file back and checks it is the AutomationML document that
        /// was asked for, so a truncated export cannot pass as success.
        /// </summary>
        private static JsonObject VerifyCaxFile(string path)
        {
            long bytes = new FileInfo(path).Length;
            string head = ReadHead(path, 8192);

            string rootElement = null;
            int marker = head.IndexOf("<" + CaxRootMarker, StringComparison.Ordinal);
            if (marker < 0) marker = head.IndexOf(CaxRootMarker, StringComparison.Ordinal);
            if (marker >= 0)
            {
                int start = head.IndexOf('<', marker);
                int end = head.IndexOfAny(new[] { ' ', '>', '\t', '\r', '\n' }, marker);
                if (start >= 0 && end > start) rootElement = head.Substring(start + 1, end - start - 1);
            }

            if (!head.TrimStart('\uFEFF', ' ', '\t', '\r', '\n').StartsWith("<", StringComparison.Ordinal))
            {
                throw new ControllerException(
                    "verification_failed",
                    "The hardware configuration file " + Text.Quote(path) + " is not XML; it starts with "
                        + Text.Quote(Preview(head)) + ".",
                    JsonObject.Of("path", path, "bytes", bytes, "head", Preview(head)));
            }

            if (rootElement == null)
            {
                throw new ControllerException(
                    "verification_failed",
                    "The hardware configuration file " + Text.Quote(path) + " does not carry the CAEX root element '"
                        + CaxRootMarker + "', so it is not the AutomationML export the manual describes. It starts with "
                        + Text.Quote(Preview(head)) + ".",
                    JsonObject.Of("path", path, "bytes", bytes, "head", Preview(head)));
            }

            JsonObject verified = new JsonObject();
            verified.Add("bytes", bytes);
            verified.Add("sha256", Hashing.Sha256OfFile(path));
            verified.Add("rootElement", rootElement);
            return verified;
        }

        /// <summary>Reads the first bytes of a file with BOM detection, tolerating failure.</summary>
        private static string ReadHead(string path, int chars)
        {
            try
            {
                using (StreamReader reader = new StreamReader(path, Encoding.UTF8, true))
                {
                    char[] buffer = new char[chars];
                    int read = reader.Read(buffer, 0, chars);
                    return new string(buffer, 0, read);
                }
            }
            catch (Exception)
            {
                return string.Empty;
            }
        }

        /// <summary>
        /// Reads TIA's log whole (capped), or an empty string when it wrote none.
        ///
        /// Whole, not just the head: the counters and the ERROR lines are at the end.
        /// </summary>
        private static string ReadLog(string logPath, DiagnosticLog log)
        {
            if (!File.Exists(logPath)) return null;
            try
            {
                long length = new FileInfo(logPath).Length;
                if (length > LogReadLimitBytes)
                {
                    log.Warning("The CAx log at " + Text.Quote(logPath) + " is " + length
                        + " bytes; only the last " + LogReadLimitBytes + " bytes are considered.");
                }
                using (StreamReader reader = new StreamReader(logPath, Encoding.UTF8, true))
                {
                    if (length > LogReadLimitBytes) reader.BaseStream.Seek(-LogReadLimitBytes, SeekOrigin.End);
                    return reader.ReadToEnd();
                }
            }
            catch (Exception ex)
            {
                log.Warning("The CAx log file " + Text.Quote(logPath) + " could not be read: " + ex.Message);
                return null;
            }
        }

        /// <summary>
        /// The "completed (errors: N, warnings: M)" counters, or null when the line is
        /// absent (an aborted export never writes it).
        /// </summary>
        private static JsonObject ParseLogCounters(string logText)
        {
            if (string.IsNullOrEmpty(logText)) return null;
            Match match = LogSummaryPattern.Match(logText);
            if (!match.Success) return null;

            int errors = int.Parse(match.Groups[1].Value);
            int warnings = int.Parse(match.Groups[2].Value);
            JsonObject counters = new JsonObject();
            counters.Add("errors", errors);
            counters.Add("warnings", warnings);
            counters.Add("clean", errors == 0 && warnings == 0);
            return counters;
        }

        /// <summary>
        /// The log's ERROR lines — what TIA skipped and why. Capped, and de-duplicated
        /// because one unsupported device type produces one line per instance.
        /// </summary>
        private static List<JsonObject> ParseLogProblems(string logText)
        {
            List<JsonObject> problems = new List<JsonObject>();
            if (string.IsNullOrEmpty(logText)) return problems;

            HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
            string[] lines = logText.Split('\n');
            for (int i = 0; i < lines.Length; i++)
            {
                Match match = LogProblemPattern.Match(lines[i].TrimEnd('\r'));
                if (!match.Success) continue;
                string text = match.Groups["text"].Value.Trim();
                if (text.Length == 0 || !seen.Add(text)) continue;

                JsonObject problem = new JsonObject();
                problem.Add("message", text);
                problems.Add(problem);
                if (problems.Count >= LogProblemsLimit) break;
            }
            return problems;
        }

        /// <summary>The last <paramref name="chars"/> characters of a text, trimmed.</summary>
        private static string Tail(string text, int chars)
        {
            if (string.IsNullOrEmpty(text)) return null;
            string trimmed = text.Trim();
            if (trimmed.Length <= chars) return trimmed;
            return "…" + trimmed.Substring(trimmed.Length - chars);
        }

        /// <summary>One-line pointer to the log, appended to failure messages.</summary>
        private static string LogHint(string logPath)
        {
            return File.Exists(logPath)
                ? "TIA Portal wrote a log to " + Text.Quote(logPath) + "; see 'logSummary' and 'logProblems' in the details."
                : "TIA Portal wrote no log file.";
        }

        /// <summary>Deletes a file when it exists, reporting (not throwing) a failure.</summary>
        private static void TryDelete(string path, DiagnosticLog log)
        {
            if (!File.Exists(path)) return;
            try
            {
                File.Delete(path);
            }
            catch (Exception ex)
            {
                log.Warning("A stale CAx log at " + Text.Quote(path) + " could not be removed: " + ex.Message);
            }
        }

        /// <summary>A short single-line preview of a file head, for error messages.</summary>
        private static string Preview(string text)
        {
            if (string.IsNullOrEmpty(text)) return string.Empty;
            string flat = text.Replace("\r", " ").Replace("\n", " ").Replace("\t", " ").Trim();
            if (flat.Length > 120) flat = flat.Substring(0, 120) + "…";
            return flat;
        }
    }
}
