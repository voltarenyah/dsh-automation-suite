using System;
using System.Collections.Generic;
using System.IO;
using Siemens.Engineering;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>
    /// The manual chapter "Functions for projects and project data": creating,
    /// saving, archiving and retrieving a project, and reading or writing the
    /// project's attributes, languages, texts and the TIA Portal settings.
    ///
    /// The parameter and payload contract is frozen in
    /// <c>docs/EXTENDED-SURFACE.md</c>; the DSH tools in <c>src/tools.ts</c> send
    /// exactly these names.
    /// </summary>
    internal sealed partial class OpennessOperations
    {
        private static readonly string[] ArchiveActionNames = { "archive", "retrieve" };
        private static readonly string[] ArchivationModeNames =
        {
            "none", "compressed", "discard_restorable_data", "discard_restorable_data_and_compressed",
        };
        private static readonly string[] ProjectOpenModeNames = { "primary", "secondary" };
        private static readonly string[] ProjectInfoSectionNames =
        {
            "attributes", "comment", "languages", "history", "products", "devices", "software", "settings",
        };
        private static readonly string[] LanguageActionNames = { "list", "set" };
        private static readonly string[] LanguageActiveModeNames = { "add", "remove" };
        private static readonly string[] ProjectTextActionNames = { "export", "import" };
        private static readonly string[] PortalSettingActionNames = { "list", "set" };

        // ------------------------------------------------------- CreateProject

        private JsonObject CreateProject(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string projectDir = p.RequiredString("project_dir");
            string projectName = p.RequiredString("project_name");
            string author = p.String("author", null);
            string comment = p.String("comment", null);
            bool withWindow = p.Bool("with_window", false);

            if (_host.HasProject)
            {
                throw new ControllerException("project_already_open",
                    "A project is already open (" + Text.Quote(JsonObject.ReadString(_host.DescribeSession(), "projectName", "?"))
                        + "). Close it first with CloseProject.",
                    _host.DescribeSession());
            }

            string fullDirectory;
            try
            {
                fullDirectory = Path.GetFullPath(projectDir.Trim().Trim('"'));
            }
            catch (Exception ex)
            {
                throw new ControllerException("invalid_params", "'project_dir' is not a valid path: " + ex.Message);
            }
            string targetPath = Path.Combine(fullDirectory, projectName);


            progress.Report("create", "Creating the project " + Text.Quote(projectName) + " in " + fullDirectory);
            JsonObject data = _host.CreateProjectAt(fullDirectory, projectName, author, comment, withWindow, progress);
            data.Add("dryRun", false);
            changes.Add("project", JsonObject.ReadString(data, "projectPath", targetPath), "created", projectName);
            log.Info("Created the project " + Text.Quote(projectName) + ".");
            return data;
        }

        // --------------------------------------------------------- SaveProject

        private JsonObject SaveProject(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string saveAsDir = p.String("save_as_dir", null);
            bool saveAs = !string.IsNullOrWhiteSpace(saveAsDir);
            string requestedSaveAsDir = saveAs ? Path.GetFullPath(saveAsDir.Trim().Trim('"')) : null;

            JsonObject session = _host.DescribeSession();
            if (!JsonObject.ReadBool(session, "projectOpen", false))
            {
                throw new ControllerException("project_not_open",
                    "SaveProject requires an open project. Call OpenProject first.");
            }


            bool wasModified = JsonObject.ReadBool(session, "isModified", false);
            string before = JsonObject.ReadString(session, "projectPath", null);
            if (saveAs)
            {
                progress.Report("save", "Saving the project as " + requestedSaveAsDir);
                _host.SaveProjectAs(requestedSaveAsDir);
            }
            else
            {
                progress.Report("save", "Saving the project.");
                _host.SaveProject();
            }

            JsonObject data = new JsonObject();
            data.Add("projectName", _host.Project.Name);
            string after = Convert.ToString(_host.Project.Path);
            data.Add("projectPath", after);
            data.Add("saved", true);
            if (saveAs)
            {
                // TIA decides the folder/file layout under the directory that was
                // passed (SaveAs takes only a DirectoryInfo), and Openness cannot
                // rename a project: Project.Name is read-only and there is no
                // SaveAs(targetFolder, newName) overload. Reporting the requested
                // directory next to the path TIA actually produced is therefore
                // the only way for a caller to see that the two may differ.
                data.Add("requestedSaveAsDir", requestedSaveAsDir);
                data.Add("savedAs", after);
                data.Add("locationChanged", !string.Equals(before, after, StringComparison.OrdinalIgnoreCase));
            }
            data.Add("isModifiedBeforeSave", wasModified);
            data.Add("isModified", _host.Project.IsModified);
            data.Add("dryRun", false);
            changes.Add("project", JsonObject.ReadString(data, "projectPath", before), saveAs ? "saved_as" : "saved",
                saveAs ? "new location " + after + " (requested directory " + requestedSaveAsDir + ")" : "changes persisted");
            log.Info("Saved the project " + Text.Quote(_host.Project.Name) + ".");
            return data;
        }

        // ------------------------------------------------------ ArchiveProject

        private JsonObject ArchiveProject(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string action = p.Enum("action", ArchiveActionNames, "archive");
            if (string.Equals(action, "retrieve", StringComparison.Ordinal))
            {
                return RetrieveProject(p, log, changes, progress);
            }

            string targetDir = p.RequiredString("target_dir");
            string targetName = p.RequiredString("target_name");
            string mode = p.Enum("mode", ArchivationModeNames, "compressed");

            string fullDirectory = Path.GetFullPath(targetDir.Trim().Trim('"'));
            string archivedPath = Path.Combine(fullDirectory, targetName);


            progress.Report("archive", "Archiving the project to " + archivedPath + " (" + mode + ").");
            JsonObject data = _host.ArchiveProjectTo(fullDirectory, targetName, mode);
            data.Add("action", "archive");
            data.Add("dryRun", false);
            changes.Add("archive", archivedPath, "written", mode);
            log.Info("Archived the project to " + Text.Quote(archivedPath) + ".");
            return data;
        }

        private JsonObject RetrieveProject(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string archivePath = p.RequiredString("archive_path");
            string targetDir = p.RequiredString("target_dir");
            bool upgrade = p.Bool("upgrade", false);
            string openMode = p.Enum("project_open_mode", ProjectOpenModeNames, "primary");
            bool withWindow = p.Bool("with_window", false);

            string fullArchive = Path.GetFullPath(archivePath.Trim().Trim('"'));
            string fullDirectory = Path.GetFullPath(targetDir.Trim().Trim('"'));


            progress.Report("retrieve", "Retrieving " + fullArchive + " into " + fullDirectory + ".");
            JsonObject data = _host.RetrieveProjectFrom(fullArchive, fullDirectory, upgrade, openMode, withWindow, progress);
            data.Add("action", "retrieve");
            data.Add("dryRun", false);
            changes.Add("project", JsonObject.ReadString(data, "projectPath", fullDirectory), "retrieved", fullArchive);
            log.Info("Retrieved and opened the project " + Text.Quote(JsonObject.ReadString(data, "projectName", "?")) + ".");
            return data;
        }

        // ---------------------------------------------------------- ProjectInfo

        private JsonObject ProjectInfo(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            List<string> sections = p.EnumList("sections", ProjectInfoSectionNames);
            if (sections.Count == 0)
            {
                sections.AddRange(new[] { "attributes", "comment", "languages", "products", "software" });
            }
            int historyLimit = p.Int("history_limit", 50);
            if (historyLimit <= 0) historyLimit = 50;
            int maxObjects = p.Int("max_objects", 200);
            if (maxObjects <= 0) maxObjects = 200;
            bool includeAttributeInfos = p.Bool("include_attribute_infos", false);

            JsonObject data = new JsonObject();
            foreach (string section in sections)
            {
                switch (section)
                {
                    case "attributes":
                        data.Add("attributes", _host.DescribeProjectAttributes(includeAttributeInfos));
                        break;
                    case "comment":
                        data.Add("comment", _host.DescribeProjectComment());
                        break;
                    case "languages":
                        data.Add("languages", _host.DescribeLanguageSettings());
                        break;
                    case "history":
                        data.Add("history", _host.DescribeProjectHistory(historyLimit));
                        break;
                    case "products":
                        data.Add("products", _host.DescribeUsedProducts());
                        break;
                    case "devices":
                        data.Add("devices", _host.DescribeDevicesExtended(includeAttributeInfos, maxObjects));
                        break;
                    case "software":
                        data.Add("software", _host.DescribePlcSoftwarePublic());
                        break;
                    case "settings":
                        data.Add("settings", _host.DescribePortalSettings());
                        break;
                }
            }

            data.Add("sections", sections);
            data.Add("historyLimit", historyLimit);
            data.Add("maxObjects", maxObjects);
            log.Info("Reported the project sections " + string.Join(", ", sections.ToArray()) + ".");
            return data;
        }

        // ------------------------------------------------------ ProjectLanguages

        private JsonObject ProjectLanguages(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string action = p.Enum("action", LanguageActionNames, "list");

            if (string.Equals(action, "list", StringComparison.Ordinal))
            {
                JsonObject listed = _host.DescribeLanguageSettings();
                listed.Add("action", "list");
                listed.Add("dryRun", false);
                return listed;
            }

            List<string> activeLanguages = p.StringList("active_languages");
            string activeMode = p.Enum("active_mode", LanguageActiveModeNames, "add");
            string editingLanguage = p.String("editing_language", null);
            string referenceLanguage = p.String("reference_language", null);

            if (activeLanguages.Count == 0
                && string.IsNullOrWhiteSpace(editingLanguage)
                && string.IsNullOrWhiteSpace(referenceLanguage))
            {
                throw new ControllerException("invalid_params",
                    "action=set needs at least one of 'active_languages', 'editing_language' or 'reference_language'.");
            }


            progress.Report("languages", "Updating the project languages.");
            JsonObject data = _host.SetProjectLanguages(activeLanguages, activeMode, editingLanguage, referenceLanguage);
            data.Add("action", "set");
            data.Add("dryRun", false);
            foreach (string added in ReadStringList(data, "added")) changes.Add("language", added, "activated");
            foreach (string removed in ReadStringList(data, "removed")) changes.Add("language", removed, "deactivated");
            log.Info("Updated the project languages (added " + ReadStringList(data, "added").Count
                + ", removed " + ReadStringList(data, "removed").Count + ").");
            return data;
        }

        // --------------------------------------------------------- ProjectTexts

        private JsonObject ProjectTexts(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string action = p.RequiredEnum("action", ProjectTextActionNames);
            string file = p.RequiredString("file");
            bool export = string.Equals(action, "export", StringComparison.Ordinal);

            if (!export)
            {
                bool updateSourceLanguage = p.Bool("update_source_language", false);

                progress.Report("texts", "Importing the project texts from " + file + ".");
                // Deliberately NOT wrapped in a transaction: the manual's
                // "Transaction handling → Restrictions" lists "ProjectText Import"
                // (and Export) among the actions that are not allowed inside a
                // transaction and raise a recoverable exception. The whole
                // project-text import is one TIA-side operation with its own
                // consistency handling, and data.state reports how it went.
                JsonObject imported = _host.ImportProjectTexts(file, updateSourceLanguage);
                imported.Add("action", "import");
                imported.Add("dryRun", false);
                changes.Add("texts", JsonObject.ReadString(imported, "file", file), "imported",
                    JsonObject.ReadString(imported, "state", "?"));
                log.Info("Imported the project texts.");
                return imported;
            }

            string sourceLanguage = p.RequiredString("source_language");
            string targetLanguage = p.RequiredString("target_language");


            progress.Report("texts", "Exporting the project texts to " + file + ".");
            JsonObject data = _host.ExportProjectTexts(file, sourceLanguage, targetLanguage);
            data.Add("action", "export");
            data.Add("dryRun", false);
            changes.Add("texts", JsonObject.ReadString(data, "file", file), "written",
                JsonObject.ReadString(data, "sourceLanguage", "?") + " -> " + JsonObject.ReadString(data, "targetLanguage", "?"));
            log.Info("Exported the project texts to " + Text.Quote(JsonObject.ReadString(data, "file", file)) + ".");
            return data;
        }

        // -------------------------------------------------------- UpdateProject

        private JsonObject UpdateProject(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            bool hasSimulation = p.Has("simulation_during_block_compilation");
            string commentLanguage = p.String("comment_language", null);
            string commentText = p.String("comment_text", null);

            if (!hasSimulation && string.IsNullOrWhiteSpace(commentLanguage))
            {
                throw new ControllerException("invalid_params",
                    "update_project needs at least one of 'simulation_during_block_compilation' or "
                        + "'comment_language' with 'comment_text'.");
            }
            if (!string.IsNullOrWhiteSpace(commentLanguage) && commentText == null)
            {
                throw new ControllerException("invalid_params",
                    "'comment_text' is required when 'comment_language' is given.");
            }
            if (string.IsNullOrWhiteSpace(commentLanguage) && commentText != null)
            {
                throw new ControllerException("invalid_params",
                    "'comment_language' is required when 'comment_text' is given.");
            }

            bool simulationValue = hasSimulation && p.Bool("simulation_during_block_compilation", false);


            progress.Report("update", "Updating the project.");
            JsonObject data = new JsonObject();
            bool changedSomething = false;
            using (TransactionScope scope = _host.BeginTransaction("Update project properties"))
            {
                if (hasSimulation)
                {
                    bool before = _host.ReadSimulationSupport();
                    if (before != simulationValue) _host.SetSimulationSupport(simulationValue);
                    data.Add("simulationDuringBlockCompilation", JsonObject.Of(
                        "before", before, "after", simulationValue, "changed", before != simulationValue));
                    if (before != simulationValue)
                    {
                        changedSomething = true;
                        changes.Add("project", "IsSimulationDuringBlockCompilationEnabled",
                            before ? "disabled" : "enabled");
                    }
                }

                if (!string.IsNullOrWhiteSpace(commentLanguage))
                {
                    JsonObject comment = _host.SetProjectComment(commentLanguage, commentText);
                    data.Add("comment", comment);
                    if (JsonObject.ReadBool(comment, "changed", false))
                    {
                        changedSomething = true;
                        changes.Add("project", "Comment/" + commentLanguage, "written");
                    }
                }

                if (changedSomething) scope.Commit();
            }
            data.Add("changed", changedSomething);
            data.Add("dryRun", false);
            log.Info(changedSomething ? "Updated the project." : "The project already had the requested values.");
            return data;
        }

        // -------------------------------------------------------- PortalSettings

        private JsonObject PortalSettings(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string action = p.Enum("action", PortalSettingActionNames, "list");
            bool withWindow = p.Bool("with_window", false);

            _host.EnsurePortalStarted(withWindow, progress);

            if (string.Equals(action, "list", StringComparison.Ordinal))
            {
                JsonObject listed = _host.DescribePortalSettings();
                listed.Add("action", "list");
                return listed;
            }

            string folder = p.String("folder", "General");
            string setting = p.RequiredString("setting");
            object value = p.Raw("value");
            if (value == null)
            {
                throw new ControllerException("invalid_params", "'value' is required when action=set.");
            }
            string valueType = p.Enum("value_type", Values.TypeNames, "auto");

            JsonObject result = _host.AccessPortalSetting(folder, setting, value, valueType, true);
            result.Add("action", "set");
            result.Add("dryRun", false);
            if (JsonObject.ReadBool(result, "changed", false))
            {
                changes.Add("setting", folder + "/" + setting, "written",
                    JsonObject.ReadString(result, "before", "?") + " -> " + JsonObject.ReadString(result, "after", "?"));
                log.Info("Changed the setting " + Text.Quote(folder + "/" + setting) + ".");
            }
            return result;
        }

        // ------------------------------------------------------------- helpers

        private static List<string> ReadStringList(JsonObject source, string key)
        {
            List<string> values = new List<string>();
            object raw = source == null ? null : source[key];
            System.Collections.IEnumerable items = raw as System.Collections.IEnumerable;
            if (items == null) return values;
            foreach (object item in items)
            {
                if (item != null) values.Add(Convert.ToString(item));
            }
            return values;
        }
    }
}
