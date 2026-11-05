using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Siemens.Engineering;
using Siemens.Engineering.Library;
using Siemens.Engineering.Library.MasterCopies;
using Siemens.Engineering.Library.Types;
using Siemens.Engineering.SW;
using Siemens.Engineering.SW.Blocks;
using Siemens.Engineering.SW.Tags;
using Siemens.Engineering.SW.Types;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>
    /// The project-library surface of the manual chapter "Functions on libraries".
    ///
    /// One controller operation (<c>ProjectLibrary</c>) carries six actions so the
    /// model sees one coherent tool:
    ///
    ///   browse  - project library tree: type folders/types/versions and
    ///             master-copy folders/master copies with content descriptions.
    ///   read    - export one type version or one master copy to Simatic ML.
    ///   write   - import edited XML back into the library as a master copy
    ///             (replace/new/new version). Type-version import is not part of
    ///             the V17 API and is reported as such.
    ///   publish - create a new master copy from a project object or from edited
    ///             XML; type-version publishing is a TIA Portal UI action in V17.
    ///   organize- folders, rename, delete, copy master copy, set default version.
    ///   use     - instantiate a library object into the project, update project
    ///             instances, list instances/dependencies, run the out-of-date check.
    ///
    /// Everything that changes the project or the library runs inside an
    /// exclusive-access transaction and is committed only after the last change.
    /// </summary>
    internal sealed partial class OpennessOperations
    {
        private static readonly string[] LibraryActionNames =
        {
            "browse", "read", "write", "publish", "organize", "use", "export",
        };
        private static readonly string[] LibraryBrowseKindNames = { "all", "types", "master_copies" };
        private static readonly string[] LibraryObjectKindNames = { "type_version", "master_copy" };
        private static readonly string[] LibraryPublishSourceNames = { "project_object", "file" };
        private static readonly string[] LibraryPublishModeNames = { "new", "replace", "new_version" };
        private static readonly string[] LibraryOrganizeOperationNames =
        {
            "create_folder", "rename", "delete", "copy_master_copy", "set_default_version",
        };
        private static readonly string[] LibraryOrganizeKindNames =
        {
            "type", "type_version", "master_copy", "type_folder", "master_copy_folder",
        };
        private static readonly string[] LibraryUseOperationNames =
        {
            "instantiate", "update_project", "instances", "dependencies", "update_check",
        };
        private static readonly string[] LibraryUseKindNames = { "type_version", "master_copy", "type", "all" };
        private static readonly string[] LibraryUpdateCheckModeNames = { "out_of_date_only", "all" };

        // ------------------------------------------------------------ dispatch

        private JsonObject ProjectLibrary(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string action = p.RequiredEnum("action", LibraryActionNames);
            switch (action)
            {
                case "browse":
                    return LibraryBrowse(p, log, changes, progress);
                case "read":
                    return LibraryRead(p, log, changes, progress);
                case "write":
                    return LibraryWrite(p, log, changes, progress);
                case "publish":
                    return LibraryPublish(p, log, changes, progress);
                case "organize":
                    return LibraryOrganize(p, log, changes, progress);
                case "use":
                    return LibraryUse(p, log, changes, progress);
                case "export":
                    return LibraryExportAll(p, log, changes, progress);
                default:
                    throw new ControllerException("invalid_params", "Unhandled library action " + Text.Quote(action) + ".");
            }
        }

        // -------------------------------------------------------------- browse

        private JsonObject LibraryBrowse(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string kind = p.Enum("kind", LibraryBrowseKindNames, "all");
            string folder = p.String("folder", null);
            bool recursive = p.Bool("recursive", true);
            bool includeVersions = p.Bool("include_versions", true);
            bool includeContent = p.Bool("include_content", true);
            bool includeDependencies = p.Bool("include_dependencies", false);
            string nameFilter = p.String("name_filter", null);
            int maxItems = p.Int("max_items", 500);

            JsonObject data = _host.DescribeLibrary(kind, folder, recursive, includeVersions, includeContent,
                includeDependencies, nameFilter, maxItems, log);
            data.Add("action", "browse");
            data.Add("kind", kind);
            data.Add("dryRun", true);
            return data;
        }

        // ---------------------------------------------------------------- read

        private JsonObject LibraryRead(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string kind = p.RequiredEnum("kind", LibraryObjectKindNames);
            string file = p.RequiredString("output_file");
            string full = Path.GetFullPath(file.Trim().Trim('"'));
            bool overwrite = p.Bool("overwrite", false);
            string exportOptionName = p.Enum("export_options", ExportOptionNames, "with_read_only");

            if (File.Exists(full) && !overwrite)
            {
                throw new ControllerException("file_exists",
                    "The output file " + Text.Quote(full) + " already exists; pass overwrite=true to replace it.",
                    JsonObject.Of("file", full));
            }
            Directory.CreateDirectory(Path.GetDirectoryName(full));

            if (string.Equals(kind, "type_version", StringComparison.Ordinal))
            {
                string name = p.String("name", null);
                string guid = p.String("guid", null);
                string folder = p.String("folder", null);
                LibraryTypeRef reference = _host.FindLibraryType(name, guid, folder, log);
                LibraryTypeVersion version = _host.ResolveLibraryVersion(reference.Type, p.String("version", "default"));
                progress.Report("library", "Exporting the library version " + Text.Quote(name ?? guid) + ".");
                JsonObject data = _host.ExportLibraryVersion(version, full, ParseExportOptions(exportOptionName));
                data.Add("action", "read");
                data.Add("kind", "type_version");
                data.AddIfPresent("name", reference.Name);
                data.Add("folder", reference.FolderPath ?? string.Empty);
                data.AddIfPresent("version", SafeVersionText(version));
                data.Add("dryRun", false);
                changes.Add("library_type_version", (reference.FolderPath ?? string.Empty) + "/" + reference.Name
                    + "@" + SafeVersionText(version), "exported", full);
                log.Info("Exported the library version to " + Text.Quote(full) + ".");
                return data;
            }

            string masterName = p.RequiredString("name");
            string masterFolder = p.String("folder", null);
            LibraryMasterCopyRef master = _host.FindMasterCopy(masterName, masterFolder, log);
            PlcSoftwareRef software = _host.FindPlcSoftware(p.String("device_name", null), p.String("software_name", null));
            progress.Report("library", "Exporting the master copy " + Text.Quote(masterName) + ".");
            JsonObject exported = _host.ExportMasterCopy(master.MasterCopy, full, ParseExportOptions(exportOptionName),
                software.Software, log);
            exported.Add("action", "read");
            exported.Add("kind", "master_copy");
            exported.AddIfPresent("name", master.Name);
            exported.Add("folder", master.FolderPath ?? string.Empty);
            exported.Add("dryRun", false);
            changes.Add("library_master_copy", (master.FolderPath ?? string.Empty) + "/" + master.Name, "exported", full);
            log.Info("Exported the master copy to " + Text.Quote(full) + ".");
            return exported;
        }

        // -------------------------------------------------------------- export

        /// <summary>
        /// Exports the whole project library into a controlled directory tree plus a
        /// manifest. Unlike <c>read</c>, this is the one-time capture a project needs
        /// before its library can be version-controlled: every selected type version
        /// and every master copy is written, and per-object refusals are recorded
        /// instead of aborting the batch.
        /// </summary>
        private JsonObject LibraryExportAll(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string outputDir = Path.GetFullPath(p.RequiredString("output_dir").Trim().Trim('"'));
            string include = p.Enum("include", LibraryBrowseKindNames, "all");
            string versionsMode = p.Enum("versions", new[] { "all", "committed", "default" }, "all");
            bool overwrite = p.Bool("overwrite", false);
            int maxFiles = p.Int("max_files", 200);
            if (maxFiles <= 0) maxFiles = 200;

            bool wantTypes = !string.Equals(include, "master_copies", StringComparison.Ordinal);
            bool wantMasterCopies = !string.Equals(include, "types", StringComparison.Ordinal);

            Directory.CreateDirectory(outputDir);
            List<JsonObject> files = new List<JsonObject>();
            List<JsonObject> failures = new List<JsonObject>();
            List<JsonObject> skippedFiles = new List<JsonObject>();
            HashSet<string> usedPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            int types = 0;
            int typeVersions = 0;
            int masterCopies = 0;

            if (wantTypes)
            {
                foreach (LibraryTypeRef reference in _host.ListLibraryTypes())
                {
                    types++;
                    progress.Report("library", "Exporting the versions of " + Text.Quote(reference.Name) + ".");
                    List<LibraryTypeVersion> selected = SelectVersions(reference.Type, versionsMode);
                    foreach (LibraryTypeVersion version in selected)
                    {
                        typeVersions++;
                        string versionText = SafeVersionText(version) ?? "unknown";
                        string relative = UniqueRelativePath(Path.Combine(
                            "types",
                            SanitizeGroupPath(reference.FolderPath),
                            SanitizeFileName(reference.Name),
                            SanitizeFileName(versionText) + ".xml"), SafeVersionGuid(version), usedPaths);
                        string full = Path.Combine(outputDir, relative);
                        if (File.Exists(full) && !overwrite)
                        {
                            skippedFiles.Add(JsonObject.Of("kind", "type_version", "name", reference.Name,
                                "version", versionText, "file", relative));
                            continue;
                        }
                        try
                        {
                            JsonObject exported = _host.ExportLibraryVersion(version, full, ExportOptions.WithReadOnly);
                            JsonObject entry = JsonObject.Of(
                                "kind", "type_version",
                                "name", reference.Name,
                                "folder", reference.FolderPath ?? string.Empty,
                                "version", versionText,
                                "guid", SafeVersionGuid(version),
                                "state", SafeVersionState(version),
                                "isDefault", SafeVersionIsDefault(version),
                                "file", relative,
                                "bytes", JsonObject.ReadInt(exported, "bytes", 0),
                                "sha256", JsonObject.ReadString(exported, "sha256", null));
                            files.Add(entry);
                            changes.Add("library_type_version", (reference.FolderPath ?? string.Empty) + "/"
                                + reference.Name + "@" + versionText, "exported", relative);
                        }
                        catch (ControllerException ex)
                        {
                            failures.Add(JsonObject.Of("kind", "type_version", "name", reference.Name,
                                "folder", reference.FolderPath ?? string.Empty, "version", versionText,
                                "code", ex.Code, "message", ex.Message));
                            changes.Add("library_type_version", (reference.FolderPath ?? string.Empty) + "/"
                                + reference.Name + "@" + versionText, "export_failed", ex.Code);
                            log.Warning("Could not export " + Text.Quote(reference.Name) + "@" + versionText + ": " + ex.Message);
                        }
                    }
                }
            }

            if (wantMasterCopies)
            {
                PlcSoftwareRef software = null;
                string softwareError = null;
                try
                {
                    software = _host.FindPlcSoftware(p.String("device_name", null), p.String("software_name", null));
                }
                catch (ControllerException ex)
                {
                    softwareError = ex.Message;
                }

                foreach (LibraryMasterCopyRef reference in _host.ListLibraryMasterCopies())
                {
                    masterCopies++;
                    string relative = UniqueRelativePath(Path.Combine("master-copies",
                        SanitizeGroupPath(reference.FolderPath), SanitizeFileName(reference.Name) + ".xml"),
                        "copy", usedPaths);
                    string full = Path.Combine(outputDir, relative);
                    if (File.Exists(full) && !overwrite)
                    {
                        skippedFiles.Add(JsonObject.Of("kind", "master_copy", "name", reference.Name,
                            "file", relative));
                        continue;
                    }
                    if (software == null)
                    {
                        failures.Add(JsonObject.Of("kind", "master_copy", "name", reference.Name,
                            "folder", reference.FolderPath ?? string.Empty, "code", "plc_software_not_found",
                            "message", softwareError ?? "No PLC software is available for master-copy export."));
                        continue;
                    }
                    try
                    {
                        JsonObject exported = _host.ExportMasterCopy(reference.MasterCopy, full,
                            ExportOptions.WithReadOnly, software.Software, log);
                        JsonObject entry = JsonObject.Of(
                            "kind", "master_copy",
                            "name", reference.Name,
                            "folder", reference.FolderPath ?? string.Empty,
                            "contentType", JsonObject.ReadString(exported, "contentType", null),
                            "file", relative,
                            "bytes", JsonObject.ReadInt(exported, "bytes", 0),
                            "sha256", JsonObject.ReadString(exported, "sha256", null));
                        files.Add(entry);
                        changes.Add("library_master_copy", (reference.FolderPath ?? string.Empty) + "/" + reference.Name,
                            "exported", relative);
                    }
                    catch (ControllerException ex)
                    {
                        failures.Add(JsonObject.Of("kind", "master_copy", "name", reference.Name,
                            "folder", reference.FolderPath ?? string.Empty, "code", ex.Code, "message", ex.Message));
                        changes.Add("library_master_copy", (reference.FolderPath ?? string.Empty) + "/" + reference.Name,
                            "export_failed", ex.Code);
                        log.Warning("Could not export master copy " + Text.Quote(reference.Name) + ": " + ex.Message);
                    }
                }
            }

            JsonObject counts = new JsonObject();
            counts.Add("types", types);
            counts.Add("typeVersions", typeVersions);
            counts.Add("masterCopies", masterCopies);
            counts.Add("files", files.Count);
            counts.Add("skipped", skippedFiles.Count);
            counts.Add("failed", failures.Count);

            JsonObject manifest = new JsonObject();
            manifest.Add("schemaVersion", 1);
            manifest.Add("kind", "tia-project-library");
            JsonObject session = _host.DescribeSession();
            manifest.Add("projectName", JsonObject.ReadString(session, "projectName", null));
            manifest.Add("projectPath", JsonObject.ReadString(session, "projectPath", null));
            manifest.Add("exportedAt", DateTime.UtcNow);
            manifest.Add("selection", JsonObject.Of("include", include, "versions", versionsMode));
            manifest.Add("counts", counts);
            manifest.Add("files", files);
            manifest.Add("skipped", skippedFiles);
            manifest.Add("failures", failures);

            string manifestPath = Path.Combine(outputDir, "_manifest.json");
            try
            {
                File.WriteAllText(manifestPath, JsonWriter.Write(manifest, true), new UTF8Encoding(false));
            }
            catch (Exception ex)
            {
                throw new ControllerException("library_export_manifest_failed",
                    "The library files were exported, but the manifest " + Text.Quote(manifestPath)
                        + " could not be written: " + ex.Message,
                    JsonObject.Of("outputDir", outputDir, "files", files.Count));
            }
            changes.Add("file", manifestPath, "written", "library manifest");

            JsonObject data = new JsonObject();
            data.Add("action", "export");
            data.Add("outputDir", outputDir);
            data.Add("manifest", manifestPath);
            data.Add("projectName", JsonObject.ReadString(session, "projectName", null));
            data.Add("selection", JsonObject.Of("include", include, "versions", versionsMode));
            data.Add("counts", counts);
            data.Add("files", files.Count > maxFiles ? files.GetRange(0, maxFiles) : files);
            data.Add("filesTruncated", files.Count > maxFiles);
            data.Add("failures", failures);
            data.Add("dryRun", false);
            log.Info("Exported the project library to " + Text.Quote(outputDir) + " (" + files.Count
                + " file(s), " + failures.Count + " failure(s)).");
            return data;
        }

        /// <summary>
        /// Keeps two library objects with the same sanitized path apart. Type names
        /// are not unique across the library, and a duplicate type can even live in
        /// the same folder with the same version number; the GUID suffix is what
        /// keeps the exported tree lossless.
        /// </summary>
        private static string UniqueRelativePath(string relative, string suffix, HashSet<string> used)
        {
            if (used.Add(relative)) return relative;

            string directory = Path.GetDirectoryName(relative);
            string bare = Path.GetFileNameWithoutExtension(relative);
            string label = string.IsNullOrWhiteSpace(suffix)
                ? "dup"
                : suffix.Replace("-", string.Empty);
            if (label.Length > 8) label = label.Substring(0, 8);
            string candidate = Path.Combine(directory ?? string.Empty, bare + "~" + label + ".xml");
            int counter = 2;
            while (!used.Add(candidate))
            {
                candidate = Path.Combine(directory ?? string.Empty,
                    bare + "~" + label + "_" + counter + ".xml");
                counter++;
            }
            return candidate;
        }

        private static List<LibraryTypeVersion> SelectVersions(LibraryType type, string mode)
        {
            List<LibraryTypeVersion> selected = new List<LibraryTypeVersion>();
            try
            {
                foreach (LibraryTypeVersion version in type.Versions)
                {
                    if (string.Equals(mode, "committed", StringComparison.Ordinal))
                    {
                        string state = SafeVersionState(version);
                        if (!string.Equals(state, "Committed", StringComparison.OrdinalIgnoreCase)) continue;
                    }
                    else if (string.Equals(mode, "default", StringComparison.Ordinal))
                    {
                        if (!SafeVersionIsDefault(version)) continue;
                    }
                    selected.Add(version);
                }
            }
            catch (Exception ex)
            {
                throw new ControllerException("library_version_read_failed",
                    "The versions of library type " + Text.Quote(SafeTypeName(type))
                        + " could not be read: " + ex.Message);
            }
            return selected;
        }

        // --------------------------------------------------------------- write

        private JsonObject LibraryWrite(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string kind = p.RequiredEnum("kind", LibraryObjectKindNames);
            string file = p.RequiredString("file");
            if (!File.Exists(Path.GetFullPath(file.Trim().Trim('"'))))
            {
                throw new ControllerException("file_not_found",
                    "No edited XML exists at " + Text.Quote(file) + ".",
                    JsonObject.Of("file", file));
            }

            if (string.Equals(kind, "type_version", StringComparison.Ordinal))
            {
                bool fallback = p.Bool("allow_master_copy_fallback", false);
                if (!fallback) throw TypeVersionPublishUnsupported("write");
                JsonObject fallbackData = PublishMasterCopyFromFile(p, log, changes, progress, "write", true);
                fallbackData.Add("fallbackFrom", "type_version");
                return fallbackData;
            }

            return PublishMasterCopyFromFile(p, log, changes, progress, "write", false);
        }

        // ------------------------------------------------------------- publish

        private JsonObject LibraryPublish(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string kind = p.RequiredEnum("kind", LibraryObjectKindNames);
            string source = p.Enum("source", LibraryPublishSourceNames, "project_object");
            bool allowFallback = p.Bool("allow_master_copy_fallback", false);

            if (string.Equals(kind, "type_version", StringComparison.Ordinal))
            {
                if (allowFallback && string.Equals(source, "file", StringComparison.Ordinal))
                {
                    JsonObject fallbackData = PublishMasterCopyFromFile(p, log, changes, progress, "publish", true);
                    fallbackData.Add("fallbackFrom", "type_version");
                    fallbackData.Add("supportedByOpenness", false);
                    return fallbackData;
                }
                throw TypeVersionPublishUnsupported("publish");
            }

            if (string.Equals(source, "file", StringComparison.Ordinal))
            {
                return PublishMasterCopyFromFile(p, log, changes, progress, "publish", false);
            }
            return PublishMasterCopyFromProjectObject(p, log, changes, progress);
        }

        /// <summary>
        /// Publishes edited Simatic ML as a master copy. The XML is imported under a
        /// temporary staging name, stored as a master copy, renamed to the target
        /// name, and the staging object is deleted again, all in one transaction.
        /// </summary>
        private JsonObject PublishMasterCopyFromFile(JsonArgs p, DiagnosticLog log, ChangeLog changes,
            IProgressSink progress, string action, bool fallback, string sourceLabel = "file")
        {
            string file = p.RequiredString("file");
            string full = Path.GetFullPath(file.Trim().Trim('"'));
            SimaticMlHeader header = SimaticMl.ReadHeader(full);
            string importKind = header.Kind;
            if (string.Equals(header.Kind, "library_type_version", StringComparison.Ordinal))
            {
                // A library type version export wraps the actual block/type in a
                // ContentObject; publishing it as a master copy is the supported
                // way to put edited library content back into the project library.
                importKind = IsPlcTypeSimatic(header.SimaticType) ? "type" : "block";
            }
            if (string.Equals(importKind, "tag_table", StringComparison.Ordinal))
            {
                throw new ControllerException("library_master_copy_xml_unsupported",
                    "A tag table cannot be published from XML: tag names are unique across the whole PLC, so importing the "
                        + "table under a staging name would still collide with existing tags. Create the master copy from the "
                        + "project object instead (source=project_object).",
                    JsonObject.Of("kind", header.Kind, "name", header.Name));
            }
            if (!string.Equals(importKind, "block", StringComparison.Ordinal)
                && !string.Equals(importKind, "type", StringComparison.Ordinal))
            {
                throw new ControllerException("library_master_copy_xml_unsupported",
                    "Only Simatic ML blocks and PLC types can be published as a master copy from XML; the file contains "
                        + Text.Quote(header.Kind) + ".",
                    JsonObject.Of("kind", header.Kind, "element", header.ElementName, "name", header.Name));
            }

            string mode = p.Enum("mode", LibraryPublishModeNames, "new");
            string requestedName = p.String("name", null);
            string versionLabel = p.String("version_label", null);
            string folderPath = p.String("folder", null);
            bool keepPrevious = p.Bool("keep_previous", true);
            bool dryRun = p.Bool("dry_run", true);
            string targetName = TargetMasterCopyName(requestedName ?? header.Name, mode, versionLabel);

            MasterCopyFolder folder = _host.ResolveMasterCopyFolder(folderPath, !dryRun, log);
            if (folder == null)
            {
                throw new ControllerException("library_folder_not_found",
                    "No master-copy folder exists at " + Text.Quote(folderPath) + ".",
                    JsonObject.Of("folder", folderPath, "available", _host.ListMasterCopyFolderPaths()));
            }
            PlcSoftwareRef software = _host.FindPlcSoftware(p.String("device_name", null), p.String("software_name", null));
            MasterCopy existing = folder.MasterCopies.Find(targetName);

            if (dryRun)
            {
                JsonObject plan = new JsonObject();
                plan.Add("action", action);
                plan.Add("source", sourceLabel);
                plan.Add("kind", "master_copy");
                plan.Add("fallback", fallback);
                if (!string.Equals(sourceLabel, "project_object", StringComparison.Ordinal)) plan.Add("file", full);
                plan.Add("targetFolder", folderPath ?? string.Empty);
                plan.Add("targetName", targetName);
                plan.Add("mode", mode);
                plan.Add("keepPrevious", keepPrevious);
                plan.Add("exists", existing != null);
                plan.Add("header", JsonObject.Of(
                    "element", header.ElementName,
                    "kind", header.Kind,
                    "simaticType", header.SimaticType,
                    "name", header.Name,
                    "number", header.Number,
                    "programmingLanguage", header.ProgrammingLanguage));
                plan.Add("dryRun", true);
                log.Info("Dry run: the edited XML would be published as the master copy " + Text.Quote(targetName) + ".");
                return plan;
            }

            if (existing != null && !string.Equals(mode, "replace", StringComparison.Ordinal))
            {
                throw new ControllerException("library_master_copy_exists",
                    "A master copy named " + Text.Quote(targetName) + " already exists in "
                        + Text.Quote(folderPath ?? "(root)") + ". Pass mode=replace (optionally keep_previous=true) "
                        + "or choose another name/version_label.",
                    JsonObject.Of("name", targetName, "folder", folderPath));
            }

            // The imported object's name becomes the name of the object *inside*
            // the master copy. Use the target name whenever it is free, so the
            // stored content keeps the caller's name; fall back to a unique
            // staging name only when the project already owns that name.
            string importName = ProjectObjectExists(software.Software, importKind, targetName)
                ? LibraryStagingName()
                : targetName;
            string stagingFile = Path.Combine(Path.GetTempPath(), LibraryStagingName() + ".xml");
            JsonObject result = new JsonObject();
            try
            {
                SimaticMl.RewriteObjectName(full, stagingFile, importName);

                progress.Report("library", "Importing the edited XML as " + Text.Quote(importName) + ".");
                using (TransactionScope scope = _host.BeginTransaction("Publish library master copy " + Text.Quote(targetName)))
                {
                    IEngineeringObject created;
                    if (string.Equals(importKind, "block", StringComparison.Ordinal))
                    {
                        software.Software.BlockGroup.Blocks.Import(new FileInfo(stagingFile), ImportOptions.Override);
                        PlcBlock block = software.Software.BlockGroup.Blocks.Find(importName);
                        if (block == null)
                        {
                            throw new ControllerException("library_staging_import_failed",
                                "The edited XML was imported but no block named " + Text.Quote(importName) + " appeared.");
                        }
                        created = block;
                    }
                    else
                    {
                        software.Software.TypeGroup.Types.Import(new FileInfo(stagingFile), ImportOptions.Override);
                        PlcType type = software.Software.TypeGroup.Types.Find(importName);
                        if (type == null)
                        {
                            throw new ControllerException("library_staging_import_failed",
                                "The edited XML was imported but no PLC type named " + Text.Quote(importName) + " appeared.");
                        }
                        created = type;
                    }

                    JsonObject previous = null;
                    if (string.Equals(mode, "replace", StringComparison.Ordinal))
                    {
                        previous = _host.ClearMasterCopyName(folder, targetName, keepPrevious, log);
                    }

                    MasterCopy createdMasterCopy = _host.CreateMasterCopy(folder, created, importName, log);
                    if (!string.Equals(importName, targetName, StringComparison.Ordinal))
                    {
                        createdMasterCopy.Name = targetName;
                        result.Add("contentName", importName);
                        result.Add("contentNameWarning",
                            "The project already contained an object named " + Text.Quote(targetName)
                                + ", so the master copy was staged under " + Text.Quote(importName)
                                + ". Its stored content keeps that staging name; instantiate it with new_name to rename it.");
                    }

                    // Remove the imported object again; the master copy keeps its content.
                    DeleteProjectObject(created);

                    scope.Commit();
                    result.Add("committed", true);
                    if (previous != null) result.Add("previous", previous);
                    result.Add("masterCopy", _host.DescribeMasterCopy(new LibraryMasterCopyRef
                    {
                        MasterCopy = createdMasterCopy,
                        FolderPath = folderPath ?? string.Empty,
                    }, true));
                }
            }
            catch (ControllerException)
            {
                throw;
            }
            catch (Exception ex)
            {
                throw OpennessHost.OpennessFailure("library_master_copy_publish_failed",
                    "Publishing the edited XML as a master copy failed: " + ex.Message, ex);
            }
            finally
            {
                try { if (File.Exists(stagingFile)) File.Delete(stagingFile); }
                catch (Exception) { /* best effort */ }
            }

            result.Add("action", action);
            result.Add("source", sourceLabel);
            result.Add("kind", "master_copy");
            result.Add("fallback", fallback);
            if (!string.Equals(sourceLabel, "project_object", StringComparison.Ordinal)) result.Add("file", full);
            result.Add("targetFolder", folderPath ?? string.Empty);
            result.Add("targetName", targetName);
            result.Add("mode", mode);
            result.Add("dryRun", false);
            changes.Add("library_master_copy", (folderPath ?? string.Empty) + "/" + targetName, "published", full);
            log.Info("Published the edited XML as the master copy " + Text.Quote(targetName) + ".");
            return result;
        }

        /// <summary>Publishes a project object (block/type/tag table) as a master copy.</summary>
        private JsonObject PublishMasterCopyFromProjectObject(JsonArgs p, DiagnosticLog log, ChangeLog changes,
            IProgressSink progress)
        {
            string category = p.Enum("category", CategoryNames, "blocks");
            string objectName = p.RequiredString("object_name");
            string objectGroup = p.String("object_group", null);
            string mode = p.Enum("mode", LibraryPublishModeNames, "new_version");
            string requestedName = p.String("name", null);
            string versionLabel = p.String("version_label", null);
            string folderPath = p.String("folder", null);
            bool keepPrevious = p.Bool("keep_previous", true);
            bool dryRun = p.Bool("dry_run", true);

            PlcSoftwareRef software = _host.FindPlcSoftware(p.String("device_name", null), p.String("software_name", null));
            MasterCopyFolder folder = _host.ResolveMasterCopyFolder(folderPath, !dryRun, log);
            if (folder == null)
            {
                throw new ControllerException("library_folder_not_found",
                    "No master-copy folder exists at " + Text.Quote(folderPath) + ".",
                    JsonObject.Of("folder", folderPath, "available", _host.ListMasterCopyFolderPaths()));
            }

            string targetName = TargetMasterCopyName(requestedName ?? objectName, mode, versionLabel);
            MasterCopy existing = folder.MasterCopies.Find(targetName);
            if (dryRun)
            {
                JsonObject plan = new JsonObject();
                plan.Add("action", "publish");
                plan.Add("source", "project_object");
                plan.Add("kind", "master_copy");
                plan.Add("category", category);
                plan.Add("objectName", objectName);
                plan.AddIfPresent("objectGroup", objectGroup);
                plan.Add("targetFolder", folderPath ?? string.Empty);
                plan.Add("targetName", targetName);
                plan.Add("mode", mode);
                plan.Add("keepPrevious", keepPrevious);
                plan.Add("exists", existing != null);
                plan.Add("dryRun", true);
                log.Info("Dry run: " + Text.Quote(objectName) + " would be published as the master copy "
                    + Text.Quote(targetName) + ".");
                return plan;
            }

            if (existing != null && !string.Equals(mode, "replace", StringComparison.Ordinal))
            {
                throw new ControllerException("library_master_copy_exists",
                    "A master copy named " + Text.Quote(targetName) + " already exists in "
                        + Text.Quote(folderPath ?? "(root)") + ". Pass mode=replace or choose another name/version_label.",
                    JsonObject.Of("name", targetName, "folder", folderPath));
            }

            // A master copy stores the *source object's* name as its content name.
            // For blocks and PLC types we therefore take the same export→import
            // round trip as the XML path: the imported staging object carries the
            // target name, so instantiating the master copy later does not collide
            // with the object it was created from. Tag tables cannot be imported
            // under a staging name (tag names are PLC-global), so they keep the
            // direct Create path and the source name as content name.
            if (!string.Equals(category, "tag_tables", StringComparison.Ordinal))
            {
                IEngineeringObject source = _host.FindProjectObject(software.Software, category, objectName, objectGroup, log);
                string sourceXml = ExportProjectObjectToXml(source, category, log);
                try
                {
                    JsonObject synthetic = new JsonObject();
                    synthetic.Add("file", sourceXml);
                    synthetic.Add("name", requestedName ?? objectName);
                    synthetic.Add("mode", mode);
                    synthetic.Add("version_label", versionLabel);
                    synthetic.Add("folder", folderPath);
                    synthetic.Add("keep_previous", keepPrevious);
                    synthetic.Add("dry_run", false);
                    synthetic.Add("device_name", software.DeviceName);
                    synthetic.Add("software_name", software.SoftwareName);
                    JsonArgs arguments = JsonArgs.Parse(JsonWriter.Write(synthetic, false));
                    JsonObject published = PublishMasterCopyFromFile(arguments, log, changes, progress, "publish", false, "project_object");
                    published.Add("category", category);
                    published.Add("objectName", objectName);
                    published.AddIfPresent("objectGroup", objectGroup);
                    return published;
                }
                finally
                {
                    try { if (File.Exists(sourceXml)) File.Delete(sourceXml); }
                    catch (Exception) { /* best effort */ }
                }
            }

            JsonObject result = new JsonObject();
            using (TransactionScope scope = _host.BeginTransaction("Publish project object as master copy " + Text.Quote(targetName)))
            {
                IEngineeringObject source = _host.FindProjectObject(software.Software, category, objectName, objectGroup, log);
                JsonObject previous = null;
                if (existing != null) previous = _host.ClearMasterCopyName(folder, targetName, keepPrevious, log);
                MasterCopy created = _host.CreateMasterCopy(folder, source, targetName, log);
                scope.Commit();
                result.Add("committed", true);
                if (previous != null) result.Add("previous", previous);
                result.Add("masterCopy", _host.DescribeMasterCopy(new LibraryMasterCopyRef
                {
                    MasterCopy = created,
                    FolderPath = folderPath ?? string.Empty,
                }, true));
            }

            result.Add("action", "publish");
            result.Add("source", "project_object");
            result.Add("kind", "master_copy");
            result.Add("category", category);
            if (string.Equals(category, "tag_tables", StringComparison.Ordinal))
            {
                result.Add("contentName", objectName);
                result.Add("contentNameWarning",
                    "A tag-table master copy keeps the source table name as its content name (tag names are PLC-global). "
                        + "Instantiate it with new_name into a project that does not already own that table name.");
            }
            result.Add("objectName", objectName);
            result.AddIfPresent("objectGroup", objectGroup);
            result.Add("targetFolder", folderPath ?? string.Empty);
            result.Add("targetName", targetName);
            result.Add("mode", mode);
            result.Add("dryRun", false);
            changes.Add("library_master_copy", (folderPath ?? string.Empty) + "/" + targetName, "published", objectName);
            log.Info("Published " + Text.Quote(objectName) + " as the master copy " + Text.Quote(targetName) + ".");
            return result;
        }

        private static ControllerException TypeVersionPublishUnsupported(string action)
        {
            List<string> steps = new List<string>
            {
                "Export the committed type version with project_library action=read kind=type_version.",
                "Edit the XML locally (or edit the block in the project and import it there).",
                "In TIA Portal open Project library > Types, create a new version from the edited instance and release it.",
                "Re-run action=browse to verify the new version and its Committed state.",
            };
            JsonObject details = new JsonObject();
            details.Add("opennessVersion", "17");
            details.Add("supported", false);
            details.Add("reason",
                "TIA Portal Openness V17 exposes LibraryTypeVersion.Export but has no Import, CreateVersion or Release "
                    + "action. The version state is read-only (InWork/Committed); 'released' is set only in the TIA Portal UI.");
            details.Add("manualTopic", "Functions on libraries > Accessing type versions / Accessing blocks located in library");
            details.Add("uiSteps", steps);
            details.Add("fallback",
                "Publish the edited XML as an unversioned master copy instead: action=" + action
                    + " kind=master_copy (or kind=type_version with allow_master_copy_fallback=true). "
                    + "A master copy has no version number, so use name/version_label to record the version.");
            return new ControllerException("library_type_version_publish_unsupported",
                "Openness V17 cannot publish a library type version: it has no import/create/release API for versions. "
                    + "Use the TIA Portal UI for the type version, or publish the content as a master copy.",
                details);
        }

        // ------------------------------------------------------------ organize

        private JsonObject LibraryOrganize(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string operation = p.RequiredEnum("operation", LibraryOrganizeOperationNames);
            string kind = p.RequiredEnum("kind", LibraryOrganizeKindNames);
            bool dryRun = p.Bool("dry_run", true);
            string folder = p.String("folder", null);
            string name = p.String("name", null);
            string newName = p.String("new_name", null);

            switch (operation)
            {
                case "create_folder":
                    return LibraryCreateFolder(kind, folder, name, dryRun, log, changes);
                case "rename":
                    return LibraryRename(kind, folder, name, newName, dryRun, log, changes);
                case "delete":
                    return LibraryDelete(kind, folder, name, p.String("version", null),
                        p.Bool("confirm", false), dryRun, log, changes);
                case "copy_master_copy":
                    return LibraryCopyMasterCopy(folder, name, p.String("target_folder", null), newName, dryRun, log, changes);
                case "set_default_version":
                    return LibrarySetDefaultVersion(folder, name, p.String("guid", null), p.String("version", "default"),
                        dryRun, log, changes);
                default:
                    throw new ControllerException("invalid_params", "Unhandled library organize operation " + Text.Quote(operation) + ".");
            }
        }

        private JsonObject LibraryCreateFolder(string kind, string folder, string name, bool dryRun,
            DiagnosticLog log, ChangeLog changes)
        {
            if (string.IsNullOrWhiteSpace(name))
            {
                throw new ControllerException("invalid_params", "'name' is required for operation=create_folder.");
            }
            bool types = string.Equals(kind, "type_folder", StringComparison.Ordinal);
            if (!types && !string.Equals(kind, "master_copy_folder", StringComparison.Ordinal))
            {
                throw new ControllerException("invalid_params",
                    "operation=create_folder needs kind=type_folder or kind=master_copy_folder.");
            }

            if (dryRun)
            {
                return JsonObject.Of(
                    "action", "organize", "operation", "create_folder", "kind", kind,
                    "folder", folder ?? string.Empty, "name", name, "dryRun", true);
            }

            using (TransactionScope scope = _host.BeginTransaction("Create library folder " + Text.Quote(name)))
            {
                if (types)
                {
                    LibraryTypeFolder parent = _host.ResolveTypeFolder(folder, true, log);
                    LibraryTypeUserFolder created = parent.Folders.Create(name.Trim());
                    scope.Commit();
                    changes.Add("library_type_folder", (folder ?? string.Empty) + "/" + name, "created");
                    return JsonObject.Of(
                        "action", "organize", "operation", "create_folder", "kind", kind,
                        "folder", folder ?? string.Empty, "name", created.Name, "dryRun", false);
                }
                else
                {
                    MasterCopyFolder parent = _host.ResolveMasterCopyFolder(folder, true, log);
                    MasterCopyUserFolder created = parent.Folders.Create(name.Trim());
                    scope.Commit();
                    changes.Add("library_master_copy_folder", (folder ?? string.Empty) + "/" + name, "created");
                    return JsonObject.Of(
                        "action", "organize", "operation", "create_folder", "kind", kind,
                        "folder", folder ?? string.Empty, "name", created.Name, "dryRun", false);
                }
            }
        }

        private JsonObject LibraryRename(string kind, string folder, string name, string newName, bool dryRun,
            DiagnosticLog log, ChangeLog changes)
        {
            if (string.IsNullOrWhiteSpace(newName))
            {
                throw new ControllerException("invalid_params", "'new_name' is required for operation=rename.");
            }
            if (dryRun)
            {
                return JsonObject.Of(
                    "action", "organize", "operation", "rename", "kind", kind,
                    "folder", folder ?? string.Empty, "name", name, "newName", newName, "dryRun", true);
            }

            using (TransactionScope scope = _host.BeginTransaction("Rename library object " + Text.Quote(name)))
            {
                string oldPath;
                if (string.Equals(kind, "type", StringComparison.Ordinal))
                {
                    LibraryTypeRef reference = _host.FindLibraryType(name, null, folder, log);
                    oldPath = (reference.FolderPath ?? string.Empty) + "/" + reference.Name;
                    reference.Type.Name = newName.Trim();
                }
                else if (string.Equals(kind, "master_copy", StringComparison.Ordinal))
                {
                    LibraryMasterCopyRef reference = _host.FindMasterCopy(name, folder, log);
                    oldPath = (reference.FolderPath ?? string.Empty) + "/" + reference.Name;
                    reference.MasterCopy.Name = newName.Trim();
                }
                else if (string.Equals(kind, "type_folder", StringComparison.Ordinal))
                {
                    LibraryTypeFolder target = _host.ResolveTypeFolder(folder, false, log);
                    if (target == null)
                    {
                        throw new ControllerException("library_folder_not_found",
                            "No type folder exists at " + Text.Quote(folder) + ".");
                    }
                    LibraryTypeUserFolder user = target as LibraryTypeUserFolder;
                    if (user == null)
                    {
                        throw new ControllerException("library_folder_rename_unsupported",
                            "The type system folder cannot be renamed.");
                    }
                    oldPath = folder;
                    user.Name = newName.Trim();
                }
                else if (string.Equals(kind, "master_copy_folder", StringComparison.Ordinal))
                {
                    MasterCopyFolder target = _host.ResolveMasterCopyFolder(folder, false, log);
                    if (target == null)
                    {
                        throw new ControllerException("library_folder_not_found",
                            "No master-copy folder exists at " + Text.Quote(folder) + ".");
                    }
                    MasterCopyUserFolder user = target as MasterCopyUserFolder;
                    if (user == null)
                    {
                        throw new ControllerException("library_folder_rename_unsupported",
                            "The master-copy system folder cannot be renamed.");
                    }
                    oldPath = folder;
                    user.Name = newName.Trim();
                }
                else
                {
                    throw new ControllerException("library_version_rename_unsupported",
                        "A library type version has no settable name; it is identified by its version number. "
                            + "Rename the owning type instead.");
                }

                scope.Commit();
                changes.Add("library_" + kind, oldPath, "renamed", newName);
                return JsonObject.Of(
                    "action", "organize", "operation", "rename", "kind", kind,
                    "folder", folder ?? string.Empty, "name", name, "newName", newName, "dryRun", false);
            }
        }

        private JsonObject LibraryDelete(string kind, string folder, string name, string version, bool confirm,
            bool dryRun, DiagnosticLog log, ChangeLog changes)
        {
            if (!confirm)
            {
                throw new ControllerException("confirmation_required",
                    "Deleting library content needs confirm=true; run once with dry_run=true to inspect the target.");
            }
            if (dryRun)
            {
                return JsonObject.Of(
                    "action", "organize", "operation", "delete", "kind", kind,
                    "folder", folder ?? string.Empty, "name", name, "version", version ?? string.Empty, "dryRun", true);
            }

            using (TransactionScope scope = _host.BeginTransaction("Delete library content " + Text.Quote(name)))
            {
                if (string.Equals(kind, "type", StringComparison.Ordinal))
                {
                    LibraryTypeRef reference = _host.FindLibraryType(name, null, folder, log);
                    reference.Type.Delete();
                }
                else if (string.Equals(kind, "type_version", StringComparison.Ordinal))
                {
                    LibraryTypeRef reference = _host.FindLibraryType(name, null, folder, log);
                    LibraryTypeVersion resolved = _host.ResolveLibraryVersion(reference.Type, version);
                    resolved.Delete();
                }
                else if (string.Equals(kind, "master_copy", StringComparison.Ordinal))
                {
                    LibraryMasterCopyRef reference = _host.FindMasterCopy(name, folder, log);
                    reference.MasterCopy.Delete();
                }
                else if (string.Equals(kind, "type_folder", StringComparison.Ordinal))
                {
                    LibraryTypeFolder target = _host.ResolveTypeFolder(folder, false, log);
                    LibraryTypeUserFolder user = target as LibraryTypeUserFolder;
                    if (user == null)
                    {
                        throw new ControllerException("library_folder_delete_unsupported",
                            "The type system folder cannot be deleted.");
                    }
                    user.Delete();
                }
                else if (string.Equals(kind, "master_copy_folder", StringComparison.Ordinal))
                {
                    MasterCopyFolder target = _host.ResolveMasterCopyFolder(folder, false, log);
                    MasterCopyUserFolder user = target as MasterCopyUserFolder;
                    if (user == null)
                    {
                        throw new ControllerException("library_folder_delete_unsupported",
                            "The master-copy system folder cannot be deleted.");
                    }
                    user.Delete();
                }
                else
                {
                    throw new ControllerException("invalid_params", "Unsupported delete kind " + Text.Quote(kind) + ".");
                }

                scope.Commit();
                changes.Add("library_" + kind, (folder ?? string.Empty) + "/" + name, "deleted");
                return JsonObject.Of(
                    "action", "organize", "operation", "delete", "kind", kind,
                    "folder", folder ?? string.Empty, "name", name, "version", version ?? string.Empty, "dryRun", false);
            }
        }

        private JsonObject LibraryCopyMasterCopy(string folder, string name, string targetFolder, string newName,
            bool dryRun, DiagnosticLog log, ChangeLog changes)
        {
            LibraryMasterCopyRef source = _host.FindMasterCopy(name, folder, log);
            MasterCopyFolder target = _host.ResolveMasterCopyFolder(targetFolder, !dryRun, log);
            if (target == null)
            {
                throw new ControllerException("library_folder_not_found",
                    "No master-copy folder exists at " + Text.Quote(targetFolder) + ".",
                    JsonObject.Of("folder", targetFolder, "available", _host.ListMasterCopyFolderPaths()));
            }
            if (dryRun)
            {
                return JsonObject.Of(
                    "action", "organize", "operation", "copy_master_copy", "kind", "master_copy",
                    "name", source.Name, "folder", source.FolderPath ?? string.Empty,
                    "targetFolder", targetFolder ?? string.Empty, "newName", newName ?? source.Name, "dryRun", true);
            }

            using (TransactionScope scope = _host.BeginTransaction("Copy master copy " + Text.Quote(source.Name)))
            {
                MasterCopy copy = target.MasterCopies.CreateFrom(source.MasterCopy);
                if (!string.IsNullOrWhiteSpace(newName) && !string.Equals(copy.Name, newName.Trim(), StringComparison.Ordinal))
                {
                    copy.Name = newName.Trim();
                }
                scope.Commit();
                changes.Add("library_master_copy", (targetFolder ?? string.Empty) + "/" + copy.Name, "copied", source.Name);
                return JsonObject.Of(
                    "action", "organize", "operation", "copy_master_copy", "kind", "master_copy",
                    "name", source.Name, "folder", source.FolderPath ?? string.Empty,
                    "targetFolder", targetFolder ?? string.Empty, "newName", copy.Name, "dryRun", false);
            }
        }

        private JsonObject LibrarySetDefaultVersion(string folder, string name, string guid, string version,
            bool dryRun, DiagnosticLog log, ChangeLog changes)
        {
            LibraryTypeRef reference = _host.FindLibraryType(name, guid, folder, log);
            LibraryTypeVersion resolved = _host.ResolveLibraryVersion(reference.Type, version);
            if (dryRun)
            {
                return JsonObject.Of(
                    "action", "organize", "operation", "set_default_version", "kind", "type_version",
                    "name", reference.Name, "folder", reference.FolderPath ?? string.Empty,
                    "version", SafeVersionText(resolved), "dryRun", true);
            }

            using (TransactionScope scope = _host.BeginTransaction("Set default library version"))
            {
                resolved.SetAsDefault();
                scope.Commit();
                changes.Add("library_type_version", (reference.FolderPath ?? string.Empty) + "/" + reference.Name
                    + "@" + SafeVersionText(resolved), "set_as_default");
                return JsonObject.Of(
                    "action", "organize", "operation", "set_default_version", "kind", "type_version",
                    "name", reference.Name, "folder", reference.FolderPath ?? string.Empty,
                    "version", SafeVersionText(resolved), "dryRun", false);
            }
        }

        // ----------------------------------------------------------------- use

        private JsonObject LibraryUse(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string operation = p.RequiredEnum("operation", LibraryUseOperationNames);
            switch (operation)
            {
                case "instantiate":
                    return LibraryInstantiate(p, log, changes, progress);
                case "update_project":
                    return LibraryUpdateProject(p, log, changes, progress);
                case "instances":
                    return LibraryInstances(p, log, changes, progress);
                case "dependencies":
                    return LibraryDependencies(p, log, changes, progress);
                case "update_check":
                    return LibraryUpdateCheck(p, log, changes, progress);
                default:
                    throw new ControllerException("invalid_params", "Unhandled library use operation " + Text.Quote(operation) + ".");
            }
        }

        private JsonObject LibraryInstantiate(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string kind = p.RequiredEnum("kind", LibraryObjectKindNames);
            string folder = p.String("folder", null);
            string targetGroup = p.String("target_group", null);
            string newName = p.String("new_name", null);
            bool dryRun = p.Bool("dry_run", true);
            PlcSoftwareRef software = _host.FindPlcSoftware(p.String("device_name", null), p.String("software_name", null));

            if (dryRun)
            {
                return JsonObject.Of(
                    "action", "use", "operation", "instantiate", "kind", kind,
                    "name", p.String("name", null), "folder", folder ?? string.Empty,
                    "targetGroup", targetGroup ?? string.Empty, "newName", newName ?? string.Empty, "dryRun", true);
            }

            using (TransactionScope scope = _host.BeginTransaction("Instantiate library object"))
            {
                IEngineeringObject created;
                if (string.Equals(kind, "type_version", StringComparison.Ordinal))
                {
                    LibraryTypeRef reference = _host.FindLibraryType(p.String("name", null), p.String("guid", null), folder, log);
                    LibraryTypeVersion version = _host.ResolveLibraryVersion(reference.Type, p.String("version", "default"));
                    CodeBlockLibraryTypeVersion code = version as CodeBlockLibraryTypeVersion;
                    if (code != null)
                    {
                        PlcBlockGroup group = _host.ResolveBlockGroup(software.Software, targetGroup, true, log);
                        created = group.Blocks.CreateFrom(code);
                    }
                    else
                    {
                        PlcTypeLibraryTypeVersion type = version as PlcTypeLibraryTypeVersion;
                        if (type == null)
                        {
                            throw new ControllerException("library_version_instantiate_unsupported",
                                "This library version (" + version.GetType().FullName + ") is not a PLC code block or PLC type; "
                                    + "this plugin cannot instantiate it.");
                        }
                        PlcTypeGroup group = _host.ResolveTypeGroup(software.Software, targetGroup, true, log);
                        created = group.Types.CreateFrom(type);
                    }
                }
                else
                {
                    LibraryMasterCopyRef reference = _host.FindMasterCopy(p.RequiredString("name"), folder, log);
                    created = _host.InstantiateMasterCopy(reference.MasterCopy, software.Software, targetGroup, newName, log);
                }

                // The master-copy helper already renames the object it creates;
                // only the type-version path needs the extra SetAttribute.
                if (string.Equals(kind, "type_version", StringComparison.Ordinal)
                    && !string.IsNullOrWhiteSpace(newName))
                {
                    created.SetAttribute("Name", newName.Trim());
                }
                scope.Commit();
                changes.Add("library_instance", newName ?? p.String("name", null), "created", software.DisplayName);
                return JsonObject.Of(
                    "action", "use", "operation", "instantiate", "kind", kind,
                    "name", newName ?? p.String("name", null), "targetGroup", targetGroup ?? string.Empty,
                    "dryRun", false);
            }
        }

        private JsonObject LibraryUpdateProject(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string kind = p.Enum("kind", LibraryUseKindNames, "all");
            string folder = p.String("folder", null);
            string name = p.String("name", null);
            bool dryRun = p.Bool("dry_run", true);
            if (string.Equals(kind, "master_copy", StringComparison.Ordinal))
            {
                throw new ControllerException("invalid_params",
                    "update_project updates type-version instances; it has no master-copy mode. Use kind=all/type/type_version.");
            }
            PlcSoftwareRef software = _host.FindPlcSoftware(p.String("device_name", null), p.String("software_name", null));

            if (dryRun)
            {
                return JsonObject.Of(
                    "action", "use", "operation", "update_project", "kind", kind,
                    "folder", folder ?? string.Empty, "name", name ?? string.Empty,
                    "device", software.DeviceName, "software", software.SoftwareName, "dryRun", true);
            }

            List<ILibraryTypeOrFolderSelection> selections = new List<ILibraryTypeOrFolderSelection>();
            if (string.Equals(kind, "all", StringComparison.Ordinal))
            {
                selections.Add(_host.ProjectLibrary.TypeFolder);
            }
            else if (string.Equals(kind, "type", StringComparison.Ordinal)
                || string.Equals(kind, "type_version", StringComparison.Ordinal))
            {
                LibraryTypeRef reference = _host.FindLibraryType(name, p.String("guid", null), folder, log);
                selections.Add(reference.Type);
            }
            else
            {
                LibraryTypeFolder selected = _host.ResolveTypeFolder(folder, false, log);
                if (selected == null)
                {
                    throw new ControllerException("library_folder_not_found",
                        "No type folder exists at " + Text.Quote(folder) + ".",
                        JsonObject.Of("folder", folder, "available", _host.ListTypeFolderPaths()));
                }
                selections.Add(selected);
            }

            IUpdateProjectScope scope = software.Software as IUpdateProjectScope;
            if (scope == null)
            {
                throw new ControllerException("library_update_project_unsupported",
                    "The selected PLC software does not implement IUpdateProjectScope.");
            }

            using (TransactionScope transaction = _host.BeginTransaction("Update project library instances"))
            {
                _host.ProjectLibrary.UpdateProject(selections, new List<IUpdateProjectScope> { scope });
                transaction.Commit();
            }
            changes.Add("library", software.DisplayName, "instances_updated", kind);
            return JsonObject.Of(
                "action", "use", "operation", "update_project", "kind", kind,
                "folder", folder ?? string.Empty, "name", name ?? string.Empty,
                "device", software.DeviceName, "software", software.SoftwareName, "dryRun", false);
        }

        private JsonObject LibraryInstances(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            PlcSoftwareRef software = _host.FindPlcSoftware(p.String("device_name", null), p.String("software_name", null));
            LibraryTypeRef reference = _host.FindLibraryType(p.String("name", null), p.String("guid", null),
                p.String("folder", null), log);
            LibraryTypeVersion version = _host.ResolveLibraryVersion(reference.Type, p.String("version", "default"));
            IInstanceSearchScope scope = software.Software as IInstanceSearchScope;
            if (scope == null)
            {
                throw new ControllerException("library_instances_unsupported",
                    "The selected PLC software does not implement IInstanceSearchScope.");
            }

            List<JsonObject> items = new List<JsonObject>();
            try
            {
                foreach (LibraryTypeInstanceInfo info in version.FindInstances(scope))
                {
                    IEngineeringObject instance = info.LibraryTypeInstance;
                    JsonObject item = new JsonObject();
                    item.AddIfPresent("name", SafeAttribute(instance, "Name"));
                    item.AddIfPresent("type", SafeAttribute(instance, "Type"));
                    item.AddIfPresent("path", SafeAttribute(instance, "Path"));
                    items.Add(item);
                }
            }
            catch (Exception ex)
            {
                throw OpennessHost.OpennessFailure("library_instances_failed",
                    "Finding the instances of the library version failed: " + ex.Message, ex);
            }

            return JsonObject.Of(
                "action", "use", "operation", "instances", "name", reference.Name,
                "version", SafeVersionText(version), "device", software.DeviceName, "software", software.SoftwareName,
                "count", items.Count, "items", items, "dryRun", true);
        }

        private JsonObject LibraryDependencies(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            LibraryTypeRef reference = _host.FindLibraryType(p.String("name", null), p.String("guid", null),
                p.String("folder", null), log);
            LibraryTypeVersion version = _host.ResolveLibraryVersion(reference.Type, p.String("version", "default"));
            JsonObject data = new JsonObject();
            data.Add("action", "use");
            data.Add("operation", "dependencies");
            data.Add("name", reference.Name);
            data.Add("version", SafeVersionText(version));
            data.Add("dependencies", _host.DescribeVersionAssociation(version, true));
            data.Add("dependents", _host.DescribeVersionAssociation(version, false));
            data.Add("dryRun", true);
            return data;
        }

        private JsonObject LibraryUpdateCheck(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string mode = p.Enum("mode", LibraryUpdateCheckModeNames, "out_of_date_only");
            UpdateCheckMode updateMode = string.Equals(mode, "all", StringComparison.Ordinal)
                ? UpdateCheckMode.ReportOutOfDateAndUpToDate
                : UpdateCheckMode.ReportOutOfDateOnly;
            UpdateCheckResult result = _host.ProjectLibrary.UpdateCheck(_host.Project, updateMode);
            List<JsonObject> messages = new List<JsonObject>();
            FlattenUpdateCheck(result.Messages, 0, messages);
            return JsonObject.Of(
                "action", "use", "operation", "update_check", "mode", mode,
                "messageCount", messages.Count, "messages", messages, "dryRun", true);
        }

        private static void FlattenUpdateCheck(UpdateCheckResultMessageComposition messages, int depth, List<JsonObject> rows)
        {
            if (messages == null) return;
            foreach (UpdateCheckResultMessage message in messages)
            {
                JsonObject row = new JsonObject();
                row.Add("depth", depth);
                row.AddIfPresent("description", message.Description);
                JsonObject parts = new JsonObject();
                try
                {
                    foreach (KeyValuePair<string, string> part in message.MessageParts)
                    {
                        parts.Add(part.Key, part.Value);
                    }
                }
                catch (Exception)
                {
                    // MessageParts is best effort.
                }
                if (parts.Count > 0) row.Add("parts", parts);
                rows.Add(row);
                FlattenUpdateCheck(message.Messages, depth + 1, rows);
            }
        }

        // -------------------------------------------------------------- helpers

        private static bool IsPlcTypeSimatic(string simaticType)
        {
            return string.Equals(simaticType, "PlcStruct", StringComparison.OrdinalIgnoreCase)
                || string.Equals(simaticType, "PlcType", StringComparison.OrdinalIgnoreCase);
        }

        private static string TargetMasterCopyName(string baseName, string mode, string versionLabel)
        {
            string name = string.IsNullOrWhiteSpace(baseName) ? "library_master_copy" : baseName.Trim();
            if (!string.Equals(mode, "new_version", StringComparison.Ordinal)) return name;
            string label = string.IsNullOrWhiteSpace(versionLabel)
                ? DateTime.Now.ToString("yyyyMMddHHmmss")
                : versionLabel.Trim();
            return name + "_v" + label;
        }

        private static string LibraryStagingName()
        {
            return "dsh_lib_" + Guid.NewGuid().ToString("N").Substring(0, 8);
        }

        private string ExportProjectObjectToXml(IEngineeringObject source, string category, DiagnosticLog log)
        {
            string file = Path.Combine(Path.GetTempPath(), "dsh_lib_src_" + Guid.NewGuid().ToString("N") + ".xml");
            PlcBlock block = source as PlcBlock;
            if (block != null)
            {
                _host.ExportBlock(block, file, ExportOptions.None);
                return file;
            }
            PlcType type = source as PlcType;
            if (type != null)
            {
                _host.ExportType(type, file, ExportOptions.None);
                return file;
            }
            PlcTagTable table = source as PlcTagTable;
            if (table != null)
            {
                _host.ExportTagTable(table, file, ExportOptions.None);
                return file;
            }
            throw new ControllerException("library_project_object_export_unsupported",
                "The project object (" + source.GetType().FullName + ") has no Simatic ML export this plugin knows.");
        }

        private bool ProjectObjectExists(PlcSoftware software, string importKind, string name)
        {
            if (software == null || string.IsNullOrWhiteSpace(name)) return false;
            List<string> names = new List<string> { name };
            if (string.Equals(importKind, "type", StringComparison.Ordinal))
            {
                // CollectTypes walks user groups; a root-level Find would miss a
                // type that lives in a group, and TIA's collision check is PLC-wide.
                return _host.CollectTypes(software, names, true, false).Count > 0;
            }
            return _host.CollectBlocks(software, names, true, false).Count > 0;
        }

        private static void DeleteProjectObject(IEngineeringObject target)
        {
            PlcBlock block = target as PlcBlock;
            if (block != null) { block.Delete(); return; }
            PlcType type = target as PlcType;
            if (type != null) { type.Delete(); return; }
            PlcTagTable table = target as PlcTagTable;
            if (table != null) { table.Delete(); return; }
        }

        private static string SafeAttribute(IEngineeringObject target, string name)
        {
            try
            {
                object value = target.GetAttribute(name);
                return value == null ? null : Convert.ToString(value);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static string SafeVersionText(LibraryTypeVersion version)
        {
            try
            {
                return version == null ? null : version.VersionNumber.ToString();
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static string SafeVersionGuid(LibraryTypeVersion version)
        {
            try { return version == null ? null : version.Guid.ToString(); }
            catch (Exception) { return null; }
        }

        private static string SafeVersionState(LibraryTypeVersion version)
        {
            try { return version == null ? null : version.State.ToString(); }
            catch (Exception) { return null; }
        }

        private static bool SafeVersionIsDefault(LibraryTypeVersion version)
        {
            try { return version != null && version.IsDefault; }
            catch (Exception) { return false; }
        }

        private static string SafeTypeName(LibraryType type)
        {
            try { return type == null ? null : type.Name; }
            catch (Exception) { return null; }
        }
    }
}
