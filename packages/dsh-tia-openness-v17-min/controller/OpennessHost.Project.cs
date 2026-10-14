using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using Siemens.Engineering;
using Siemens.Engineering.HW;
using Siemens.Engineering.Settings;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>
    /// Project-data half of the Openness session: creating, saving, archiving and
    /// retrieving projects, the project attributes / languages / history /
    /// multilingual texts, and the TIA Portal settings folders.
    ///
    /// Everything here is reachable from the manual chapter "Functions for
    /// projects and project data"; see <c>docs/EXTENDED-SURFACE.md</c> for the
    /// operation contract.
    /// </summary>
    internal sealed partial class OpennessHost
    {
        // ------------------------------------------------------------- portal

        /// <summary>
        /// Starts (or attaches to) the TIA Portal instance without requiring an
        /// open project. Needed by the TIA Portal settings folders, which the
        /// manual exposes on the TIA Portal instance itself.
        /// </summary>
        public void EnsurePortalStarted(bool withWindow, IProgressSink progress)
        {
            EnsurePortal(withWindow, progress);
        }

        public void EnsureNoProject(string operation)
        {
            if (_project == null) return;
            throw new ControllerException(
                "project_already_open",
                operation + " cannot run while a project is open (" + Text.Quote(SafeProjectName())
                    + "). Close it first with CloseProject.",
                JsonObject.Of("openProject", SafeProjectPath()));
        }

        /// <summary>
        /// The PLC software summary as the operations report it in their payloads
        /// (<c>DescribePlcSoftware</c> itself stays private to the host).
        /// </summary>
        public JsonObject DescribePlcSoftwarePublic()
        {
            EnsureProjectOpen("DescribePlcSoftware");
            return DescribePlcSoftware();
        }

        // ------------------------------------------------------------ creating

        /// <summary>
        /// Creates a project through <c>ProjectComposition.Create</c>.
        ///
        /// The optional Author/Comment parameters use the generic
        /// <c>IEngineeringComposition.Create(Type, parameters)</c> overload, which
        /// is the only documented way to pass creation parameters.
        /// </summary>
        public JsonObject CreateProjectAt(string directory, string projectName, string author, string comment,
            bool withWindow, IProgressSink progress)
        {
            if (string.IsNullOrWhiteSpace(projectName))
            {
                throw new ControllerException("invalid_params", "'project_name' is required.");
            }
            if (projectName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            {
                throw new ControllerException("invalid_params",
                    "'project_name' contains characters that cannot appear in a folder name: " + Text.Quote(projectName) + ".");
            }

            string fullDirectory = Path.GetFullPath(directory.Trim().Trim('"'));
            Directory.CreateDirectory(fullDirectory);

            EnsurePortal(withWindow, progress);

            string targetPath = Path.Combine(fullDirectory, projectName);
            if (Directory.Exists(targetPath) && Directory.GetFileSystemEntries(targetPath).Length > 0)
            {
                throw new ControllerException(
                    "project_create_failed",
                    "The folder " + Text.Quote(targetPath) + " already exists and is not empty; TIA Portal will not create a project there.",
                    JsonObject.Of("targetPath", targetPath));
            }

            bool withAttributes = !string.IsNullOrEmpty(author) || !string.IsNullOrEmpty(comment);
            progress.Report("create", "Creating the project " + Text.Quote(projectName) + " in " + fullDirectory);

            try
            {
                if (withAttributes)
                {
                    // The mandatory pair is (TargetDirectory, Name); Author and
                    // Comment are the documented optional creation parameters.
                    List<KeyValuePair<string, object>> parameters = new List<KeyValuePair<string, object>>();
                    parameters.Add(new KeyValuePair<string, object>("TargetDirectory", new DirectoryInfo(fullDirectory)));
                    parameters.Add(new KeyValuePair<string, object>("Name", projectName));
                    if (!string.IsNullOrEmpty(author)) parameters.Add(new KeyValuePair<string, object>("Author", author));
                    if (!string.IsNullOrEmpty(comment)) parameters.Add(new KeyValuePair<string, object>("Comment", comment));

                    object created = ((IEngineeringComposition)_portal.Projects).Create(typeof(Project), parameters);
                    _project = created as Project;
                    if (_project == null)
                    {
                        throw new ControllerException("project_create_failed",
                            "TIA Portal returned " + (created == null ? "nothing" : created.GetType().FullName)
                                + " instead of a project.");
                    }
                }
                else
                {
                    _project = _portal.Projects.Create(new DirectoryInfo(fullDirectory), projectName);
                }
            }
            catch (ControllerException)
            {
                throw;
            }
            catch (Exception ex)
            {
                _project = null;
                throw OpennessFailure("project_create_failed",
                    "Creating the project " + Text.Quote(projectName) + " in " + Text.Quote(fullDirectory)
                        + " failed: " + ex.Message, ex);
            }

            JsonObject data = new JsonObject();
            data.Add("projectName", SafeProjectName());
            data.Add("projectPath", SafeProjectPath());
            data.Add("projectDir", fullDirectory);
            data.Add("targetPath", targetPath);
            data.Add("created", true);
            data.AddIfPresent("author", author);
            data.AddIfPresent("comment", comment);
            data.Add("withUserInterface", withWindow);
            data.Add("isModified", SafeIsModified());
            data.Add("plcSoftware", DescribePlcSoftware());
            data.Add("blockSummary", DescribeBlockSummary());
            return data;
        }

        // ------------------------------------------------------------ archiving

        public JsonObject ArchiveProjectTo(string targetDir, string targetName, string modeName)
        {
            EnsureProjectOpen("ArchiveProject");

            if (SafeIsModified())
            {
                throw new ControllerException(
                    "project_not_saved",
                    "The project has unsaved changes and TIA Portal refuses to archive it. Save it first "
                        + "(save_project) and archive again.",
                    JsonObject.Of("projectName", SafeProjectName(), "projectPath", SafeProjectPath()));
            }

            if (string.IsNullOrWhiteSpace(targetName))
            {
                throw new ControllerException("invalid_params", "'target_name' is required.");
            }

            string fullDirectory = Path.GetFullPath(targetDir.Trim().Trim('"'));
            Directory.CreateDirectory(fullDirectory);

            ProjectArchivationMode mode = ParseArchivationMode(modeName);
            try
            {
                _project.Archive(new DirectoryInfo(fullDirectory), targetName, mode);
            }
            catch (Exception ex)
            {
                throw OpennessFailure("archive_failed",
                    "Archiving the project to " + Text.Quote(Path.Combine(fullDirectory, targetName)) + " failed: " + ex.Message, ex);
            }

            JsonObject data = new JsonObject();
            data.Add("projectName", SafeProjectName());
            data.Add("projectPath", SafeProjectPath());
            data.Add("targetDir", fullDirectory);
            data.Add("targetName", targetName);
            data.Add("mode", modeName);
            data.Add("archivedPath", Path.Combine(fullDirectory, targetName));
            data.Add("isModifiedBeforeArchive", false);
            return data;
        }

        public JsonObject RetrieveProjectFrom(string archivePath, string targetDir, bool upgrade, string openModeName,
            bool withWindow, IProgressSink progress)
        {
            EnsureNoProject("RetrieveProject");

            string fullArchive = Path.GetFullPath(archivePath.Trim().Trim('"'));
            if (!File.Exists(fullArchive))
            {
                throw new ControllerException("archive_not_found",
                    "No archive exists at " + Text.Quote(fullArchive) + ".", JsonObject.Of("path", fullArchive));
            }

            string fullDirectory = Path.GetFullPath(targetDir.Trim().Trim('"'));
            Directory.CreateDirectory(fullDirectory);

            EnsurePortal(withWindow, progress);
            progress.Report("retrieve", (upgrade ? "Retrieving and upgrading " : "Retrieving ") + fullArchive);

            ProjectOpenMode openMode = string.Equals(openModeName, "secondary", StringComparison.OrdinalIgnoreCase)
                ? ProjectOpenMode.Secondary
                : ProjectOpenMode.Primary;

            try
            {
                FileInfo source = new FileInfo(fullArchive);
                DirectoryInfo target = new DirectoryInfo(fullDirectory);
                // The UmacDelegate overload is documented for UMAC protected
                // projects; null is the documented value for an unprotected one.
                _project = upgrade
                    ? _portal.Projects.RetrieveWithUpgrade(source, target, null, openMode)
                    : _portal.Projects.Retrieve(source, target, null, openMode);
            }
            catch (Exception ex)
            {
                _project = null;
                throw OpennessFailure("retrieve_failed",
                    "Retrieving " + Text.Quote(fullArchive) + " into " + Text.Quote(fullDirectory) + " failed: " + ex.Message, ex);
            }

            JsonObject data = new JsonObject();
            data.Add("archivePath", fullArchive);
            data.Add("targetDir", fullDirectory);
            data.Add("upgraded", upgrade);
            data.Add("projectOpenMode", openModeName);
            data.Add("projectName", SafeProjectName());
            data.Add("projectPath", SafeProjectPath());
            data.Add("withUserInterface", withWindow);
            data.Add("isModified", SafeIsModified());
            data.Add("plcSoftware", DescribePlcSoftware());
            data.Add("blockSummary", DescribeBlockSummary());
            return data;
        }

        private static ProjectArchivationMode ParseArchivationMode(string name)
        {
            switch ((name ?? "compressed").ToLowerInvariant())
            {
                case "none": return ProjectArchivationMode.None;
                case "compressed": return ProjectArchivationMode.Compressed;
                case "discard_restorable_data": return ProjectArchivationMode.DiscardRestorableData;
                case "discard_restorable_data_and_compressed": return ProjectArchivationMode.DiscardRestorableDataAndCompressed;
                default:
                    throw new ControllerException("invalid_params",
                        "Unknown archive mode " + Text.Quote(name) + ".");
            }
        }

        // --------------------------------------------------------- project data

        /// <summary>Project attributes, plus the attribute list when asked for.</summary>
        public JsonObject DescribeProjectAttributes(bool includeAttributeInfos)
        {
            EnsureProjectOpen("ProjectInfo");

            JsonObject attributes = new JsonObject();
            attributes.Add("name", SafeProjectName());
            attributes.Add("path", SafeProjectPath());
            attributes.AddIfPresent("author", SafeString(delegate { return _project.Author; }));
            attributes.AddIfPresent("copyright", SafeString(delegate { return _project.Copyright; }));
            attributes.AddIfPresent("family", SafeString(delegate { return _project.Family; }));
            attributes.AddIfPresent("version", SafeString(delegate { return _project.Version; }));
            attributes.Add("sizeKB", SafeLong(delegate { return _project.Size; }));
            attributes.Add("isModified", SafeIsModified());
            attributes.AddIfPresent("creationTime", SafeDate(delegate { return _project.CreationTime; }));
            attributes.AddIfPresent("lastModified", SafeDate(delegate { return _project.LastModified; }));
            attributes.AddIfPresent("lastModifiedBy", SafeString(delegate { return _project.LastModifiedBy; }));
            attributes.Add("isSimulationDuringBlockCompilationEnabled",
                SafeBool(delegate { return _project.IsSimulationDuringBlockCompilationEnabled; }));
            if (includeAttributeInfos)
            {
                attributes.Add("attributeInfos", AttributeInfosOf(_project));
            }
            return attributes;
        }

        /// <summary>The project comment, one entry per language that carries text.</summary>
        public JsonObject DescribeProjectComment()
        {
            EnsureProjectOpen("ProjectInfo");

            JsonObject result = new JsonObject();
            List<JsonObject> items = new List<JsonObject>();
            try
            {
                MultilingualText comment = _project.Comment;
                if (comment != null)
                {
                    foreach (MultilingualTextItem item in comment.Items)
                    {
                        if (item == null) continue;
                        JsonObject entry = new JsonObject();
                        entry.AddIfPresent("culture", CultureOf(item));
                        entry.AddIfPresent("text", item.Text);
                        items.Add(entry);
                    }
                }
            }
            catch (Exception ex)
            {
                result.Add("reason", "The project comment could not be read: " + ex.Message);
            }
            result.Add("count", items.Count);
            result.Add("languages", items);
            return result;
        }

        private static string CultureOf(MultilingualTextItem item)
        {
            try
            {
                Language language = item.Language;
                if (language == null || language.Culture == null) return null;
                return language.Culture.Name;
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>Supported, active, editing and reference project languages.</summary>
        public JsonObject DescribeLanguageSettings()
        {
            EnsureProjectOpen("ProjectLanguages");

            LanguageSettings settings = _project.LanguageSettings;
            JsonObject result = new JsonObject();

            List<JsonObject> supported = new List<JsonObject>();
            if (settings != null)
            {
                foreach (Language language in settings.Languages)
                {
                    supported.Add(DescribeLanguage(language));
                }
            }
            result.Add("supportedCount", supported.Count);
            result.Add("supportedLanguages", supported);

            List<JsonObject> active = new List<JsonObject>();
            if (settings != null)
            {
                foreach (Language language in settings.ActiveLanguages)
                {
                    active.Add(DescribeLanguage(language));
                }
            }
            result.Add("activeCount", active.Count);
            result.Add("activeLanguages", active);
            result.AddIfPresent("editingLanguage", CultureName(SafeLanguage(delegate { return settings.EditingLanguage; })));
            result.AddIfPresent("referenceLanguage", CultureName(SafeLanguage(delegate { return settings.ReferenceLanguage; })));
            return result;
        }

        private static JsonObject DescribeLanguage(Language language)
        {
            JsonObject entry = new JsonObject();
            CultureInfo culture = null;
            try
            {
                culture = language.Culture;
            }
            catch (Exception)
            {
                // A language whose culture cannot be read is still worth listing.
            }
            entry.AddIfPresent("culture", culture == null ? null : culture.Name);
            entry.AddIfPresent("name", culture == null ? null : culture.Name);
            entry.AddIfPresent("displayName", culture == null ? null : culture.DisplayName);
            return entry;
        }

        private static string CultureName(Language language)
        {
            if (language == null) return null;
            try
            {
                return language.Culture == null ? null : language.Culture.Name;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private Language SafeLanguage(Func<Language> read)
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

        /// <summary>
        /// Adds or removes active project languages and sets the editing and
        /// reference language, mirroring the manual's "Accessing languages".
        /// </summary>
        public JsonObject SetProjectLanguages(IList<string> activeLanguages, string activeMode,
            string editingLanguage, string referenceLanguage)
        {
            EnsureProjectOpen("ProjectLanguages");

            LanguageSettings settings = _project.LanguageSettings;
            if (settings == null)
            {
                throw new ControllerException("language_change_failed",
                    "The project exposes no LanguageSettings, so its languages cannot be changed.");
            }

            JsonObject data = new JsonObject();
            List<string> added = new List<string>();
            List<string> removed = new List<string>();

            foreach (string name in activeLanguages)
            {
                Language language = FindLanguage(settings, name);
                bool remove = string.Equals(activeMode, "remove", StringComparison.OrdinalIgnoreCase);
                try
                {
                    if (remove)
                    {
                        if (settings.ActiveLanguages.Remove(language)) removed.Add(CultureName(language));
                    }
                    else
                    {
                        if (!settings.ActiveLanguages.Contains(language))
                        {
                            settings.ActiveLanguages.Add(language);
                            added.Add(CultureName(language));
                        }
                    }
                }
                catch (Exception ex)
                {
                    throw OpennessFailure("language_change_failed",
                        (remove ? "Deactivating " : "Activating ") + Text.Quote(name) + " failed: " + ex.Message, ex);
                }
            }

            if (!string.IsNullOrWhiteSpace(editingLanguage))
            {
                try
                {
                    settings.EditingLanguage = FindLanguage(settings, editingLanguage);
                }
                catch (ControllerException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    throw OpennessFailure("language_change_failed",
                        "Setting the editing language to " + Text.Quote(editingLanguage) + " failed: " + ex.Message, ex);
                }
            }

            if (!string.IsNullOrWhiteSpace(referenceLanguage))
            {
                try
                {
                    settings.ReferenceLanguage = FindLanguage(settings, referenceLanguage);
                }
                catch (ControllerException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    throw OpennessFailure("language_change_failed",
                        "Setting the reference language to " + Text.Quote(referenceLanguage) + " failed: " + ex.Message, ex);
                }
            }

            data.Add("added", added);
            data.Add("removed", removed);
            data.Add("supportedCount", CountLanguages(settings.Languages));
            data.Add("activeLanguages", ActiveLanguageCultures(settings));
            data.AddIfPresent("editingLanguage", CultureName(settings.EditingLanguage));
            data.AddIfPresent("referenceLanguage", CultureName(settings.ReferenceLanguage));
            return data;
        }

        private static int CountLanguages(LanguageComposition languages)
        {
            int count = 0;
            foreach (Language unused in languages) count++;
            return count;
        }

        private static List<string> ActiveLanguageCultures(LanguageSettings settings)
        {
            List<string> names = new List<string>();
            foreach (Language language in settings.ActiveLanguages)
            {
                names.Add(CultureName(language));
            }
            return names;
        }

        /// <summary>
        /// Resolves culture names for a language change without changing
        /// anything; used by the dry run so an unsupported language is reported
        /// before the project is touched.
        /// </summary>
        public List<string> ResolveLanguageNames(IList<string> cultureNames)
        {
            EnsureProjectOpen("ProjectLanguages");
            LanguageSettings settings = _project.LanguageSettings;
            if (settings == null)
            {
                throw new ControllerException("language_change_failed",
                    "The project exposes no LanguageSettings, so its languages cannot be resolved.");
            }
            List<string> resolved = new List<string>();
            foreach (string name in cultureNames)
            {
                resolved.Add(CultureName(FindLanguage(settings, name)));
            }
            return resolved;
        }

        public string ResolveLanguageName(string cultureName)
        {
            EnsureProjectOpen("ProjectLanguages");
            LanguageSettings settings = _project.LanguageSettings;
            if (settings == null)
            {
                throw new ControllerException("language_change_failed",
                    "The project exposes no LanguageSettings, so its languages cannot be resolved.");
            }
            return CultureName(FindLanguage(settings, cultureName));
        }

        /// <summary>Resolves a culture name against the project's supported languages.</summary>
        private Language FindLanguage(LanguageSettings settings, string cultureName)        {
            CultureInfo culture;
            try
            {
                culture = CultureInfo.GetCultureInfo(cultureName);
            }
            catch (Exception ex)
            {
                throw new ControllerException("invalid_params",
                    "'" + cultureName + "' is not a known culture name: " + ex.Message);
            }

            Language language = null;
            try
            {
                language = settings.Languages.Find(culture);
            }
            catch (Exception ex)
            {
                throw OpennessFailure("language_change_failed",
                    "Searching for the language " + Text.Quote(cultureName) + " failed: " + ex.Message, ex);
            }

            if (language == null)
            {
                List<string> available = new List<string>();
                foreach (Language candidate in settings.Languages) available.Add(CultureName(candidate));
                throw new ControllerException("language_not_found",
                    "The project does not support the language " + Text.Quote(cultureName) + ".",
                    JsonObject.Of("requested", cultureName, "available", available));
            }
            return language;
        }

        /// <summary>The project history, newest last, capped by the caller.</summary>
        public JsonObject DescribeProjectHistory(int limit)
        {
            EnsureProjectOpen("ProjectInfo");

            int total = 0;
            List<JsonObject> entries = new List<JsonObject>();
            try
            {
                // The manual documents the composition as the source of the
                // project history; the cap keeps a long-lived project readable.
                List<HistoryEntry> all = new List<HistoryEntry>();
                foreach (HistoryEntry entry in _project.HistoryEntries)
                {
                    all.Add(entry);
                }
                total = all.Count;
                int start = limit > 0 && all.Count > limit ? all.Count - limit : 0;
                for (int i = start; i < all.Count; i++)
                {
                    JsonObject item = new JsonObject();
                    item.AddIfPresent("text", SafeString(delegate { return all[i].Text; }));
                    item.AddIfPresent("dateTime", SafeDate(delegate { return all[i].DateTime; }));
                    entries.Add(item);
                }
            }
            catch (Exception ex)
            {
                JsonObject failed = new JsonObject();
                failed.Add("count", 0);
                failed.Add("entries", entries);
                failed.Add("truncated", false);
                failed.Add("reason", "The project history could not be read: " + ex.Message);
                return failed;
            }

            JsonObject result = new JsonObject();
            result.Add("count", total);
            result.Add("entries", entries);
            result.Add("truncated", total > entries.Count);
            return result;
        }

        public JsonObject DescribeUsedProducts()
        {
            EnsureProjectOpen("ProjectInfo");

            List<JsonObject> items = new List<JsonObject>();
            foreach (UsedProduct product in _project.UsedProducts)
            {
                JsonObject item = new JsonObject();
                item.AddIfPresent("name", SafeString(delegate { return product.Name; }));
                item.AddIfPresent("version", SafeString(delegate { return product.Version; }));
                items.Add(item);
            }
            JsonObject result = new JsonObject();
            result.Add("count", items.Count);
            result.Add("items", items);
            return result;
        }

        public void SetSimulationSupport(bool value)
        {
            EnsureProjectOpen("UpdateProject");
            try
            {
                _project.IsSimulationDuringBlockCompilationEnabled = value;
            }
            catch (Exception ex)
            {
                throw OpennessFailure("project_update_failed",
                    "Setting 'simulation during block compilation' failed: " + ex.Message, ex);
            }
        }

        public bool ReadSimulationSupport()
        {
            return SafeBool(delegate { return _project.IsSimulationDuringBlockCompilationEnabled; });
        }

        /// <summary>Writes one language's text into the project comment.</summary>
        public JsonObject SetProjectComment(string cultureName, string text)
        {
            EnsureProjectOpen("UpdateProject");

            LanguageSettings settings = _project.LanguageSettings;
            if (settings == null)
            {
                throw new ControllerException("project_update_failed", "The project exposes no LanguageSettings.");
            }

            Language language = FindLanguage(settings, cultureName);
            MultilingualText comment = _project.Comment;
            if (comment == null)
            {
                throw new ControllerException("project_update_failed", "The project exposes no comment object.");
            }

            MultilingualTextItem item = null;
            try
            {
                item = comment.Items.Find(language);
            }
            catch (Exception ex)
            {
                throw OpennessFailure("project_update_failed",
                    "Looking up the comment text for " + Text.Quote(cultureName) + " failed: " + ex.Message, ex);
            }

            JsonObject result = new JsonObject();
            result.Add("language", cultureName);

            if (item == null)
            {
                // A language that carries no comment item yet cannot be created
                // through this API; the caller has to activate the language first.
                result.Add("before", null);
                result.Add("after", null);
                result.Add("changed", false);
                result.Add("reason", "The project comment has no item for " + Text.Quote(cultureName)
                    + ". Activate the language with project_languages first.");
                return result;
            }

            string before = SafeString(delegate { return item.Text; });
            result.Add("before", before);
            if (string.Equals(before, text, StringComparison.Ordinal))
            {
                result.Add("after", before);
                result.Add("changed", false);
                return result;
            }

            try
            {
                item.Text = text;
            }
            catch (Exception ex)
            {
                throw OpennessFailure("project_update_failed",
                    "Writing the project comment for " + Text.Quote(cultureName) + " failed: " + ex.Message, ex);
            }
            result.Add("after", text);
            result.Add("changed", true);
            return result;
        }

        /// <summary>
        /// Writes one text into a multilingual text (a tag comment, a unit
        /// comment, a project comment) using the project's editing language.
        ///
        /// The item for a language cannot be created through Openness: a language
        /// that carries no item yet is reported instead of silently dropped.
        /// </summary>
        public JsonObject WriteMultilingualText(MultilingualText text, string value)
        {
            JsonObject result = new JsonObject();
            if (text == null)
            {
                result.Add("changed", false);
                result.Add("reason", "The object exposes no multilingual text to write.");
                return result;
            }

            Language language = null;
            LanguageSettings settings = _project == null ? null : _project.LanguageSettings;
            if (settings != null)
            {
                language = SafeLanguage(delegate { return settings.EditingLanguage; });
                if (language == null) language = SafeLanguage(delegate { return settings.ReferenceLanguage; });
            }

            MultilingualTextItem item = null;
            try
            {
                if (language != null) item = text.Items.Find(language);
                if (item == null)
                {
                    // Fall back to the first item: a comment without the editing
                    // language's item is still better written than lost.
                    foreach (MultilingualTextItem candidate in text.Items)
                    {
                        if (candidate == null) continue;
                        item = candidate;
                        break;
                    }
                }
            }
            catch (Exception ex)
            {
                result.Add("changed", false);
                result.Add("reason", "Looking up the multilingual text item failed: " + ex.Message);
                return result;
            }

            if (item == null)
            {
                result.Add("changed", false);
                result.Add("reason", "The multilingual text has no item for the editing language "
                    + Text.Quote(CultureName(language)) + " and no other item either.");
                return result;
            }

            string before = SafeString(delegate { return item.Text; });
            result.Add("before", before);
            if (string.Equals(before, value, StringComparison.Ordinal))
            {
                result.Add("after", before);
                result.Add("changed", false);
                return result;
            }

            try
            {
                item.Text = value;
            }
            catch (Exception ex)
            {
                throw OpennessFailure("attribute_write_failed",
                    "Writing the multilingual text failed: " + ex.Message, ex);
            }
            result.Add("after", value);
            result.Add("changed", true);
            return result;
        }

        // ------------------------------------------------------- project texts
        public JsonObject ExportProjectTexts(string file, string sourceLanguage, string targetLanguage)
        {
            EnsureProjectOpen("ProjectTexts");

            CultureInfo source = ParseCulture(sourceLanguage, "source_language");
            CultureInfo target = ParseCulture(targetLanguage, "target_language");

            string full = Path.GetFullPath(file.Trim().Trim('"'));
            string directory = Path.GetDirectoryName(full);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

            try
            {
                _project.ExportProjectTexts(new FileInfo(full), source, target);
            }
            catch (Exception ex)
            {
                throw OpennessFailure("project_text_export_failed",
                    "Exporting the project texts to " + Text.Quote(full) + " failed: " + ex.Message, ex);
            }

            JsonObject data = new JsonObject();
            data.Add("file", full);
            data.Add("sourceLanguage", source.Name);
            data.Add("targetLanguage", target.Name);
            if (File.Exists(full))
            {
                data.Add("bytes", new FileInfo(full).Length);
                data.Add("sha256", Hashing.Sha256OfFile(full));
            }
            return data;
        }

        public JsonObject ImportProjectTexts(string file, bool updateSourceLanguage)
        {
            EnsureProjectOpen("ProjectTexts");

            string full = Path.GetFullPath(file.Trim().Trim('"'));
            if (!File.Exists(full))
            {
                throw new ControllerException("invalid_params",
                    "No project text file exists at " + Text.Quote(full) + ".", JsonObject.Of("path", full));
            }

            ProjectTextResult result;
            try
            {
                result = _project.ImportProjectTexts(new FileInfo(full), updateSourceLanguage);
            }
            catch (Exception ex)
            {
                throw OpennessFailure("project_text_import_failed",
                    "Importing the project texts from " + Text.Quote(full) + " failed: " + ex.Message, ex);
            }

            JsonObject data = new JsonObject();
            data.Add("file", full);
            data.Add("updateSourceLanguage", updateSourceLanguage);
            data.AddIfPresent("state", result == null ? null : Convert.ToString(result.State));
            data.AddIfPresent("resultPath", result == null || result.Path == null ? null : result.Path.FullName);
            return data;
        }

        private static CultureInfo ParseCulture(string name, string parameterName)
        {
            if (string.IsNullOrWhiteSpace(name))
            {
                throw new ControllerException("invalid_params", "'" + parameterName + "' is required.");
            }
            try
            {
                return CultureInfo.GetCultureInfo(name);
            }
            catch (Exception ex)
            {
                throw new ControllerException("invalid_params",
                    "'" + parameterName + "' is not a known culture name: " + Text.Quote(name) + " (" + ex.Message + ").");
            }
        }

        // ----------------------------------------------------- portal settings

        /// <summary>Every TIA Portal settings folder with its settings.</summary>
        public JsonObject DescribePortalSettings()
        {
            if (_portal == null)
            {
                throw new ControllerException("openness_unavailable",
                    "The TIA Portal settings folders cannot be read before an instance exists. Call open_project (or "
                        + "portal_settings with action=set) first; the controller starts the instance on demand.");
            }

            List<JsonObject> folders = new List<JsonObject>();
            try
            {
                foreach (TiaPortalSettingsFolder folder in _portal.SettingsFolders)
                {
                    folders.Add(DescribeSettingsFolder(folder, 0));
                }
            }
            catch (Exception ex)
            {
                throw OpennessFailure("setting_not_found",
                    "The TIA Portal settings folders could not be enumerated: " + ex.Message, ex);
            }

            JsonObject result = new JsonObject();
            result.Add("folderCount", folders.Count);
            result.Add("folders", folders);
            return result;
        }

        private JsonObject DescribeSettingsFolder(TiaPortalSettingsFolder folder, int depth)
        {
            JsonObject entry = new JsonObject();
            entry.AddIfPresent("name", SafeString(delegate { return folder.Name; }));

            List<JsonObject> settings = new List<JsonObject>();
            try
            {
                foreach (TiaPortalSetting setting in folder.Settings)
                {
                    if (setting == null) continue;
                    JsonObject item = new JsonObject();
                    item.AddIfPresent("name", SafeString(delegate { return setting.Name; }));
                    object value = null;
                    try
                    {
                        value = setting.Value;
                    }
                    catch (Exception ex)
                    {
                        item.Add("reason", ex.Message);
                    }
                    item.Add("valueType", value == null ? null : value.GetType().Name);
                    item.Add("value", Values.Printable(value));
                    // TiaPortalSetting exposes no access mode, so writability is
                    // inferred: the manual's settings are the scalar kinds below.
                    item.Add("writeable", value is bool || value is string || value is int || value is long
                        || value is CultureInfo);
                    settings.Add(item);
                }
            }
            catch (Exception ex)
            {
                entry.Add("reason", "The settings of this folder could not be read: " + ex.Message);
            }
            entry.Add("settings", settings);

            // Folders nest; the recursion is bounded to keep a degenerate tree
            // from flooding the payload.
            List<JsonObject> children = new List<JsonObject>();
            if (depth < 3)
            {
                try
                {
                    foreach (TiaPortalSettingsFolder child in folder.Folders)
                    {
                        children.Add(DescribeSettingsFolder(child, depth + 1));
                    }
                }
                catch (Exception)
                {
                    // A folder without readable sub-folders is not an error.
                }
            }
            if (children.Count > 0) entry.Add("folders", children);
            return entry;
        }

        /// <summary>
        /// Reads one setting of one TIA Portal settings folder, and writes it when
        /// <paramref name="apply"/> is set. The dry run of <c>PortalSettings</c>
        /// goes through the same read path, so a dry run reports exactly what a
        /// real write would do.
        /// </summary>
        public JsonObject AccessPortalSetting(string folderName, string settingName, object value, string valueType,
            bool apply)
        {
            if (_portal == null)
            {
                throw new ControllerException("openness_unavailable",
                    "The TIA Portal settings folders cannot be used before an instance exists. Open a project first.");
            }

            TiaPortalSettingsFolder folder = null;
            try
            {
                folder = _portal.SettingsFolders.Find(folderName);
            }
            catch (Exception ex)
            {
                throw OpennessFailure("setting_not_found",
                    "Searching for the settings folder " + Text.Quote(folderName) + " failed: " + ex.Message, ex);
            }

            if (folder == null)
            {
                List<string> available = new List<string>();
                foreach (TiaPortalSettingsFolder candidate in _portal.SettingsFolders)
                {
                    available.Add(SafeString(delegate { return candidate.Name; }));
                }
                throw new ControllerException("setting_not_found",
                    "There is no TIA Portal settings folder named " + Text.Quote(folderName) + ".",
                    JsonObject.Of("folder", folderName, "availableFolders", available));
            }

            TiaPortalSetting setting = null;
            try
            {
                setting = folder.Settings.Find(settingName);
            }
            catch (Exception ex)
            {
                throw OpennessFailure("setting_not_found",
                    "Searching for the setting " + Text.Quote(settingName) + " failed: " + ex.Message, ex);
            }

            if (setting == null)
            {
                List<string> available = new List<string>();
                foreach (TiaPortalSetting candidate in folder.Settings)
                {
                    available.Add(SafeString(delegate { return candidate.Name; }));
                }
                throw new ControllerException("setting_not_found",
                    "The settings folder " + Text.Quote(folderName) + " has no setting " + Text.Quote(settingName) + ".",
                    JsonObject.Of("folder", folderName, "setting", settingName, "availableSettings", available));
            }

            string effectiveType = string.IsNullOrEmpty(valueType) ? "auto" : valueType;
            object converted = Values.Convert(value, effectiveType, "value");

            JsonObject result = new JsonObject();
            result.Add("folder", folderName);
            result.Add("setting", settingName);
            result.Add("valueType", effectiveType);

            object before = null;
            try
            {
                before = setting.Value;
            }
            catch (Exception ex)
            {
                throw OpennessFailure("setting_not_found",
                    "The current value of " + Text.Quote(settingName) + " could not be read: " + ex.Message, ex);
            }
            result.Add("before", Values.Printable(before));

            if (SameValue(before, converted))
            {
                result.Add("after", Values.Printable(converted));
                result.Add("changed", false);
                return result;
            }

            if (!apply)
            {
                result.Add("after", Values.Printable(converted));
                result.Add("changed", true);
                return result;
            }

            try
            {
                setting.Value = converted;
            }
            catch (Exception ex)
            {
                throw OpennessFailure("setting_change_failed",
                    "Writing " + Text.Quote(settingName) + " failed: " + ex.Message, ex);
            }
            result.Add("after", Values.Printable(converted));
            result.Add("changed", true);
            return result;
        }

        private static bool SameValue(object left, object right)
        {
            if (left == null || right == null) return left == null && right == null;
            string leftText = Convert.ToString(Values.Printable(left), CultureInfo.InvariantCulture);
            string rightText = Convert.ToString(Values.Printable(right), CultureInfo.InvariantCulture);
            return string.Equals(leftText, rightText, StringComparison.Ordinal);
        }

        // --------------------------------------------------------- devices tree

        /// <summary>
        /// The device structure with optional attribute and composition
        /// information, which is the manual's "Determining the object structure
        /// and attributes" for the reachable part of the object tree.
        /// </summary>
        public JsonObject DescribeDevicesExtended(bool includeAttributeInfos, int maxObjects)
        {
            JsonObject result = DescribeDevices();
            if (!includeAttributeInfos) return result;

            // The flat device list from DescribeDevices() stays as it is; the
            // attribute and composition view is added per device below, because
            // GetAttributeInfos() is the only way to learn which attributes an
            // object exposes and whether they are writable.
            int visited = 0;
            List<JsonObject> detailed = new List<JsonObject>();
            foreach (Device device in _project.Devices)
            {
                if (visited++ >= maxObjects) break;
                detailed.Add(DescribeDeviceDetailed(device, null, ref visited, maxObjects));
            }
            DeviceSystemGroup ungrouped = _project.UngroupedDevicesGroup;
            if (ungrouped != null)
            {
                foreach (Device device in ungrouped.Devices)
                {
                    if (visited++ >= maxObjects) break;
                    detailed.Add(DescribeDeviceDetailed(device, ungrouped.Name, ref visited, maxObjects));
                }
            }
            result.Add("detailed", detailed);
            result.Add("maxObjects", maxObjects);
            return result;
        }

        private JsonObject DescribeDeviceDetailed(Device device, string groupPath, ref int visited, int maxObjects)
        {
            JsonObject item = DescribeDevice(device, groupPath);
            item.Add("attributeInfos", AttributeInfosOf(device));
            item.Add("compositionInfos", CompositionInfosOf(device));

            List<JsonObject> items = new List<JsonObject>();
            foreach (DeviceItem deviceItem in device.DeviceItems)
            {
                if (visited++ >= maxObjects) break;
                items.Add(DescribeDeviceItemDetailed(deviceItem, ref visited, maxObjects));
            }
            item.Add("deviceItems", items);
            return item;
        }

        private JsonObject DescribeDeviceItemDetailed(DeviceItem deviceItem, ref int visited, int maxObjects)
        {
            JsonObject item = new JsonObject();
            item.AddIfPresent("name", SafeString(delegate { return deviceItem.Name; }));
            // DeviceItem exposes no TypeIdentifier property in V17; the manual's
            // "Get type identifier" reads it as an attribute.
            item.AddIfPresent("typeIdentifier", Convert.ToString(TryReadAttribute(deviceItem, "TypeIdentifier")));
            item.Add("attributeInfos", AttributeInfosOf(deviceItem));
            item.Add("compositionInfos", CompositionInfosOf(deviceItem));

            List<JsonObject> children = new List<JsonObject>();
            foreach (DeviceItem child in deviceItem.DeviceItems)
            {
                if (visited++ >= maxObjects) break;
                children.Add(DescribeDeviceItemDetailed(child, ref visited, maxObjects));
            }
            if (children.Count > 0) item.Add("deviceItems", children);
            return item;
        }

        /// <summary>Attribute names with their access mode, via GetAttributeInfos().</summary>
        public static List<JsonObject> AttributeInfosOf(IEngineeringObject target)
        {
            List<JsonObject> infos = new List<JsonObject>();
            if (target == null) return infos;
            try
            {
                foreach (EngineeringAttributeInfo info in target.GetAttributeInfos())
                {
                    if (info == null) continue;
                    JsonObject entry = new JsonObject();
                    entry.AddIfPresent("name", info.Name);
                    entry.AddIfPresent("accessMode", Convert.ToString(info.AccessMode));
                    infos.Add(entry);
                }
            }
            catch (Exception)
            {
                // Attribute discovery is diagnostic only.
            }
            return infos;
        }

        /// <summary>Composition names, via GetCompositionInfos().</summary>
        public static List<JsonObject> CompositionInfosOf(IEngineeringObject target)
        {
            List<JsonObject> infos = new List<JsonObject>();
            if (target == null) return infos;
            try
            {
                foreach (EngineeringCompositionInfo info in target.GetCompositionInfos())
                {
                    if (info == null) continue;
                    JsonObject entry = new JsonObject();
                    entry.AddIfPresent("name", info.Name);
                    infos.Add(entry);
                }
            }
            catch (Exception)
            {
                // Composition discovery is diagnostic only.
            }
            return infos;
        }

        /// <summary>One attribute read for the generic attribute tools.</summary>
        public static object TryReadAttribute(IEngineeringObject target, string name)
        {
            try
            {
                return target.GetAttribute(name);
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// True only when the object publishes the attribute and the published
        /// access mode has no write bit.
        ///
        /// An attribute that <c>GetAttributeInfos()</c> does not list at all is
        /// deliberately reported as <em>not</em> read-only: the manual's own
        /// example (<c>SetAttribute("Priority", 14)</c>) shows that a writable
        /// attribute need not appear in the info list, so refusing it here would
        /// block a documented call. Not knowing is different from knowing it is
        /// read-only, and Openness remains the final authority.
        /// </summary>
        public static bool IsAttributeKnownReadOnly(IEngineeringObject target, string name)
        {
            try
            {
                foreach (EngineeringAttributeInfo info in target.GetAttributeInfos())
                {
                    if (info == null || !string.Equals(info.Name, name, StringComparison.Ordinal)) continue;
                    return (info.AccessMode & EngineeringAttributeAccessMode.Write) != EngineeringAttributeAccessMode.Write;
                }
            }
            catch (Exception)
            {
                // An unreadable info list proves nothing about the attribute.
            }
            return false;
        }

        // ------------------------------------------------------------- long/plc

        private static long SafeLong(Func<long> read)
        {
            try
            {
                return read();
            }
            catch (Exception)
            {
                return -1;
            }
        }
    }
}
