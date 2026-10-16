using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using Siemens.Engineering;
using Siemens.Engineering.Compiler;
using Siemens.Engineering.SW;
using Siemens.Engineering.SW.Blocks;
using Siemens.Engineering.SW.ExternalSources;
using Siemens.Engineering.SW.Tags;
using Siemens.Engineering.SW.Types;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>
    /// The operation surface of the controller. The request channel only ever
    /// reaches an implementation of this interface, and the concrete
    /// implementation is created lazily so a machine without a usable Openness
    /// installation can still start the controller and answer with a structured
    /// error.
    /// </summary>
    internal interface IOperationRunner : IDisposable
    {
        JsonObject Invoke(string operation, JsonArgs parameters, DiagnosticLog log, ChangeLog changes, IProgressSink progress);

        JsonObject DescribeSession();
    }

    /// <summary>
    /// Implements the whitelisted Openness operations. Every write is explicit
    /// about it: an operation that changes the project runs inside an
    /// exclusive-access transaction that is only committed after the last change,
    /// and every write is followed by a read-back verification.
    ///
    /// The class is partial. This file holds the original block read/write
    /// surface; the project-data operations live in <c>OperationsProject.cs</c>,
    /// the PLC-data operations in <c>OperationsPlc.cs</c> and the F-related
    /// operations in <c>OperationsSafety.cs</c>.
    /// </summary>
    internal sealed partial class OpennessOperations : IOperationRunner
    {
        private static readonly string[] ExportOptionNames = { "none", "with_defaults", "with_read_only" };
        private static readonly string[] ImportOptionNames = { "none", "override" };
        private static readonly string[] SwImportOptionNames =
        {
            "ignore_structural_changes", "ignore_missing_referenced_objects", "ignore_unit_attributes",
        };
        private static readonly string[] ImportModeNames = { "auto", "simatic_ml", "external_source" };
        private static readonly string[] GenerateOptionNames = { "none", "keep_on_error" };

        // Object families the two program-object operations work on. "blocks" keeps the
        // original behaviour; the other two were added so PLC types (UDTs) and tag
        // tables are covered as well.
        private const string CategoryBlocks = "blocks";
        private const string CategoryTypes = "types";
        private const string CategoryTagTables = "tag_tables";
        // One folder per family, so the three never share a namespace and a caller can
        // export all of them in ONE call and still get a tree that says what each file
        // is. Blocks used to be written at the root of output_dir, which is why a
        // rebuild needed two calls per device (docs/decisions.md D24).
        private const string BlockFolderName = "blocks";
        private const string TypeFolderName = "types";
        private const string TagTableFolderName = "tag_tables";
        private static readonly string[] CategoryNames = { CategoryBlocks, CategoryTypes, CategoryTagTables };

        private const int DefaultMaxMessages = 200;

        private readonly OpennessHost _host;

        public OpennessOperations(DiagnosticLog log)
        {
            _host = new OpennessHost(log);
        }

        public JsonObject DescribeSession()
        {
            return _host.DescribeSession();
        }

        public void Dispose()
        {
            _host.Dispose();
        }

        public JsonObject Invoke(string operation, JsonArgs parameters, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            if (!OperationCatalog.IsAllowed(operation))
            {
                throw new ControllerException(
                    "unsupported_operation",
                    "The controller only performs the whitelisted operations " + string.Join(", ", OperationCatalog.All)
                        + "; it received " + Text.Quote(operation) + " and will not execute it.",
                    JsonObject.Of("requested", operation, "allowed", OperationCatalog.All));
            }

            switch (operation)
            {
                case OperationCatalog.OpenProject:
                    return OpenProject(parameters, log, changes, progress);
                case OperationCatalog.ExportBlocks:
                    return ExportBlocks(parameters, log, changes, progress);
                case OperationCatalog.ImportBlocks:
                    return ImportBlocks(parameters, log, changes, progress);
                case OperationCatalog.CompilePlc:
                    return CompilePlc(parameters, log, changes, progress);
                case OperationCatalog.CloseProject:
                    return CloseProject(parameters, log, changes, progress);

                // Functions for projects and project data.
                case OperationCatalog.CreateProject:
                    return CreateProject(parameters, log, changes, progress);
                case OperationCatalog.SaveProject:
                    return SaveProject(parameters, log, changes, progress);
                case OperationCatalog.ArchiveProject:
                    return ArchiveProject(parameters, log, changes, progress);
                case OperationCatalog.ProjectInfo:
                    return ProjectInfo(parameters, log, changes, progress);
                case OperationCatalog.ProjectLanguages:
                    return ProjectLanguages(parameters, log, changes, progress);
                case OperationCatalog.ProjectTexts:
                    return ProjectTexts(parameters, log, changes, progress);
                case OperationCatalog.UpdateProject:
                    return UpdateProject(parameters, log, changes, progress);
                case OperationCatalog.PortalSettings:
                    return PortalSettings(parameters, log, changes, progress);

                // Functions for accessing the data of a PLC device.
                case OperationCatalog.ListPlcObjects:
                    return ListPlcObjects(parameters, log, changes, progress);
                case OperationCatalog.CreatePlcObjects:
                    return CreatePlcObjects(parameters, log, changes, progress);
                case OperationCatalog.DeletePlcObjects:
                    return DeletePlcObjects(parameters, log, changes, progress);
                case OperationCatalog.WriteTags:
                    return WriteTags(parameters, log, changes, progress);
                case OperationCatalog.SetBlockAttributes:
                    return SetBlockAttributes(parameters, log, changes, progress);
                case OperationCatalog.ProtectBlocks:
                    return ProtectBlocks(parameters, log, changes, progress);
                case OperationCatalog.GenerateSource:
                    return GenerateSource(parameters, log, changes, progress);
                case OperationCatalog.WatchAndForceTables:
                    return WatchAndForceTables(parameters, log, changes, progress);
                case OperationCatalog.SoftwareUnits:
                    return SoftwareUnits(parameters, log, changes, progress);

                // F-related Openness.
                case OperationCatalog.SafetyStatus:
                    return SafetyStatus(parameters, log, changes, progress);
                case OperationCatalog.SetSafetySettings:
                    return SetSafetySettings(parameters, log, changes, progress);
                case OperationCatalog.SafetySignatures:
                    return SafetySignatures(parameters, log, changes, progress);
                default:
                    // Unreachable: the catalog admitted the name above.
                    throw new ControllerException("unsupported_operation", "Unhandled operation " + Text.Quote(operation) + ".");
            }
        }

        // ------------------------------------------------------------ OpenProject

        private JsonObject OpenProject(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string projectPath = p.RequiredString("project_path");
            bool withWindow = p.Bool("with_window", false);
            bool allowUpgrade = p.Bool("allow_upgrade", false);
            bool dryRun = p.Bool("dry_run", false);

            string fullPath = Path.GetFullPath(projectPath.Trim().Trim('"'));
            if (!File.Exists(fullPath))
            {
                throw new ControllerException("project_not_found", "No file exists at " + Text.Quote(fullPath) + ".",
                    JsonObject.Of("path", fullPath));
            }

            string extension = Path.GetExtension(fullPath);
            if (!string.Equals(extension, ".ap17", StringComparison.OrdinalIgnoreCase))
            {
                log.Warning("The project file ends in " + Text.Quote(extension) + " rather than '.ap17'.");
            }

            if (dryRun)
            {
                JsonObject plan = new JsonObject();
                plan.Add("projectPath", fullPath);
                plan.Add("withUserInterface", withWindow);
                plan.Add("allowUpgrade", allowUpgrade);
                plan.Add("alreadyOpen", _host.HasProject);
                if (_host.HasProject) plan.Add("openProject", _host.DescribeSession());
                plan.Add("wouldWrite", allowUpgrade);
                log.Info("Dry run: the project was not opened. Re-run with dry_run disabled to open it.");
                return plan;
            }

            if (!allowUpgrade)
            {
                log.Info("allow_upgrade is off, so the project will not be rewritten to V17. If it was created by an "
                    + "older TIA Portal version the open fails and the caller must pass allow_upgrade to opt in.");
            }

            JsonObject data = _host.OpenProject(fullPath, withWindow, allowUpgrade, progress);
            changes.Add("project", fullPath, allowUpgrade ? "opened_and_upgraded" : "opened", "TIA Portal V17");
            data.Add("dryRun", false);
            return data;
        }

        // ----------------------------------------------------------- ExportBlocks

        private JsonObject ExportBlocks(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string outputDir = Path.GetFullPath(p.RequiredString("output_dir").Trim().Trim('"'));
            List<string> requestedNames = p.StringList("block_names");
            bool recursive = p.Bool("recursive", true);
            bool overwrite = p.Bool("overwrite", false);
            bool writeManifest = p.Bool("write_manifest", true);
            string exportOptionName = p.Enum("export_options", ExportOptionNames, "with_defaults");
            ExportOptions exportOptions = ParseExportOptions(exportOptionName);

            PlcSoftwareRef software = _host.FindPlcSoftware(p.String("device_name", null), p.String("software_name", null));

            List<string> categories = p.EnumList("categories", CategoryNames);
            if (categories.Count == 0) categories.Add(CategoryBlocks);
            List<string> typeNames = p.StringList("type_names");
            List<string> tagTableNames = p.StringList("tag_table_names");

            List<ExportPlanItem> plan = new List<ExportPlanItem>();
            int explicitlyRequested = requestedNames.Count + typeNames.Count + tagTableNames.Count;
            foreach (string category in categories)
            {
                if (string.Equals(category, CategoryBlocks, StringComparison.Ordinal))
                {
                    List<BlockRef> blocks = _host.CollectBlocks(software.Software, requestedNames, recursive, true);
                    plan.AddRange(BuildBlockExportPlan(blocks, Path.Combine(outputDir, BlockFolderName), log));
                }
                else if (string.Equals(category, CategoryTypes, StringComparison.Ordinal))
                {
                    List<PlcTypeRef> types = _host.CollectTypes(software.Software, typeNames, recursive, true);
                    plan.AddRange(BuildTypeExportPlan(types, Path.Combine(outputDir, TypeFolderName), log));
                }
                else
                {
                    List<PlcTagTableRef> tables = _host.CollectTagTables(software.Software, tagTableNames, recursive, true);
                    plan.AddRange(BuildTagTableExportPlan(tables, Path.Combine(outputDir, TagTableFolderName), log));
                }
            }

            if (plan.Count == 0)
            {
                throw new ControllerException("object_not_found",
                    "The project contains no object of the requested categor(y/ies) ("
                        + string.Join(", ", categories) + ") to export.",
                    JsonObject.Of("device", software.DeviceName, "software", software.SoftwareName, "categories", categories));
            }

            JsonObject categoryCounts = CountByCategory(plan);

            JsonObject data = new JsonObject();
            data.Add("device", software.DeviceName);
            data.Add("software", software.SoftwareName);
            data.Add("outputDir", outputDir);
            data.Add("exportOptions", exportOptionName);
            data.Add("categories", categories);
            data.Add("blockCount", plan.Count);
            data.Add("counts", categoryCounts);
            data.Add("dryRun", false);


            List<JsonObject> files = new List<JsonObject>();
            List<JsonObject> exportFailures = new List<JsonObject>();
            List<string> exportFailureNames = new List<string>();
            List<string> verificationFailures = new List<string>();
            int exported = 0;
            int skipped = 0;

            foreach (ExportPlanItem item in plan)
            {
                if (File.Exists(item.File) && !overwrite)
                {
                    skipped++;
                    changes.Add("file", item.File, "skipped", "The file exists and overwrite is off.");
                    log.Warning("Skipped " + Text.Quote(item.Name) + ": " + item.File + " already exists (pass overwrite to replace it).");
                    continue;
                }

                bool existed = File.Exists(item.File);
                progress.Report("export", "Exporting " + item.Name + " to " + item.File);
                try
                {
                    if (string.Equals(item.Category, CategoryTypes, StringComparison.Ordinal))
                    {
                        _host.ExportType(item.Type, item.File, exportOptions);
                    }
                    else if (string.Equals(item.Category, CategoryTagTables, StringComparison.Ordinal))
                    {
                        _host.ExportTagTable(item.TagTable, item.File, exportOptions);
                    }
                    else
                    {
                        _host.ExportBlock(item.Block, item.File, exportOptions);
                    }
                }
                catch (ControllerException ex)
                {
                    // Openness refuses some objects outright: a real V17 project with
                    // ProDiag blocks fails with "The programming language 'ProDiag_OB'
                    // is not supported during import and export", and Safety F-OBs with
                    // "The export of block 'FOB_SAFETY' is not permitted". One such
                    // object must not abort the export of the whole project, so the
                    // failure is recorded per object and the loop continues.
                    exportFailures.Add(JsonObject.Of(
                        "category", item.Category,
                        "name", item.Name,
                        "group", item.GroupPath,
                        "file", item.File,
                        "code", ex.Code,
                        "message", ex.Message));
                    exportFailureNames.Add(item.Name);
                    changes.Add(item.Category, item.Name, "export_failed", ex.Message);
                    log.Warning("Openness could not export " + Text.Quote(item.Name) + ": " + ex.Message);
                    continue;
                }
                exported++;

                JsonObject verification = VerifyExportedFile(item, verificationFailures);
                files.Add(verification);
                changes.Add("file", item.File, existed ? "overwritten" : "created", item.Name);
            }

            JsonObject summary = new JsonObject();
            summary.Add("exported", exported);
            summary.Add("skipped", skipped);
            summary.Add("failed", exportFailures.Count);
            summary.Add("verificationFailed", verificationFailures.Count);
            data.Add("summary", summary);
            data.Add("counts", categoryCounts);
            data.Add("files", files);
            if (exportFailures.Count > 0) data.Add("failures", exportFailures);

            if (writeManifest)
            {
                string manifestPath = Path.Combine(outputDir, "_tia-openness-manifest.json");
                WriteManifest(manifestPath, software, outputDir, exportOptionName, categories, categoryCounts, files, exportFailures, log);
                data.Add("manifest", manifestPath);
                changes.Add("file", manifestPath, File.Exists(manifestPath) ? "written" : "created", "export manifest");
            }

            // Failure precedence: nothing produced at all > an explicitly requested
            // block was refused > written files could not be read back > partial
            // success (reported in the summary, not fatal).
            if (exported == 0 && plan.Count > 0)
            {
                throw new ControllerException(
                    "export_failed",
                    "No object could be exported: Openness refused all " + plan.Count + " object(s).",
                    JsonObject.Of("failures", exportFailures, "verificationFailures", verificationFailures),
                    data);
            }

            if (explicitlyRequested > 0 && exportFailures.Count > 0)
            {
                throw new ControllerException(
                    "export_failed",
                    "Openness refused " + exportFailures.Count + " of the explicitly requested object(s): "
                        + string.Join(", ", exportFailureNames) + ". Every other file was written.",
                    JsonObject.Of("refused", exportFailureNames, "failures", exportFailures),
                    data);
            }

            if (verificationFailures.Count > 0)
            {
                string message = "The export ran, but reading the written files back failed for "
                    + verificationFailures.Count + " file(s): " + string.Join(" | ", verificationFailures);
                JsonObject details = JsonObject.Of("failureCount", verificationFailures.Count, "failures", verificationFailures);
                throw new ControllerException("verification_failed", message, details, data);
            }

            log.Info("Exported " + exported + " object(s) to " + outputDir + ".");
            if (exportFailures.Count > 0)
            {
                log.Info(exportFailures.Count + " object(s) are not exportable through Openness at all and were reported "
                    + "per object instead of aborting the export: " + string.Join(", ", exportFailureNames) + ".");
            }
            return data;
        }

        private sealed class ExportPlanItem
        {
            public string Category;
            public PlcBlock Block;
            public PlcType Type;
            public PlcTagTable TagTable;
            public BlockRef Reference;
            public string Name;
            public string GroupPath;
            public string File;
        }

        private List<ExportPlanItem> BuildBlockExportPlan(List<BlockRef> blocks, string outputDir, DiagnosticLog log)
        {
            List<ExportPlanItem> plan = new List<ExportPlanItem>();
            foreach (BlockRef reference in blocks)
            {
                ExportPlanItem item = new ExportPlanItem();
                item.Category = CategoryBlocks;
                item.Block = reference.Block;
                item.Reference = reference;
                item.Name = reference.Name;
                item.GroupPath = reference.GroupPath;
                plan.Add(item);
            }
            return AssignExportFiles(plan, outputDir, log);
        }

        private List<ExportPlanItem> BuildTypeExportPlan(List<PlcTypeRef> types, string outputDir, DiagnosticLog log)
        {
            List<ExportPlanItem> plan = new List<ExportPlanItem>();
            foreach (PlcTypeRef reference in types)
            {
                ExportPlanItem item = new ExportPlanItem();
                item.Category = CategoryTypes;
                item.Type = reference.Type;
                item.Name = reference.Name;
                item.GroupPath = reference.GroupPath;
                plan.Add(item);
            }
            return AssignExportFiles(plan, outputDir, log);
        }

        private List<ExportPlanItem> BuildTagTableExportPlan(List<PlcTagTableRef> tables, string outputDir, DiagnosticLog log)
        {
            List<ExportPlanItem> plan = new List<ExportPlanItem>();
            foreach (PlcTagTableRef reference in tables)
            {
                ExportPlanItem item = new ExportPlanItem();
                item.Category = CategoryTagTables;
                item.TagTable = reference.Table;
                item.Name = reference.Name;
                item.GroupPath = reference.GroupPath;
                plan.Add(item);
            }
            return AssignExportFiles(plan, outputDir, log);
        }

        private static JsonObject CountByCategory(List<ExportPlanItem> plan)
        {
            int blocks = 0;
            int types = 0;
            int tables = 0;
            foreach (ExportPlanItem item in plan)
            {
                if (string.Equals(item.Category, CategoryTypes, StringComparison.Ordinal)) types++;
                else if (string.Equals(item.Category, CategoryTagTables, StringComparison.Ordinal)) tables++;
                else blocks++;
            }
            JsonObject counts = new JsonObject();
            counts.Add("blocks", blocks);
            counts.Add("types", types);
            counts.Add("tagTables", tables);
            return counts;
        }

        /// <summary>
        /// Maps every planned object to a file below <paramref name="outputDir"/>:
        /// <c>&lt;user group path&gt;/&lt;name&gt;.xml</c>. Two objects that sanitize to the
        /// same path get a <c>~2</c> suffix instead of silently overwriting each other.
        /// </summary>
        private List<ExportPlanItem> AssignExportFiles(List<ExportPlanItem> plan, string outputDir, DiagnosticLog log)
        {
            HashSet<string> used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (ExportPlanItem item in plan)
            {
                string relative = SanitizeGroupPath(item.GroupPath) + SanitizeFileName(item.Name) + ".xml";
                string candidate = Path.Combine(outputDir, relative);
                if (!used.Add(candidate))
                {
                    string directory = Path.GetDirectoryName(candidate);
                    string bare = Path.GetFileNameWithoutExtension(candidate);
                    int suffix = 2;
                    while (!used.Add(candidate))
                    {
                        candidate = Path.Combine(directory, bare + "~" + suffix.ToString(CultureInfo.InvariantCulture) + ".xml");
                        suffix++;
                        if (suffix > 1000) break;
                    }
                    log.Warning("Two objects map to the same file name; " + Text.Quote(item.Name)
                        + " is written as " + Path.GetFileName(candidate) + ".");
                }
                item.File = candidate;
            }
            return plan;
        }

        private static string SanitizeGroupPath(string groupPath)
        {
            if (string.IsNullOrEmpty(groupPath)) return string.Empty;
            string[] segments = groupPath.Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries);
            string result = string.Empty;
            foreach (string segment in segments)
            {
                result += SanitizeFileName(segment) + Path.DirectorySeparatorChar;
            }
            return result;
        }

        private static string SanitizeFileName(string name)
        {
            if (string.IsNullOrEmpty(name)) return "unnamed";
            char[] invalid = Path.GetInvalidFileNameChars();
            System.Text.StringBuilder builder = new System.Text.StringBuilder(name.Length);
            foreach (char c in name)
            {
                bool bad = false;
                for (int i = 0; i < invalid.Length; i++)
                {
                    if (invalid[i] == c) { bad = true; break; }
                }
                builder.Append(bad ? '_' : c);
            }
            string sanitized = builder.ToString().Trim();
            return sanitized.Length == 0 ? "unnamed" : sanitized;
        }

        private JsonObject VerifyExportedFile(ExportPlanItem item, List<string> failures)
        {
            JsonObject file = new JsonObject();
            file.Add("name", item.Name);
            file.AddIfPresent("group", item.GroupPath);
            file.Add("file", item.File);

            long bytes = 0;
            string sha256 = null;
            try
            {
                FileInfo info = new FileInfo(item.File);
                if (!info.Exists)
                {
                    failures.Add(item.Name + ": the file was not written");
                    file.Add("verified", false);
                    return file;
                }
                bytes = info.Length;
                sha256 = Hashing.Sha256OfFile(item.File);
            }
            catch (Exception ex)
            {
                failures.Add(item.Name + ": " + ex.Message);
                file.Add("verified", false);
                return file;
            }

            file.Add("bytes", bytes);
            file.AddIfPresent("sha256", sha256);

            if (bytes == 0)
            {
                failures.Add(item.Name + ": the written file is empty");
                file.Add("verified", false);
                return file;
            }

            try
            {
                SimaticMlHeader header = SimaticMl.ReadHeader(item.File);
                file.Add("category", item.Category);
                file.AddIfPresent("simaticType", header.SimaticType);
                file.AddIfPresent("declaredName", header.Name);
                file.AddIfPresent("declaredNumber", header.Number);
                file.AddIfPresent("programmingLanguage", header.ProgrammingLanguage);

                // A Simatic ML object must declare its name: an unparsed name means the
                // file cannot be trusted (and, before, silently disabled this check).
                if (string.Equals(header.Kind, "unknown", StringComparison.Ordinal))
                {
                    failures.Add(item.Name + ": the written file has no recognizable Simatic ML object element (found <"
                        + header.ElementName + ">)");
                    file.Add("verified", false);
                    return file;
                }
                if (string.IsNullOrEmpty(header.Name))
                {
                    failures.Add(item.Name + ": the written file declares no object name");
                    file.Add("verified", false);
                    return file;
                }

                bool nameMatches = string.Equals(header.Name, item.Name, StringComparison.Ordinal);
                file.Add("verified", nameMatches);
                if (!nameMatches)
                {
                    failures.Add(item.Name + ": the exported file declares the object name " + Text.Quote(header.Name));
                }
            }
            catch (ControllerException ex)
            {
                failures.Add(item.Name + ": " + ex.Message);
                file.Add("verified", false);
            }
            return file;
        }

        private void WriteManifest(string manifestPath, PlcSoftwareRef software, string outputDir,
            string exportOptionName, List<string> categories, JsonObject categoryCounts,
            List<JsonObject> files, List<JsonObject> exportFailures, DiagnosticLog log)
        {
            JsonObject manifest = new JsonObject();
            manifest.Add("schemaVersion", 1);
            manifest.Add("protocol", Protocol.Version);
            manifest.Add("generatedBy", Protocol.ControllerName);
            manifest.Add("generatedAt", DateTime.UtcNow);
            manifest.Add("device", software.DeviceName);
            manifest.Add("software", software.SoftwareName);
            manifest.Add("outputDir", outputDir);
            manifest.Add("exportOptions", exportOptionName);
            manifest.Add("categories", categories);
            manifest.Add("failureCount", exportFailures.Count);
            manifest.Add("blocks", files);
            if (exportFailures.Count > 0)
            {
                // Recorded so a later import knows which blocks have no Simatic ML
                // representation at all (TIA's own ProDiag blocks, for example).
                manifest.Add("failures", exportFailures);
            }

            try
            {
                File.WriteAllText(manifestPath, JsonWriter.Write(manifest, true), new System.Text.UTF8Encoding(false));
            }
            catch (Exception ex)
            {
                log.Warning("The export manifest could not be written to " + Text.Quote(manifestPath) + ": " + ex.Message);
            }
        }

        private static ExportOptions ParseExportOptions(string name)
        {
            switch (name)
            {
                case "none": return ExportOptions.None;
                case "with_read_only": return ExportOptions.WithReadOnly;
                default: return ExportOptions.WithDefaults;
            }
        }

        // ----------------------------------------------------------- ImportBlocks

        private sealed class ImportCandidate
        {
            public string File;
            public bool IsExternalSource;
            public JsonObject Description;
            public string BlockName;
            public string BlockKind;
            public string SimaticType;
            public string Number;
            public string ProgrammingLanguage;
            public bool ExactTarget;
            /// <summary>Object family of this file: blocks | types | tag_tables.</summary>
            public string Category = CategoryBlocks;
            /// <summary>Group path mirrored from the directory layout, or null.</summary>
            public string MirroredGroupPath;
            /// <summary>Group this file will be imported into (resolved later), per family.</summary>
            public PlcBlockGroup TargetBlockGroup;
            public PlcTypeGroup TargetTypeGroup;
            public PlcTagTableGroup TargetTagTableGroup;
            public string TargetGroupPath;
        }

        private JsonObject ImportBlocks(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            List<string> inputs = p.StringList("import_paths");
            if (inputs.Count == 0)
            {
                throw new ControllerException("invalid_params",
                    "'import_paths' is required and must list at least one Simatic ML file, external source file, or directory.");
            }

            bool recursive = p.Bool("recursive", true);
            string importOptionName = p.Enum("import_options", ImportOptionNames, "none");
            List<string> swImportOptions = p.EnumList("sw_import_options", SwImportOptionNames);
            string mode = p.Enum("mode", ImportModeNames, "auto");
            bool dryRun = p.Bool("dry_run", true);
            bool verify = p.Bool("verify", true);
            bool keepSource = p.Bool("keep_source", false);
            string generateOptionName = p.Enum("generate_option", GenerateOptionNames, "none");
List<string> categoryFilter = p.EnumList("categories", CategoryNames);
            string targetGroupPath = p.String("target_group", null);
            bool createGroup = p.Bool("create_group", false);
            bool mirrorGroups = p.Bool("mirror_groups", true);

            ImportOptions importOptions = string.Equals(importOptionName, "override", StringComparison.Ordinal)
                ? ImportOptions.Override
                : ImportOptions.None;
            GenerateBlockOption generateOption = string.Equals(generateOptionName, "keep_on_error", StringComparison.Ordinal)
                ? GenerateBlockOption.KeepOnError
                : GenerateBlockOption.None;

            PlcSoftwareRef software = _host.FindPlcSoftware(p.String("device_name", null), p.String("software_name", null));
            List<ImportCandidate> candidates = ResolveImportCandidates(inputs, mode, recursive, categoryFilter, log);
            if (candidates.Count == 0)
            {
                throw new ControllerException("invalid_params",
                    "None of the given paths holds an importable file. Supported extensions: "
                        + string.Join(", ", SimaticMl.SupportedExtensions()) + ".",
                    JsonObject.Of("inputs", inputs));
            }

            // Resolve where each file goes, in the group hierarchy of its own object
            // family (block groups, type groups and tag table groups are separate
            // trees). An explicit target_group applies to every file and fails loudly
            // when it does not exist; a group mirrored from the directory layout falls
            // back to the root group with a warning.
            bool strictGroup = !string.IsNullOrWhiteSpace(targetGroupPath);
            foreach (ImportCandidate candidate in candidates)
            {
                string wanted = strictGroup
                    ? targetGroupPath
                    : (mirrorGroups ? candidate.MirroredGroupPath : null);
                AssignTargetGroup(software, candidate, wanted, createGroup, log, strictGroup);
            }

            ObjectSnapshot before = Snapshot(software, candidates);

            // ---- plan ---------------------------------------------------------
            List<JsonObject> planned = new List<JsonObject>();
            List<string> conflicts = new List<string>();
            foreach (ImportCandidate candidate in candidates)
            {
                JsonObject item = new JsonObject();
                item.Add("file", candidate.File);
                item.Add("format", candidate.IsExternalSource ? "external_source" : "simatic_ml");
                item.AddIfPresent("blockName", candidate.BlockName);
                item.AddIfPresent("blockKind", candidate.BlockKind);
                item.AddIfPresent("simaticType", candidate.SimaticType);
                item.AddIfPresent("number", candidate.Number);
                item.AddIfPresent("programmingLanguage", candidate.ProgrammingLanguage);
                item.Add("exactTarget", candidate.ExactTarget);
                item.Add("category", candidate.Category);
                item.Add("targetGroup", string.IsNullOrEmpty(candidate.TargetGroupPath) ? "(root)" : candidate.TargetGroupPath);

                bool exists = !string.IsNullOrEmpty(candidate.BlockName) && before.Contains(candidate.Category, candidate.BlockName);
                item.Add("existsInProject", exists);
                if (exists && !string.IsNullOrEmpty(candidate.TargetGroupPath))
                {
                    string existingGroup = before.GroupOf(candidate.Category, candidate.BlockName);
                    if (!string.Equals(existingGroup.TrimEnd('/'), candidate.TargetGroupPath.Trim('/'), StringComparison.OrdinalIgnoreCase))
                    {
                        // Import evaluates name/number collisions across the whole PLC,
                        // so a block that lives elsewhere cannot be overwritten here even
                        // with ImportOptions.Override.
                        item.Add("existingGroup", existingGroup);
                        item.Add("groupMismatch", true);
                    }
                }

                string action;
                if (!candidate.ExactTarget)
                {
                    action = "generate";
                }
                else if (exists)
                {
                    action = string.Equals(importOptionName, "override", StringComparison.Ordinal) ? "overwrite" : "conflict";
                    if (action == "conflict")
                    {
                        conflicts.Add(candidate.BlockName);
                        log.Warning("Block " + Text.Quote(candidate.BlockName) + " already exists and import_options is 'none'; "
                            + "TIA fails such an import. Pass import_options 'override' to replace it.");
                    }
                }
                else
                {
                    action = "create";
                }
                item.Add("action", action);
                planned.Add(item);
            }

            JsonObject data = new JsonObject();
            data.Add("device", software.DeviceName);
            data.Add("software", software.SoftwareName);
            data.Add("mode", mode);
            data.Add("importOptions", importOptionName);
            data.Add("swImportOptions", swImportOptions);
            data.Add("generateOption", generateOptionName);
            data.Add("keepSource", keepSource);
            data.Add("createGroup", createGroup);
            data.Add("mirrorGroups", mirrorGroups);
            data.AddIfPresent("targetGroup", string.IsNullOrWhiteSpace(targetGroupPath) ? null : targetGroupPath);
            data.Add("dryRun", false);
            data.Add("fileCount", candidates.Count);
            data.AddIfPresent("categories", categoryFilter.Count > 0 ? categoryFilter : null);
            data.Add("plan", planned);
            data.Add("conflicts", conflicts);

            if (dryRun)
            {
                data.Add("ready", conflicts.Count == 0);
                log.Info("Dry run: nothing was imported. " + candidates.Count + " file(s) validated"
                    + (conflicts.Count > 0 ? ", " + conflicts.Count + " conflict(s) must be resolved first." : "."));
                return data;
            }

            // ---- write --------------------------------------------------------
            List<JsonObject> applied = new List<JsonObject>();
            List<string> failures = new List<string>();
            JsonObject verification = null;
            ControllerException failure = null;
            string failureFile = null;

            using (TransactionScope scope = _host.BeginTransaction("TIAOpennessV17Min: import program objects"))
            {
                List<string> temporarySources = new List<string>();
                foreach (ImportCandidate candidate in candidates)
                {
                    progress.Report("import", "Importing " + Path.GetFileName(candidate.File));
                    try
                    {
                        if (candidate.IsExternalSource)
                        {
                            string sourceName = UniqueExternalSourceName(software.Software, candidate.File);
                            PlcExternalSource source = _host.CreateExternalSource(software.Software, sourceName, candidate.File);
                            _host.GenerateBlocksFromSource(source, candidate.TargetBlockGroup as PlcBlockUserGroup, generateOption);
                            temporarySources.Add(sourceName);
                        }
                        else
                        {
                            if (string.Equals(candidate.Category, CategoryTypes, StringComparison.Ordinal))
                            {
                                _host.ImportType(candidate.TargetTypeGroup, candidate.File, importOptions, swImportOptions);
                            }
                            else if (string.Equals(candidate.Category, CategoryTagTables, StringComparison.Ordinal))
                            {
                                _host.ImportTagTable(candidate.TargetTagTableGroup, candidate.File, importOptions);
                            }
                            else
                            {
                                _host.ImportBlock(candidate.TargetBlockGroup, candidate.File, importOptions, swImportOptions);
                            }
                        }

                        JsonObject record = new JsonObject();
                        record.Add("file", candidate.File);
                        record.AddIfPresent("blockName", candidate.BlockName);
                        record.Add("category", candidate.Category);
                        record.Add("targetGroup", string.IsNullOrEmpty(candidate.TargetGroupPath) ? "(root)" : candidate.TargetGroupPath);
                        record.Add("status", "imported");
                        applied.Add(record);
                        changes.Add(candidate.Category, candidate.BlockName ?? candidate.File, "imported",
                            candidate.IsExternalSource ? "generated from external source" : "Simatic ML import");
                    }
                    catch (ControllerException ex)
                    {
                        failures.Add(Path.GetFileName(candidate.File) + ": " + ex.Message);
                        failure = ex;
                        failureFile = candidate.File;
                        break;
                    }
                }

                if (failure == null)
                {
                    if (!keepSource)
                    {
                        foreach (string sourceName in temporarySources)
                        {
                            PlcExternalSource existingSource = SafeFindExternalSource(software.Software, sourceName);
                            if (existingSource != null) _host.DeleteExternalSource(existingSource);
                        }
                        if (temporarySources.Count > 0)
                        {
                            log.Info("Removed " + temporarySources.Count + " temporary external source(s) after generating blocks.");
                        }
                    }

                    // Commit only after every file was imported. When a file fails,
                    // this call is skipped and disposing the scope rolls the whole
                    // transaction back, so the project keeps its previous content.
                    scope.Commit();
                }
            }

            if (failure != null)
            {
                throw new ControllerException(
                    failure.Code,
                    "The import stopped at " + Text.Quote(Path.GetFileName(failureFile))
                        + " and the transaction was rolled back, so the project is unchanged. " + failure.Message,
                    failure.Details,
                    BuildImportResult(data, applied, null, failures, false));
            }

            if (verify)
            {
                verification = VerifyImport(software, candidates, before, log);
            }

            JsonObject result = BuildImportResult(data, applied, verification, failures, true);
            if (verify && verification != null && !JsonObject.ReadBool(verification, "passed", true))
            {
                throw new ControllerException(
                    "verification_failed",
                    "The import was committed, but reading the objects back from the project did not confirm it: "
                        + JsonObject.ReadString(verification, "message", "verification failed"),
                    JsonObject.Of("verification", verification),
                    result);
            }

            log.Info("Imported " + applied.Count + " file(s) into " + software.DisplayName + ".");
            return result;
        }

        private JsonObject BuildImportResult(JsonObject baseData, List<JsonObject> applied, JsonObject verification,
            List<string> failures, bool committed)
        {
            JsonObject result = new JsonObject();
            foreach (KeyValuePair<string, object> pair in baseData) result.Add(pair.Key, pair.Value);
            result.Add("dryRun", false);
            result.Add("committed", committed);
            result.Add("applied", applied);
            result.Add("failureCount", failures.Count);
            if (failures.Count > 0) result.Add("failures", failures);
            if (verification != null) result.Add("verification", verification);
            return result;
        }

        private JsonObject VerifyImport(PlcSoftwareRef software, List<ImportCandidate> candidates,
            ObjectSnapshot before, DiagnosticLog log)
        {
            ObjectSnapshot now = Snapshot(software, candidates);

            List<JsonObject> checkedBlocks = new List<JsonObject>();
            List<string> missing = new List<string>();
            List<string> advisory = new List<string>();
            int passed = 0;

            foreach (ImportCandidate candidate in candidates)
            {
                if (string.IsNullOrEmpty(candidate.BlockName)) continue;

                JsonObject record = new JsonObject();
                record.Add("name", candidate.BlockName);
                record.AddIfPresent("file", candidate.File);

                if (!now.Contains(candidate.Category, candidate.BlockName))
                {
                    if (candidate.ExactTarget)
                    {
                        missing.Add(candidate.BlockName);
                        record.Add("found", false);
                    }
                    else
                    {
                        // An external source generates blocks; TIA owns the final
                        // names, so a declared name that did not appear is advisory.
                        advisory.Add(candidate.BlockName + " (declared in an external source)");
                        record.Add("found", false);
                        record.Add("advisory", true);
                    }
                    checkedBlocks.Add(record);
                    continue;
                }

                passed++;
                record.Add("found", true);
                string foundGroup = now.GroupOf(candidate.Category, candidate.BlockName);
                record.AddIfPresent("group", foundGroup);
                if (!string.IsNullOrWhiteSpace(candidate.TargetGroupPath))
                {
                    record.Add("expectedGroup", candidate.TargetGroupPath);
                }
                record.Add("attributes", now.Describe(candidate.Category, candidate.BlockName));

                string beforeDate = before.ModifiedDate(candidate.Category, candidate.BlockName);
                string afterDate = now.ModifiedDate(candidate.Category, candidate.BlockName);
                if (before.Contains(candidate.Category, candidate.BlockName))
                {
                    record.AddIfPresent("modifiedDateBefore", beforeDate);
                    record.AddIfPresent("modifiedDateAfter", afterDate);
                    record.Add("replacedExisting", true);
                    record.Add("changed", !string.Equals(beforeDate, afterDate, StringComparison.Ordinal));
                }
                else
                {
                    record.Add("replacedExisting", false);
                    record.Add("changed", true);
                }

                List<string> differences = new List<string>();
                if (!string.IsNullOrWhiteSpace(candidate.TargetGroupPath))
                {
                    string actualGroup = (foundGroup ?? string.Empty).TrimEnd('/');
                    string expectedGroup = candidate.TargetGroupPath.Trim('/');
                    if (!string.Equals(actualGroup, expectedGroup, StringComparison.OrdinalIgnoreCase))
                    {
                        differences.Add("group: expected " + Text.Quote(expectedGroup) + ", project reports "
                            + Text.Quote(actualGroup));
                    }
                }
                if (string.Equals(candidate.Category, CategoryBlocks, StringComparison.Ordinal) && !string.IsNullOrEmpty(candidate.Number))
                {
                    string actual = now.BlockNumber(candidate.BlockName);
                    if (!string.IsNullOrEmpty(actual) && !string.Equals(actual, candidate.Number, StringComparison.Ordinal))
                    {
                        differences.Add("number: file declares " + candidate.Number + ", project reports " + actual);
                    }
                }
                if (string.Equals(candidate.Category, CategoryBlocks, StringComparison.Ordinal) && !string.IsNullOrEmpty(candidate.ProgrammingLanguage))
                {
                    string actual = now.BlockProgrammingLanguage(candidate.BlockName);
                    if (!string.IsNullOrEmpty(actual)
                        && !string.Equals(actual, candidate.ProgrammingLanguage, StringComparison.OrdinalIgnoreCase))
                    {
                        differences.Add("programmingLanguage: file declares " + candidate.ProgrammingLanguage
                            + ", project reports " + actual);
                    }
                }
                if (differences.Count > 0) record.Add("differences", differences);

                checkedBlocks.Add(record);
            }

            JsonObject verification = new JsonObject();
            bool ok = missing.Count == 0;
            verification.Add("passed", ok);
            verification.Add("checked", checkedBlocks.Count);
            verification.Add("confirmedCount", passed);
            verification.Add("missing", missing);
            if (advisory.Count > 0) verification.Add("advisoryNotConfirmed", advisory);
            verification.Add("objects", checkedBlocks);
            verification.Add("blocks", checkedBlocks);
            verification.Add("method", "read_back_plc_compositions");
            verification.Add("message", ok
                ? "Every imported object was found in the composition of its category after the transaction committed."
                : "These objects were not found after the import: " + string.Join(", ", missing));

            if (!ok)
            {
                log.Error("Write-after verification failed: " + JsonObject.ReadString(verification, "message", string.Empty));
            }
            else
            {
                log.Info("Write-after verification confirmed " + passed + " object(s) by reading the project back.");
            }
            return verification;
        }

        // ------------------------------------------------- category-aware helpers

        /// <summary>
        /// Read-back view of one PLC software over the categories an import touched.
        /// Collections are only read for the categories in play, so a block-only
        /// import does not pay for type and tag table traversal.
        /// </summary>
        private sealed class ObjectSnapshot
        {
            private readonly Dictionary<string, BlockRef> _blocks = new Dictionary<string, BlockRef>(StringComparer.OrdinalIgnoreCase);
            private readonly Dictionary<string, PlcTypeRef> _types = new Dictionary<string, PlcTypeRef>(StringComparer.OrdinalIgnoreCase);
            private readonly Dictionary<string, PlcTagTableRef> _tables = new Dictionary<string, PlcTagTableRef>(StringComparer.OrdinalIgnoreCase);

            public void AddBlock(BlockRef block) { if (!_blocks.ContainsKey(block.Name)) _blocks.Add(block.Name, block); }

            public void AddType(PlcTypeRef type) { if (!_types.ContainsKey(type.Name)) _types.Add(type.Name, type); }

            public void AddTagTable(PlcTagTableRef table) { if (!_tables.ContainsKey(table.Name)) _tables.Add(table.Name, table); }

            public bool Contains(string category, string name)
            {
                if (string.IsNullOrEmpty(name)) return false;
                if (string.Equals(category, CategoryTypes, StringComparison.Ordinal)) return _types.ContainsKey(name);
                if (string.Equals(category, CategoryTagTables, StringComparison.Ordinal)) return _tables.ContainsKey(name);
                return _blocks.ContainsKey(name);
            }

            public string GroupOf(string category, string name)
            {
                if (string.Equals(category, CategoryTypes, StringComparison.Ordinal))
                {
                    PlcTypeRef type; return _types.TryGetValue(name, out type) ? type.GroupPath : null;
                }
                if (string.Equals(category, CategoryTagTables, StringComparison.Ordinal))
                {
                    PlcTagTableRef table; return _tables.TryGetValue(name, out table) ? table.GroupPath : null;
                }
                BlockRef block; return _blocks.TryGetValue(name, out block) ? block.GroupPath : null;
            }

            public JsonObject Describe(string category, string name)
            {
                if (string.Equals(category, CategoryTypes, StringComparison.Ordinal))
                {
                    PlcTypeRef type; if (_types.TryGetValue(name, out type)) return OpennessHost.DescribeType(type);
                }
                else if (string.Equals(category, CategoryTagTables, StringComparison.Ordinal))
                {
                    PlcTagTableRef table; if (_tables.TryGetValue(name, out table)) return OpennessHost.DescribeTagTable(table);
                }
                else
                {
                    BlockRef block; if (_blocks.TryGetValue(name, out block)) return OpennessHost.DescribeBlock(block);
                }
                return JsonObject.Of("name", name);
            }

            /// <summary>ISO timestamp of the last modification, or null when unavailable.</summary>
            public string ModifiedDate(string category, string name)
            {
                try
                {
                    if (string.Equals(category, CategoryTypes, StringComparison.Ordinal))
                    {
                        PlcTypeRef type;
                        if (_types.TryGetValue(name, out type)) return type.Type.ModifiedDate.ToString("o", CultureInfo.InvariantCulture);
                    }
                    else if (string.Equals(category, CategoryBlocks, StringComparison.Ordinal))
                    {
                        BlockRef block;
                        if (_blocks.TryGetValue(name, out block)) return block.Block.ModifiedDate.ToString("o", CultureInfo.InvariantCulture);
                    }
                    // PlcTagTable exposes no ModifiedDate in V17.
                }
                catch (Exception)
                {
                    // Timestamps are diagnostics only.
                }
                return null;
            }

            public string BlockNumber(string name)
            {
                BlockRef block;
                if (!_blocks.TryGetValue(name, out block)) return null;
                try { return block.Block.Number.ToString(CultureInfo.InvariantCulture); }
                catch (Exception) { return null; }
            }

            public string BlockProgrammingLanguage(string name)
            {
                BlockRef block;
                if (!_blocks.TryGetValue(name, out block)) return null;
                try { return Convert.ToString(block.Block.ProgrammingLanguage); }
                catch (Exception) { return null; }
            }
        }

        private ObjectSnapshot Snapshot(PlcSoftwareRef software, List<ImportCandidate> candidates)
        {
            bool needTypes = false;
            bool needTables = false;
            foreach (ImportCandidate candidate in candidates)
            {
                if (string.Equals(candidate.Category, CategoryTypes, StringComparison.Ordinal)) needTypes = true;
                else if (string.Equals(candidate.Category, CategoryTagTables, StringComparison.Ordinal)) needTables = true;
            }

            ObjectSnapshot snapshot = new ObjectSnapshot();
            foreach (BlockRef block in _host.CollectBlocks(software.Software, null, true, false)) snapshot.AddBlock(block);
            if (needTypes)
            {
                foreach (PlcTypeRef type in _host.CollectTypes(software.Software, null, true, false)) snapshot.AddType(type);
            }
            if (needTables)
            {
                foreach (PlcTagTableRef table in _host.CollectTagTables(software.Software, null, true, false)) snapshot.AddTagTable(table);
            }
            return snapshot;
        }

        /// <summary>
        /// Resolves the import target of one file inside the group hierarchy of its own
        /// category (block groups, type groups and tag table groups are separate trees).
        /// An explicitly requested group fails loudly; a group mirrored from the
        /// directory layout falls back to the root group of that category.
        /// </summary>
        private void AssignTargetGroup(PlcSoftwareRef software, ImportCandidate candidate, string path,
            bool create, DiagnosticLog log, bool strict)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                candidate.TargetBlockGroup = software.Software.BlockGroup;
                candidate.TargetTypeGroup = software.Software.TypeGroup;
                candidate.TargetTagTableGroup = software.Software.TagTableGroup;
                candidate.TargetGroupPath = string.Empty;
                return;
            }

            if (string.Equals(candidate.Category, CategoryTypes, StringComparison.Ordinal))
            {
                PlcTypeGroup group = _host.ResolveTypeGroup(software.Software, path, create, log);
                if (group == null)
                {
                    if (strict) throw GroupNotFound(path, _host.ListTypeGroupPaths(software.Software), "PLC type");
                    WarnMirroredGroup(log, candidate, path);
                    candidate.TargetTypeGroup = software.Software.TypeGroup;
                    candidate.TargetGroupPath = string.Empty;
                    return;
                }
                candidate.TargetTypeGroup = group;
                candidate.TargetGroupPath = path;
                return;
            }

            if (string.Equals(candidate.Category, CategoryTagTables, StringComparison.Ordinal))
            {
                PlcTagTableGroup group = _host.ResolveTagTableGroup(software.Software, path, create, log);
                if (group == null)
                {
                    if (strict) throw GroupNotFound(path, _host.ListTagTableGroupPaths(software.Software), "tag table");
                    WarnMirroredGroup(log, candidate, path);
                    candidate.TargetTagTableGroup = software.Software.TagTableGroup;
                    candidate.TargetGroupPath = string.Empty;
                    return;
                }
                candidate.TargetTagTableGroup = group;
                candidate.TargetGroupPath = path;
                return;
            }

            PlcBlockGroup blockGroup = _host.ResolveBlockGroup(software.Software, path, create, log);
            if (blockGroup == null)
            {
                if (strict) throw GroupNotFound(path, _host.ListBlockGroupPaths(software.Software), "block");
                WarnMirroredGroup(log, candidate, path);
                candidate.TargetBlockGroup = software.Software.BlockGroup;
                candidate.TargetGroupPath = string.Empty;
                return;
            }
            candidate.TargetBlockGroup = blockGroup;
            candidate.TargetGroupPath = path;
        }

        private static void WarnMirroredGroup(DiagnosticLog log, ImportCandidate candidate, string path)
        {
            log.Warning("The mirrored group " + Text.Quote(path) + " does not exist for " + Path.GetFileName(candidate.File)
                + "; importing into the root group of its category instead.");
        }

        private static ControllerException GroupNotFound(string path, List<string> available, string what)
        {
            return new ControllerException("group_not_found",
                "The target " + what + " group " + Text.Quote(path) + " does not exist in this PLC software. "
                    + "Pass create_group to create it, or use an existing group.",
                JsonObject.Of("targetGroup", path, "available", available));
        }
        private static string ReadModifiedDate(PlcBlock block)
        {
            try
            {
                return block.ModifiedDate.ToString("o", CultureInfo.InvariantCulture);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static string SafeRead(Func<string> read)
        {
            try
            {
                return read();
            }
            catch (Exception)
            {
                return null;
            }
        }

        private List<ImportCandidate> ResolveImportCandidates(List<string> inputs, string mode, bool recursive, List<string> categoryFilter, DiagnosticLog log)
        {
            // The directory a file was found under is remembered as its mirrored group
            // path, which is what makes "export to a folder tree, import the tree" restore
            // the user-group layout: import evaluates name/number collisions across the
            // whole PLC, so a block has to go back into the group it came from.
            List<KeyValuePair<string, string>> files = new List<KeyValuePair<string, string>>();
            foreach (string input in inputs)
            {
                string full = Path.GetFullPath(input.Trim().Trim('"'));
                if (Directory.Exists(full))
                {
                    SearchOption option = recursive ? SearchOption.AllDirectories : SearchOption.TopDirectoryOnly;
                    string[] supported = SimaticMl.SupportedExtensions();
                    foreach (string extension in supported)
                    {
                        try
                        {
                            foreach (string found in Directory.GetFiles(full, "*" + extension, option))
                            {
                                files.Add(new KeyValuePair<string, string>(found, MirrorOf(full, found)));
                            }
                        }
                        catch (UnauthorizedAccessException ex)
                        {
                            log.Warning("Part of " + Text.Quote(full) + " could not be searched: " + ex.Message);
                        }
                    }
                    continue;
                }
                if (File.Exists(full))
                {
                    files.Add(new KeyValuePair<string, string>(full, null));
                    continue;
                }
                throw new ControllerException("invalid_params",
                    "Neither a file nor a directory exists at " + Text.Quote(full) + ".",
                    JsonObject.Of("path", full));
            }

            files.Sort(delegate (KeyValuePair<string, string> a, KeyValuePair<string, string> b)
            {
                return string.Compare(a.Key, b.Key, StringComparison.OrdinalIgnoreCase);
            });

            List<ImportCandidate> candidates = new List<ImportCandidate>();
            foreach (KeyValuePair<string, string> entry in files)
            {
                string file = entry.Key;
                bool external = string.Equals(mode, "external_source", StringComparison.Ordinal)
                    || (string.Equals(mode, "auto", StringComparison.Ordinal) && !SimaticMl.LooksLikeSimaticMl(file));

                if (string.Equals(mode, "simatic_ml", StringComparison.Ordinal) && !SimaticMl.LooksLikeSimaticMl(file))
                {
                    throw new ControllerException("invalid_file",
                        "mode is 'simatic_ml' but " + Text.Quote(Path.GetFileName(file)) + " is not a Simatic ML file (*.xml).");
                }
                if (string.Equals(mode, "external_source", StringComparison.Ordinal) && SimaticMl.LooksLikeSimaticMl(file))
                {
                    throw new ControllerException("invalid_file",
                        "mode is 'external_source' but " + Text.Quote(Path.GetFileName(file)) + " is an XML file.");
                }
                if (!SimaticMl.LooksLikeSimaticMl(file) && !SimaticMl.LooksLikeExternalSource(file))
                {
                    throw new ControllerException("invalid_file",
                        "The file " + Text.Quote(Path.GetFileName(file)) + " has an unsupported extension. Supported: "
                            + string.Join(", ", SimaticMl.SupportedExtensions()) + ".");
                }

                ImportCandidate candidate = new ImportCandidate();
                candidate.File = file;
                candidate.IsExternalSource = external;
                candidate.MirroredGroupPath = entry.Value;
                if (!string.IsNullOrEmpty(entry.Value))
                {
                    log.Info("Mirrored block group " + Text.Quote(entry.Value) + " for " + Path.GetFileName(file) + ".");
                }

                if (external)
                {
                    candidate.Description = SimaticMl.DescribeExternalSource(file);
                    candidate.Category = CategoryBlocks;
                    candidate.ExactTarget = false;
                    candidate.BlockName = FirstDeclaredName(candidate.Description);
                    candidate.BlockKind = "external_source";
                    log.Info("External source " + Path.GetFileName(file) + ": "
                        + JsonObject.ReadInt(candidate.Description, "objectCount", 0) + " declaration(s) found.");
                    if (candidate.BlockName == null)
                    {
                        log.Warning("No block declaration was found in " + Path.GetFileName(file)
                            + "; TIA may still generate blocks, and verification can only confirm the whole project afterwards.");
                    }
                }
                else
                {
                    candidate.Description = SimaticMl.DescribeSimaticMl(file);
                    SimaticMlHeader header = SimaticMl.ReadHeader(file);
                    candidate.Category = header.Category ?? CategoryBlocks;
                    if (categoryFilter.Count > 0 && !categoryFilter.Contains(candidate.Category))
                    {
                        log.Info("Skipping " + Path.GetFileName(file) + ": its category " + candidate.Category
                            + " is not in the requested categories.");
                        continue;
                    }
                    candidate.ExactTarget = header.Kind == "block" || header.Kind == "type" || header.Kind == "tag_table";
                    candidate.BlockName = header.Name;
                    candidate.BlockKind = header.Kind;
                    candidate.SimaticType = header.SimaticType;
                    candidate.Number = header.Number;
                    candidate.ProgrammingLanguage = header.ProgrammingLanguage;
                    foreach (string warning in header.Warnings) log.Warning(Path.GetFileName(file) + ": " + warning);
                }

                candidates.Add(candidate);
            }
            return candidates;
        }

        /// <summary>
        /// Mirror of a file's directory below the imported root, as a group path
        /// (<c>A/B</c>). Returns null when the file sits directly in the root.
        /// </summary>
        private static string MirrorOf(string root, string file)
        {
            string directory = Path.GetDirectoryName(Path.GetFullPath(file));
            if (string.Equals(directory, root, StringComparison.OrdinalIgnoreCase)) return null;
            string relative = directory.Substring(root.Length).Trim('\\', '/');
            return relative.Length == 0 ? null : relative.Replace('\\', '/');
        }

        private static string FirstDeclaredName(JsonObject externalSourceDescription)
        {
            object objects = externalSourceDescription["objects"];
            System.Collections.IEnumerable items = objects as System.Collections.IEnumerable;
            if (items == null) return null;
            foreach (object item in items)
            {
                JsonObject entry = item as JsonObject;
                if (entry == null) continue;
                string name = JsonObject.ReadString(entry, "name", null);
                if (!string.IsNullOrEmpty(name)) return name;
            }
            return null;
        }

        private string UniqueExternalSourceName(PlcSoftware software, string file)
        {
            string baseName = SanitizeFileName(Path.GetFileNameWithoutExtension(file));
            if (baseName.Length > 100) baseName = baseName.Substring(0, 100);

            string candidate = baseName;
            int suffix = 2;
            while (SafeFindExternalSource(software, candidate) != null)
            {
                candidate = baseName + "_" + suffix.ToString(CultureInfo.InvariantCulture);
                suffix++;
                if (suffix > 1000) break;
            }
            return candidate;
        }

        /// <summary>Finds an external source by name, treating a miss as "not present" rather than an error.</summary>
        private static PlcExternalSource SafeFindExternalSource(PlcSoftware software, string name)
        {
            try
            {
                return software.ExternalSourceGroup.ExternalSources.Find(name);
            }
            catch (Exception)
            {
                return null;
            }
        }

        // -------------------------------------------------------------- CompilePlc

        private JsonObject CompilePlc(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string deviceName = p.String("device_name", null);
            string softwareName = p.String("software_name", null);
            int maxMessages = p.Int("max_messages", DefaultMaxMessages);
            if (maxMessages <= 0) maxMessages = DefaultMaxMessages;

            PlcSoftwareRef software = _host.FindPlcSoftware(deviceName, softwareName);

            JsonObject data = new JsonObject();
            data.Add("device", software.DeviceName);
            data.Add("software", software.SoftwareName);
            data.Add("dryRun", false);


            ICompilable compilable = _host.CompilableFor(software.Software);
            progress.Report("compile", "Compiling " + software.DisplayName + " (this can take a while).");

            CompilerResult result;
            DateTime started = DateTime.UtcNow;
            try
            {
                result = compilable.Compile();
            }
            catch (Exception ex)
            {
                throw OpennessHost.OpennessFailure("compile_failed",
                    "Compiling " + software.DisplayName + " failed: " + ex.Message, ex);
            }
            long durationMs = (long)(DateTime.UtcNow - started).TotalMilliseconds;

            List<JsonObject> messages = new List<JsonObject>();
            int total = 0;
            foreach (CompilerResultMessage message in result.Messages)
            {
                Flatten(message, 0, messages, ref total, maxMessages);
            }

            data.Add("state", Convert.ToString(result.State));
            data.Add("errorCount", result.ErrorCount);
            data.Add("warningCount", result.WarningCount);
            data.Add("messageCount", total);
            data.Add("messagesTruncated", total > messages.Count);
            data.Add("messages", messages);
            data.Add("durationMs", durationMs);

            changes.Add("compile", software.DisplayName, string.Equals(Convert.ToString(result.State), "Success", StringComparison.Ordinal)
                ? "succeeded" : "reported_problems",
                result.ErrorCount + " error(s), " + result.WarningCount + " warning(s)");

            if (result.ErrorCount > 0)
            {
                log.Error("The compiler reported " + result.ErrorCount + " error(s) in " + software.DisplayName + ".");
            }
            else
            {
                log.Info("Compile finished in " + Text.Elapsed(durationMs) + " with " + result.WarningCount + " warning(s).");
            }
            return data;
        }

        private static void Flatten(CompilerResultMessage message, int depth, List<JsonObject> target, ref int total, int maxMessages)
        {
            total++;

            // A parent message repeats the aggregate counts of its children; the
            // depth-0 entry is the compile result itself. Leaf messages are what a
            // reader needs, so the tree is flattened shallowest first and capped.
            bool isLeaf = true;
            foreach (CompilerResultMessage child in message.Messages)
            {
                isLeaf = false;
                break;
            }

            if (isLeaf && target.Count < maxMessages && depth > 0)
            {
                JsonObject item = new JsonObject();
                item.Add("level", Convert.ToString(message.State));
                item.AddIfPresent("path", Convert.ToString(message.Path));
                item.AddIfPresent("description", message.Description);
                try
                {
                    item.Add("dateTime", message.DateTime);
                }
                catch (Exception)
                {
                    // Timestamp is optional diagnostics.
                }
                target.Add(item);
            }

            foreach (CompilerResultMessage child in message.Messages)
            {
                Flatten(child, depth + 1, target, ref total, maxMessages);
            }
        }

        // ----------------------------------------------------------- CloseProject

        private JsonObject CloseProject(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            bool save = p.Bool("save", false);
            bool closePortal = p.Bool("close_portal", false);
            bool dryRun = p.Bool("dry_run", true);

            if (!_host.HasProject)
            {
                throw new ControllerException("project_not_open",
                    "No project is open, so there is nothing to close.");
            }

            JsonObject session = _host.DescribeSession();

            if (dryRun)
            {
                JsonObject plan = new JsonObject();
                plan.Add("projectName", JsonObject.ReadString(session, "projectName", null));
                plan.Add("projectPath", JsonObject.ReadString(session, "projectPath", null));
                plan.Add("isModified", JsonObject.ReadBool(session, "isModified", false));
                plan.Add("wouldSave", save);
                plan.Add("wouldClosePortal", closePortal);
                plan.Add("wouldWrite", save || closePortal);
                log.Info("Dry run: the project stays open. Re-run with dry_run disabled "
                    + (save ? "to save and close it." : "to close it without saving."));
                return plan;
            }

            progress.Report("close", save ? "Saving and closing the project." : "Closing the project without saving.");
            JsonObject data = _host.CloseProject(save, closePortal);
            data.Add("dryRun", false);
            changes.Add("project", JsonObject.ReadString(data, "projectPath", null), save ? "saved_and_closed" : "closed",
                save ? "changes persisted" : "unsaved changes discarded");
            log.Info("Closed " + Text.Quote(JsonObject.ReadString(data, "projectName", null))
                + (save ? " after saving." : " without saving."));
            return data;
        }
    }

    /// <summary>File hashing used by the export verification and the manifest.</summary>
    internal static class Hashing
    {
        public static string Sha256OfFile(string path)
        {
            using (SHA256 sha = SHA256.Create())
            {
                using (FileStream stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    byte[] hash = sha.ComputeHash(stream);
                    System.Text.StringBuilder builder = new System.Text.StringBuilder(hash.Length * 2);
                    foreach (byte b in hash) builder.Append(b.ToString("x2", CultureInfo.InvariantCulture));
                    return builder.ToString();
                }
            }
        }
    }
}
