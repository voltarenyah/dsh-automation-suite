using System;
using System.Collections.Generic;
using System.IO;
using Siemens.Engineering;
using Siemens.Engineering.Library;
using Siemens.Engineering.Library.MasterCopies;
using Siemens.Engineering.Library.Types;
using Siemens.Engineering.SW;
using Siemens.Engineering.SW.Blocks;
using Siemens.Engineering.SW.Tags;
using Siemens.Engineering.SW.Types;
using Siemens.Engineering.SW.Units;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>One project-library type plus the user-folder path it was found under.</summary>
    internal sealed class LibraryTypeRef
    {
        public LibraryType Type;
        public string FolderPath;

        public string Name { get { return Type == null ? null : Type.Name; } }
    }

    /// <summary>One project-library master copy plus the user-folder path it was found under.</summary>
    internal sealed class LibraryMasterCopyRef
    {
        public MasterCopy MasterCopy;
        public string FolderPath;

        public string Name { get { return MasterCopy == null ? null : MasterCopy.Name; } }
    }

    /// <summary>
    /// Project-library access (the manual chapter "Functions on libraries").
    ///
    /// The V17 object model has two independent roots under
    /// <c>Project.ProjectLibrary</c>:
    ///
    ///   * <c>TypeFolder</c> - versioned library types (FB/FC/OB/UDT). A type owns
    ///     <c>Versions</c>; each version is <c>InWork</c> or <c>Committed</c>
    ///     ("Released") and can be exported to Simatic ML.
    ///   * <c>MasterCopyFolder</c> - unversioned snapshots of almost any object
    ///     (blocks, DBs, UDTs, tag tables, SW units, HMI objects, devices). They
    ///     can be created from a project object, copied, renamed and deleted, and
    ///     instantiated back into the project.
    ///
    /// What V17 Openness deliberately does NOT expose is just as important:
    /// there is no Import, CreateVersion or Release action for a library type
    /// version. The controller therefore exports type-version XML (read) and
    /// publishes edited content as a master copy; publishing a *type version*
    /// remains a TIA Portal UI action and is reported as such instead of being
    /// faked.
    /// </summary>
    internal sealed partial class OpennessHost
    {
        private const string LibraryStagingPrefix = "dsh_lib_";

        /// <summary>The project library of the open project.</summary>
        public ProjectLibrary ProjectLibrary
        {
            get
            {
                EnsureProjectOpen("ProjectLibrary");
                return _project.ProjectLibrary;
            }
        }

        // ------------------------------------------------------------- browsing

        /// <summary>Every type of the project library, with its folder path.</summary>
        public List<LibraryTypeRef> ListLibraryTypes()
        {
            List<LibraryTypeRef> refs = new List<LibraryTypeRef>();
            CollectTypes(ProjectLibrary.TypeFolder, string.Empty, true, refs);
            return refs;
        }

        /// <summary>Every master copy of the project library, with its folder path.</summary>
        public List<LibraryMasterCopyRef> ListLibraryMasterCopies()
        {
            List<LibraryMasterCopyRef> refs = new List<LibraryMasterCopyRef>();
            CollectMasterCopies(ProjectLibrary.MasterCopyFolder, string.Empty, true, refs);
            return refs;
        }

        public JsonObject DescribeLibrary(string kind, string folder, bool recursive, bool includeVersions,
            bool includeContent, bool includeDependencies, string nameFilter, int maxItems, DiagnosticLog log)
        {
            bool wantTypes = !string.Equals(kind, "master_copies", StringComparison.Ordinal);
            bool wantMasterCopies = !string.Equals(kind, "types", StringComparison.Ordinal);
            if (!wantTypes && !wantMasterCopies)
            {
                throw new ControllerException("invalid_params", "'kind' must be one of all, types, master_copies.");
            }

            ProjectLibrary library = ProjectLibrary;
            JsonObject data = new JsonObject();
            data.Add("library", "project");
            data.AddIfPresent("projectName", SafeProjectName());
            data.AddIfPresent("projectPath", SafeProjectPath());
            data.Add("capabilities", LibraryCapabilities());

            int max = maxItems <= 0 ? 500 : maxItems;
            int totalTypes = 0;
            int totalVersions = 0;
            int totalMasterCopies = 0;
            bool truncated = false;

            if (wantTypes)
            {
                LibraryTypeFolder root = library.TypeFolder;
                string folderPath = string.Empty;
                if (!string.IsNullOrWhiteSpace(folder))
                {
                    root = ResolveTypeFolder(folder, false, log);
                    if (root == null)
                    {
                        throw new ControllerException("library_folder_not_found",
                            "No type folder exists at " + Text.Quote(folder) + ".",
                            JsonObject.Of("folder", folder, "available", ListTypeFolderPaths()));
                    }
                    folderPath = NormalizeFolderPath(folder);
                }

                List<LibraryTypeRef> refs = new List<LibraryTypeRef>();
                CollectTypes(root, folderPath, recursive, refs);
                List<JsonObject> items = new List<JsonObject>();
                foreach (LibraryTypeRef reference in refs)
                {
                    if (!MatchesName(reference.Name, nameFilter)) continue;
                    totalTypes++;
                    if (items.Count >= max) { truncated = true; continue; }
                    JsonObject item = DescribeType(reference, includeVersions, includeDependencies);
                    totalVersions += JsonObject.ReadInt(item, "versionCount", 0);
                    items.Add(item);
                }

                JsonObject types = new JsonObject();
                types.Add("count", totalTypes);
                types.Add("items", items);
                types.Add("folders", ListTypeFolderPaths(root, folderPath));
                types.Add("truncated", totalTypes > items.Count);
                types.Add("maxItems", max);
                data.Add("types", types);
            }

            if (wantMasterCopies)
            {
                MasterCopyFolder root = library.MasterCopyFolder;
                string folderPath = string.Empty;
                if (!string.IsNullOrWhiteSpace(folder))
                {
                    root = ResolveMasterCopyFolder(folder, false, log);
                    if (root == null)
                    {
                        throw new ControllerException("library_folder_not_found",
                            "No master-copy folder exists at " + Text.Quote(folder) + ".",
                            JsonObject.Of("folder", folder, "available", ListMasterCopyFolderPaths()));
                    }
                    folderPath = NormalizeFolderPath(folder);
                }

                List<LibraryMasterCopyRef> refs = new List<LibraryMasterCopyRef>();
                CollectMasterCopies(root, folderPath, recursive, refs);
                List<JsonObject> items = new List<JsonObject>();
                foreach (LibraryMasterCopyRef reference in refs)
                {
                    if (!MatchesName(reference.Name, nameFilter)) continue;
                    totalMasterCopies++;
                    if (items.Count >= max) { truncated = true; continue; }
                    items.Add(DescribeMasterCopy(reference, includeContent));
                }

                JsonObject masterCopies = new JsonObject();
                masterCopies.Add("count", totalMasterCopies);
                masterCopies.Add("items", items);
                masterCopies.Add("folders", ListMasterCopyFolderPaths(root, folderPath));
                masterCopies.Add("truncated", totalMasterCopies > items.Count);
                masterCopies.Add("maxItems", max);
                data.Add("masterCopies", masterCopies);
            }

            JsonObject counts = new JsonObject();
            counts.Add("types", totalTypes);
            counts.Add("typeVersions", totalVersions);
            counts.Add("masterCopies", totalMasterCopies);
            data.Add("counts", counts);
            data.Add("truncated", truncated);
            data.Add("maxItems", max);
            log.Info("Read the project library: " + totalTypes + " type(s), " + totalVersions + " version(s), "
                + totalMasterCopies + " master copy/copies.");
            return data;
        }

        private static JsonObject LibraryCapabilities()
        {
            JsonObject capabilities = new JsonObject();
            capabilities.Add("browse", true);
            capabilities.Add("typeVersionExport", true);
            capabilities.Add("typeVersionImport", false);
            capabilities.Add("typeVersionCreate", false);
            capabilities.Add("typeVersionRelease", false);
            capabilities.Add("typeVersionSetDefault", true);
            capabilities.Add("masterCopyExport", true);
            capabilities.Add("masterCopyCreate", true);
            capabilities.Add("masterCopyCopy", true);
            capabilities.Add("masterCopyDelete", true);
            capabilities.Add("masterCopyInstantiate", true);
            capabilities.Add("updateProject", true);
            capabilities.Add("updateLibrary", false);
            capabilities.Add("note",
                "V17 Openness has no Import/CreateVersion/Release API for library type versions: export the version XML, "
                + "edit it, and publish the edited content as a master copy, or create and release the version in the "
                + "TIA Portal UI. Master copies are unversioned; a new 'version' is a new master copy with a new name.");
            return capabilities;
        }

        private JsonObject DescribeType(LibraryTypeRef reference, bool includeVersions, bool includeDependencies)
        {
            LibraryType type = reference.Type;
            JsonObject item = new JsonObject();
            item.AddIfPresent("name", SafeString(delegate { return type.Name; }));
            item.AddIfPresent("guid", SafeString(delegate { return type.Guid.ToString(); }));
            item.Add("folder", reference.FolderPath ?? string.Empty);
            item.AddIfPresent("author", SafeString(delegate { return type.Author; }));
            item.AddIfPresent("comment", CommentText(SafeComment(delegate { return type.Comment; })));
            item.AddIfPresent("status", SafeString(delegate { return type.Status.ToString(); }));

            List<JsonObject> versions = new List<JsonObject>();
            string defaultVersion = null;
            string latestVersion = null;
            Version latest = null;
            try
            {
                foreach (LibraryTypeVersion version in type.Versions)
                {
                    JsonObject described = DescribeVersion(version, includeDependencies);
                    versions.Add(described);
                    bool isDefault = JsonObject.ReadBool(described, "isDefault", false);
                    string number = JsonObject.ReadString(described, "version", null);
                    if (isDefault) defaultVersion = number;
                    Version parsed;
                    if (number != null && Version.TryParse(number, out parsed) && (latest == null || parsed > latest))
                    {
                        latest = parsed;
                        latestVersion = number;
                    }
                }
            }
            catch (Exception ex)
            {
                item.Add("versionsError", ex.Message);
            }

            item.Add("versionCount", versions.Count);
            item.AddIfPresent("defaultVersion", defaultVersion);
            item.AddIfPresent("latestVersion", latestVersion);
            if (includeVersions) item.Add("versions", versions);
            return item;
        }

        private JsonObject DescribeVersion(LibraryTypeVersion version, bool includeDependencies)
        {
            JsonObject item = new JsonObject();
            item.AddIfPresent("version", SafeVersion(version));
            item.AddIfPresent("guid", SafeString(delegate { return version.Guid.ToString(); }));
            item.AddIfPresent("state", SafeString(delegate { return version.State.ToString(); }));
            item.AddIfPresent("author", SafeString(delegate { return version.Author; }));
            item.AddIfPresent("comment", CommentText(SafeComment(delegate { return version.Comment; })));
            item.Add("isDefault", SafeBool(delegate { return version.IsDefault; }));
            object modified = SafeDate(delegate { return version.ModifiedDate; });
            item.AddIfPresent("modifiedDate", modified);
            if (includeDependencies)
            {
                item.Add("dependencies", DescribeVersionAssociation(version, true));
                item.Add("dependents", DescribeVersionAssociation(version, false));
            }
            return item;
        }

        public JsonObject DescribeVersionAssociation(LibraryTypeVersion version, bool dependencies)
        {
            JsonObject result = new JsonObject();
            List<JsonObject> items = new List<JsonObject>();
            try
            {
                IEnumerable<LibraryTypeVersion> source = dependencies ? (IEnumerable<LibraryTypeVersion>)version.Dependencies
                    : version.Dependents;
                foreach (LibraryTypeVersion other in source)
                {
                    items.Add(JsonObject.Of(
                        "version", SafeVersion(other),
                        "type", SafeString(delegate { return other.TypeObject == null ? null : other.TypeObject.Name; }),
                        "guid", SafeString(delegate { return other.Guid.ToString(); })));
                }
                result.Add("available", true);
                result.Add("count", items.Count);
                result.Add("items", items);
            }
            catch (Exception ex)
            {
                // The manual warns that an in-work version can throw here.
                result.Add("available", false);
                result.Add("count", 0);
                result.Add("reason", ex.Message);
            }
            return result;
        }

        public JsonObject DescribeMasterCopy(LibraryMasterCopyRef reference, bool includeContent)
        {
            MasterCopy masterCopy = reference.MasterCopy;
            JsonObject item = new JsonObject();
            item.AddIfPresent("name", SafeString(delegate { return masterCopy.Name; }));
            item.AddIfPresent("author", SafeString(delegate { return masterCopy.Author; }));
            object created = SafeDate(delegate { return masterCopy.CreationDate; });
            item.AddIfPresent("creationDate", created);
            item.Add("folder", reference.FolderPath ?? string.Empty);

            List<JsonObject> content = new List<JsonObject>();
            List<string> contentTypes = new List<string>();
            string primaryType = null;
            if (includeContent)
            {
                try
                {
                    foreach (MasterCopyContentDescription description in masterCopy.ContentDescriptions)
                    {
                        string shortType = SafeString(delegate { return description.ContentType == null ? null : description.ContentType.Name; });
                        string fullType = SafeString(delegate { return description.ContentType == null ? null : description.ContentType.FullName; });
                        if (shortType != null && !contentTypes.Contains(shortType)) contentTypes.Add(shortType);
                        if (primaryType == null) primaryType = shortType;
                        JsonObject entry = new JsonObject();
                        entry.AddIfPresent("name", SafeString(delegate { return description.ContentName; }));
                        entry.AddIfPresent("type", shortType);
                        entry.AddIfPresent("fullType", fullType);
                        content.Add(entry);
                    }
                }
                catch (Exception ex)
                {
                    item.Add("contentError", ex.Message);
                }
            }
            item.AddIfPresent("primaryType", primaryType);
            item.Add("contentTypes", contentTypes);
            if (includeContent) item.Add("content", content);
            return item;
        }

        // ------------------------------------------------------------ resolving

        public LibraryTypeRef FindLibraryType(string name, string guid, string folder, DiagnosticLog log)
        {
            ProjectLibrary library = ProjectLibrary;
            Guid parsed;
            if (!string.IsNullOrWhiteSpace(guid))
            {
                if (!Guid.TryParse(guid.Trim(), out parsed))
                {
                    throw new ControllerException("invalid_params", "'guid' is not a GUID: " + Text.Quote(guid) + ".");
                }
                LibraryTypeRef byGuid = FindTypeByGuid(parsed);
                if (byGuid != null) return byGuid;
                LibraryType direct = library.FindType(parsed);
                if (direct == null)
                {
                    throw new ControllerException("library_type_not_found",
                        "No library type has the GUID " + Text.Quote(guid) + ".",
                        JsonObject.Of("guid", guid));
                }
                return new LibraryTypeRef { Type = direct, FolderPath = string.Empty };
            }

            if (string.IsNullOrWhiteSpace(name))
            {
                throw new ControllerException("invalid_params", "Pass 'name' or 'guid' to identify a library type.");
            }

            LibraryTypeFolder root = library.TypeFolder;
            string folderPath = string.Empty;
            if (!string.IsNullOrWhiteSpace(folder))
            {
                root = ResolveTypeFolder(folder, false, log);
                if (root == null)
                {
                    throw new ControllerException("library_folder_not_found",
                        "No type folder exists at " + Text.Quote(folder) + ".",
                        JsonObject.Of("folder", folder, "available", ListTypeFolderPaths()));
                }
                folderPath = NormalizeFolderPath(folder);
            }

            List<LibraryTypeRef> refs = new List<LibraryTypeRef>();
            CollectTypes(root, folderPath, true, refs);
            List<LibraryTypeRef> matches = new List<LibraryTypeRef>();
            foreach (LibraryTypeRef reference in refs)
            {
                if (string.Equals(reference.Name, name.Trim(), StringComparison.OrdinalIgnoreCase)) matches.Add(reference);
            }
            if (matches.Count == 0)
            {
                List<string> available = new List<string>();
                foreach (LibraryTypeRef reference in refs) available.Add(reference.FolderPath + "/" + reference.Name);
                throw new ControllerException("library_type_not_found",
                    "No library type named " + Text.Quote(name) + " exists in the project library.",
                    JsonObject.Of("name", name, "available", available));
            }
            if (matches.Count > 1)
            {
                List<JsonObject> candidates = new List<JsonObject>();
                foreach (LibraryTypeRef reference in matches)
                {
                    candidates.Add(JsonObject.Of(
                        "name", reference.Name,
                        "folder", reference.FolderPath,
                        "guid", SafeString(delegate { return reference.Type.Guid.ToString(); })));
                }
                throw new ControllerException("library_type_ambiguous",
                    "Several library types are named " + Text.Quote(name) + "; pass 'guid' or a narrower 'folder'.",
                    JsonObject.Of("name", name, "candidates", candidates));
            }
            return matches[0];
        }

        public LibraryMasterCopyRef FindMasterCopy(string name, string folder, DiagnosticLog log)
        {
            if (string.IsNullOrWhiteSpace(name))
            {
                throw new ControllerException("invalid_params", "Pass 'name' to identify a master copy.");
            }
            MasterCopyFolder root = ProjectLibrary.MasterCopyFolder;
            string folderPath = string.Empty;
            if (!string.IsNullOrWhiteSpace(folder))
            {
                root = ResolveMasterCopyFolder(folder, false, log);
                if (root == null)
                {
                    throw new ControllerException("library_folder_not_found",
                        "No master-copy folder exists at " + Text.Quote(folder) + ".",
                        JsonObject.Of("folder", folder, "available", ListMasterCopyFolderPaths()));
                }
                folderPath = NormalizeFolderPath(folder);
            }

            List<LibraryMasterCopyRef> refs = new List<LibraryMasterCopyRef>();
            CollectMasterCopies(root, folderPath, true, refs);
            List<LibraryMasterCopyRef> matches = new List<LibraryMasterCopyRef>();
            foreach (LibraryMasterCopyRef reference in refs)
            {
                if (string.Equals(reference.Name, name.Trim(), StringComparison.OrdinalIgnoreCase)) matches.Add(reference);
            }
            if (matches.Count == 0)
            {
                List<string> available = new List<string>();
                foreach (LibraryMasterCopyRef reference in refs) available.Add(reference.FolderPath + "/" + reference.Name);
                throw new ControllerException("library_master_copy_not_found",
                    "No master copy named " + Text.Quote(name) + " exists in the project library.",
                    JsonObject.Of("name", name, "available", available));
            }
            if (matches.Count > 1)
            {
                List<JsonObject> candidates = new List<JsonObject>();
                foreach (LibraryMasterCopyRef reference in matches)
                {
                    candidates.Add(JsonObject.Of("name", reference.Name, "folder", reference.FolderPath));
                }
                throw new ControllerException("library_master_copy_ambiguous",
                    "Several master copies are named " + Text.Quote(name) + "; pass a narrower 'folder'.",
                    JsonObject.Of("name", name, "candidates", candidates));
            }
            return matches[0];
        }

        public LibraryTypeVersion ResolveLibraryVersion(LibraryType type, string version)
        {
            if (type == null) throw new ControllerException("library_type_not_found", "No library type was given.");

            List<LibraryTypeVersion> versions = new List<LibraryTypeVersion>();
            try
            {
                foreach (LibraryTypeVersion candidate in type.Versions) versions.Add(candidate);
            }
            catch (Exception ex)
            {
                throw OpennessFailure("library_version_read_failed",
                    "The versions of library type " + Text.Quote(SafeString(delegate { return type.Name; })) + " could not be read: " + ex.Message, ex);
            }
            if (versions.Count == 0)
            {
                throw new ControllerException("library_version_not_found",
                    "Library type " + Text.Quote(SafeString(delegate { return type.Name; })) + " has no versions.");
            }

            string requested = string.IsNullOrWhiteSpace(version) ? "default" : version.Trim();
            Guid parsedGuid;
            if (Guid.TryParse(requested, out parsedGuid))
            {
                foreach (LibraryTypeVersion candidate in versions)
                {
                    if (candidate.Guid == parsedGuid) return candidate;
                }
                throw new ControllerException("library_version_not_found",
                    "No version of the type has the GUID " + Text.Quote(requested) + ".",
                    JsonObject.Of("version", requested, "available", VersionNames(versions)));
            }

            if (string.Equals(requested, "default", StringComparison.OrdinalIgnoreCase))
            {
                foreach (LibraryTypeVersion candidate in versions)
                {
                    if (SafeBool(delegate { return candidate.IsDefault; })) return candidate;
                }
                LibraryTypeVersion committed = LatestVersion(versions, true);
                return committed ?? LatestVersion(versions, false);
            }
            if (string.Equals(requested, "latest", StringComparison.OrdinalIgnoreCase))
            {
                LibraryTypeVersion latest = LatestVersion(versions, false);
                if (latest != null) return latest;
            }
            if (string.Equals(requested, "committed", StringComparison.OrdinalIgnoreCase)
                || string.Equals(requested, "released", StringComparison.OrdinalIgnoreCase))
            {
                LibraryTypeVersion committed = LatestVersion(versions, true);
                if (committed != null) return committed;
                throw new ControllerException("library_version_not_found",
                    "The type has no committed (released) version.",
                    JsonObject.Of("available", VersionNames(versions)));
            }

            Version wanted;
            if (!Version.TryParse(requested, out wanted))
            {
                throw new ControllerException("invalid_params",
                    "'version' must be 'default', 'latest', 'committed', a version number such as '1.0.0', or a version GUID.",
                    JsonObject.Of("version", version, "available", VersionNames(versions)));
            }
            foreach (LibraryTypeVersion candidate in versions)
            {
                Version number = SafeVersionObject(candidate);
                if (number != null && number == wanted) return candidate;
            }
            throw new ControllerException("library_version_not_found",
                "Library type " + Text.Quote(SafeString(delegate { return type.Name; })) + " has no version "
                    + Text.Quote(requested) + ".",
                JsonObject.Of("version", requested, "available", VersionNames(versions)));
        }

        private static LibraryTypeVersion LatestVersion(List<LibraryTypeVersion> versions, bool committedOnly)
        {
            LibraryTypeVersion best = null;
            Version bestVersion = null;
            foreach (LibraryTypeVersion candidate in versions)
            {
                if (committedOnly)
                {
                    string state = SafeString(delegate { return candidate.State.ToString(); });
                    if (!string.Equals(state, "Committed", StringComparison.OrdinalIgnoreCase)) continue;
                }
                Version number = SafeVersionObject(candidate);
                if (number == null) continue;
                if (bestVersion == null || number > bestVersion)
                {
                    best = candidate;
                    bestVersion = number;
                }
            }
            return best;
        }

        private static List<string> VersionNames(List<LibraryTypeVersion> versions)
        {
            List<string> names = new List<string>();
            foreach (LibraryTypeVersion version in versions) names.Add(SafeVersion(version) ?? "?");
            names.Sort(StringComparer.OrdinalIgnoreCase);
            return names;
        }

        public LibraryTypeFolder ResolveTypeFolder(string path, bool create, DiagnosticLog log)
        {
            LibraryTypeFolder current = ProjectLibrary.TypeFolder;
            foreach (string segment in SplitFolderPath(path))
            {
                LibraryTypeUserFolder next = current.Folders.Find(segment);
                if (next == null)
                {
                    if (!create) return null;
                    try
                    {
                        next = current.Folders.Create(segment);
                        log.Info("Created the library type folder " + Text.Quote(segment) + ".");
                    }
                    catch (Exception ex)
                    {
                        throw OpennessFailure("library_folder_create_failed",
                            "The library type folder " + Text.Quote(segment) + " could not be created: " + ex.Message, ex);
                    }
                }
                current = next;
            }
            return current;
        }

        public MasterCopyFolder ResolveMasterCopyFolder(string path, bool create, DiagnosticLog log)
        {
            MasterCopyFolder current = ProjectLibrary.MasterCopyFolder;
            foreach (string segment in SplitFolderPath(path))
            {
                MasterCopyUserFolder next = current.Folders.Find(segment);
                if (next == null)
                {
                    if (!create) return null;
                    try
                    {
                        next = current.Folders.Create(segment);
                        log.Info("Created the library master-copy folder " + Text.Quote(segment) + ".");
                    }
                    catch (Exception ex)
                    {
                        throw OpennessFailure("library_folder_create_failed",
                            "The library master-copy folder " + Text.Quote(segment) + " could not be created: " + ex.Message, ex);
                    }
                }
                current = next;
            }
            return current;
        }

        // ----------------------------------------------------------- traversal

        private void CollectTypes(LibraryTypeFolder folder, string path, bool recursive, List<LibraryTypeRef> found)
        {
            if (folder == null) return;
            try
            {
                foreach (LibraryType type in folder.Types)
                {
                    found.Add(new LibraryTypeRef { Type = type, FolderPath = path ?? string.Empty });
                }
            }
            catch (Exception ex)
            {
                _log.Warning("The types of library folder " + Text.Quote(path) + " could not be enumerated: " + ex.Message);
            }
            if (!recursive) return;
            try
            {
                foreach (LibraryTypeUserFolder child in folder.Folders)
                {
                    string childPath = CombineFolderPath(path, SafeString(delegate { return child.Name; }));
                    CollectTypes(child, childPath, true, found);
                }
            }
            catch (Exception ex)
            {
                _log.Warning("The subfolders of library folder " + Text.Quote(path) + " could not be enumerated: " + ex.Message);
            }
        }

        private void CollectMasterCopies(MasterCopyFolder folder, string path, bool recursive, List<LibraryMasterCopyRef> found)
        {
            if (folder == null) return;
            try
            {
                foreach (MasterCopy masterCopy in folder.MasterCopies)
                {
                    found.Add(new LibraryMasterCopyRef { MasterCopy = masterCopy, FolderPath = path ?? string.Empty });
                }
            }
            catch (Exception ex)
            {
                _log.Warning("The master copies of folder " + Text.Quote(path) + " could not be enumerated: " + ex.Message);
            }
            if (!recursive) return;
            try
            {
                foreach (MasterCopyUserFolder child in folder.Folders)
                {
                    string childPath = CombineFolderPath(path, SafeString(delegate { return child.Name; }));
                    CollectMasterCopies(child, childPath, true, found);
                }
            }
            catch (Exception ex)
            {
                _log.Warning("The subfolders of master-copy folder " + Text.Quote(path) + " could not be enumerated: " + ex.Message);
            }
        }

        public List<string> ListTypeFolderPaths()
        {
            return ListTypeFolderPaths(ProjectLibrary.TypeFolder, string.Empty);
        }

        private List<string> ListTypeFolderPaths(LibraryTypeFolder root, string basePath)
        {
            List<string> paths = new List<string>();
            CollectTypeFolderPaths(root, basePath ?? string.Empty, paths);
            return paths;
        }

        private void CollectTypeFolderPaths(LibraryTypeFolder folder, string path, List<string> paths)
        {
            try
            {
                foreach (LibraryTypeUserFolder child in folder.Folders)
                {
                    string childPath = CombineFolderPath(path, SafeString(delegate { return child.Name; }));
                    paths.Add(childPath);
                    CollectTypeFolderPaths(child, childPath, paths);
                }
            }
            catch (Exception ex)
            {
                _log.Warning("The type folder paths below " + Text.Quote(path) + " could not be read: " + ex.Message);
            }
        }

        public List<string> ListMasterCopyFolderPaths()
        {
            return ListMasterCopyFolderPaths(ProjectLibrary.MasterCopyFolder, string.Empty);
        }

        private List<string> ListMasterCopyFolderPaths(MasterCopyFolder root, string basePath)
        {
            List<string> paths = new List<string>();
            CollectMasterCopyFolderPaths(root, basePath ?? string.Empty, paths);
            return paths;
        }

        private void CollectMasterCopyFolderPaths(MasterCopyFolder folder, string path, List<string> paths)
        {
            try
            {
                foreach (MasterCopyUserFolder child in folder.Folders)
                {
                    string childPath = CombineFolderPath(path, SafeString(delegate { return child.Name; }));
                    paths.Add(childPath);
                    CollectMasterCopyFolderPaths(child, childPath, paths);
                }
            }
            catch (Exception ex)
            {
                _log.Warning("The master-copy folder paths below " + Text.Quote(path) + " could not be read: " + ex.Message);
            }
        }

        private LibraryTypeRef FindTypeByGuid(Guid guid)
        {
            List<LibraryTypeRef> refs = new List<LibraryTypeRef>();
            CollectTypes(ProjectLibrary.TypeFolder, string.Empty, true, refs);
            foreach (LibraryTypeRef reference in refs)
            {
                try
                {
                    if (reference.Type.Guid == guid) return reference;
                }
                catch (Exception)
                {
                    // A disposed or stale type is skipped.
                }
            }
            return null;
        }

        // ------------------------------------------------------------- export

        public JsonObject ExportLibraryVersion(LibraryTypeVersion version, string file, ExportOptions options)
        {
            string state = SafeString(delegate { return version.State.ToString(); });
            if (string.Equals(state, "InWork", StringComparison.OrdinalIgnoreCase))
            {
                throw new ControllerException("library_version_in_work",
                    "The version is in the 'InWork' state; TIA Portal Openness refuses to export an in-work library version. "
                        + "Release the version in TIA Portal (or select a committed version) first.",
                    JsonObject.Of("state", state, "hint", "Use version='committed' or a committed version number."));
            }

            string full = Path.GetFullPath(file.Trim().Trim('"'));
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(full));
                // LibraryTypeVersion.Export refuses to overwrite; the caller has
                // already checked the overwrite flag, so replace the file here.
                if (File.Exists(full)) File.Delete(full);
                version.Export(new FileInfo(full), options);
            }
            catch (Exception ex)
            {
                throw OpennessFailure("library_export_failed",
                    "Exporting the library version to " + Text.Quote(full) + " failed: " + ex.Message, ex);
            }
            return DescribeExportedFile(full);
        }

        /// <summary>
        /// Exports a master copy by instantiating it into a temporary user group
        /// and rolling the transaction back afterwards. The export file survives
        /// the rollback; the project is left as it was.
        /// </summary>
        public JsonObject ExportMasterCopy(MasterCopy masterCopy, string file, ExportOptions options, PlcSoftware software, DiagnosticLog log)
        {
            string full = Path.GetFullPath(file.Trim().Trim('"'));
            string fullContentType;
            string contentType = MasterCopyContent(masterCopy, out fullContentType);
            if (!IsPlcMasterCopyType(contentType))
            {
                throw new ControllerException("library_master_copy_export_unsupported",
                    "The master copy contains " + Text.Quote(contentType ?? "an unknown object")
                        + "; this plugin can only export PLC blocks, PLC types and PLC tag tables from a master copy.",
                    JsonObject.Of("contentType", contentType, "fullContentType", fullContentType,
                        "supported", "FB, FC, OB, GlobalDB, InstanceDB, ArrayDB, PlcType, PlcTagTable"));
            }

            string token = LibraryStagingPrefix + Guid.NewGuid().ToString("N").Substring(0, 8);
            JsonObject data;
            using (TransactionScope scope = BeginTransaction("Export library master copy " + Text.Quote(SafeString(delegate { return masterCopy.Name; }))))
            {
                IEngineeringObject created = InstantiateMasterCopy(masterCopy, software, null, token, log);
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(full));
                    ExportObject(created, full, options);
                }
                catch (ControllerException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    string message = ex.Message ?? string.Empty;
                    if (message.IndexOf("Inconsistent blocks", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        throw new ControllerException("library_master_copy_inconsistent",
                            "The master copy cannot be exported because TIA Portal reports its content as inconsistent: "
                                + message,
                            JsonObject.Of("contentType", contentType, "hint",
                                "Open the master copy in TIA Portal, resolve the UDT/block inconsistency, update the master "
                                    + "copy, and retry. An inconsistent library object cannot be exported or instantiated by Openness."));
                    }
                    throw OpennessFailure("library_export_failed",
                        "Exporting the master copy to " + Text.Quote(full) + " failed: " + message, ex);
                }
                data = DescribeExportedFile(full);
                // Deliberately no Commit: disposing rolls the staging object back.
            }

            data.Add("contentType", contentType);
            data.AddIfPresent("fullContentType", fullContentType);
            data.Add("stagedName", token);
            data.Add("rolledBack", true);
            log.Info("Exported the master copy through the staging object " + Text.Quote(token) + " and rolled the project back.");
            return data;
        }

        private void ExportObject(IEngineeringObject target, string file, ExportOptions options)
        {
            PlcBlock block = target as PlcBlock;
            if (block != null) { block.Export(new FileInfo(file), options); return; }
            PlcType type = target as PlcType;
            if (type != null) { type.Export(new FileInfo(file), options); return; }
            PlcTagTable table = target as PlcTagTable;
            if (table != null) { table.Export(new FileInfo(file), options); return; }
            throw new ControllerException("library_master_copy_export_unsupported",
                "The instantiated object (" + target.GetType().FullName + ") has no Export method this plugin knows.");
        }

        private JsonObject DescribeExportedFile(string full)
        {
            JsonObject data = new JsonObject();
            data.Add("file", full);
            FileInfo info = new FileInfo(full);
            if (!info.Exists)
            {
                throw new ControllerException("library_export_failed",
                    "Openness reported success but no file exists at " + Text.Quote(full) + ".");
            }
            data.Add("bytes", info.Length);
            data.Add("sha256", Hashing.Sha256OfFile(full));
            data.Add("exported", true);
            try
            {
                SimaticMlHeader header = SimaticMl.ReadHeader(full);
                JsonObject described = new JsonObject();
                described.Add("element", header.ElementName);
                described.Add("kind", header.Kind);
                described.Add("simaticType", header.SimaticType);
                described.AddIfPresent("name", header.Name);
                described.AddIfPresent("number", header.Number);
                described.AddIfPresent("programmingLanguage", header.ProgrammingLanguage);
                if (header.IsLibraryTypeVersion)
                {
                    described.Add("libraryTypeVersion", JsonObject.Of(
                        "typeName", header.LibraryTypeName,
                        "typeGuid", header.LibraryTypeGuid,
                        "version", header.LibraryVersion,
                        "author", header.LibraryAuthor,
                        "modifiedDate", header.LibraryModifiedDate,
                        "contentElement", header.ContentElement));
                }
                data.Add("header", described);
            }
            catch (ControllerException ex)
            {
                data.Add("headerError", ex.Message);
            }
            return data;
        }

        // ---------------------------------------------------------- master copy

        public string MasterCopyContent(MasterCopy masterCopy, out string fullType)
        {
            fullType = null;
            try
            {
                foreach (MasterCopyContentDescription description in masterCopy.ContentDescriptions)
                {
                    if (description.ContentType == null) continue;
                    fullType = description.ContentType.FullName;
                    return description.ContentType.Name;
                }
            }
            catch (Exception ex)
            {
                throw OpennessFailure("library_master_copy_read_failed",
                    "The content of master copy " + Text.Quote(SafeString(delegate { return masterCopy.Name; }))
                        + " could not be read: " + ex.Message, ex);
            }
            return null;
        }

        private static bool IsPlcMasterCopyType(string contentType)
        {
            if (contentType == null) return false;
            switch (contentType)
            {
                case "FB":
                case "FC":
                case "OB":
                case "GlobalDB":
                case "InstanceDB":
                case "ArrayDB":
                case "PlcType":
                case "PlcStruct":
                case "PlcTagTable":
                    return true;
                default:
                    return false;
            }
        }

        /// <summary>
        /// Instantiates a master copy into the project. Only the PLC families are
        /// routed; HMI and hardware master copies are reported as unsupported
        /// rather than instantiated into a guessed target.
        /// </summary>
        public IEngineeringObject InstantiateMasterCopy(MasterCopy masterCopy, PlcSoftware software, string targetGroup,
            string newName, DiagnosticLog log)
        {
            string contentType;
            string fullType;
            contentType = MasterCopyContent(masterCopy, out fullType);
            IEngineeringObject created;
            switch (contentType)
            {
                case "FB":
                case "FC":
                case "OB":
                case "GlobalDB":
                case "InstanceDB":
                case "ArrayDB":
                {
                    PlcBlockGroup group = ResolveBlockGroup(software, targetGroup, true, log);
                    created = group.Blocks.CreateFrom(masterCopy);
                    break;
                }
                case "PlcType":
                case "PlcStruct":
                {
                    PlcTypeGroup group = ResolveTypeGroup(software, targetGroup, true, log);
                    created = group.Types.CreateFrom(masterCopy);
                    break;
                }
                case "PlcTagTable":
                {
                    PlcTagTableGroup group = ResolveTagTableGroup(software, targetGroup, true, log);
                    created = group.TagTables.CreateFrom(masterCopy);
                    break;
                }
                default:
                    throw new ControllerException("library_master_copy_instantiate_unsupported",
                        "The master copy contains " + Text.Quote(contentType ?? "an unknown object")
                            + "; only PLC blocks, PLC types and PLC tag tables can be instantiated by this plugin.",
                        JsonObject.Of("contentType", contentType, "fullContentType", fullType));
            }

            if (!string.IsNullOrWhiteSpace(newName))
            {
                try
                {
                    created.SetAttribute("Name", newName.Trim());
                }
                catch (Exception ex)
                {
                    throw OpennessFailure("library_instantiate_rename_failed",
                        "The object was created but could not be renamed to " + Text.Quote(newName) + ": " + ex.Message, ex);
                }
            }
            return created;
        }

        public MasterCopy CreateMasterCopy(MasterCopyFolder folder, IEngineeringObject source, string name, DiagnosticLog log)
        {
            IMasterCopySource masterCopySource = source as IMasterCopySource;
            if (masterCopySource == null)
            {
                throw new ControllerException("library_master_copy_source_unsupported",
                    "The object (" + source.GetType().FullName + ") is not an IMasterCopySource; TIA Portal cannot store it as a master copy.");
            }
            try
            {
                MasterCopy created = folder.MasterCopies.Create(masterCopySource);
                if (!string.IsNullOrWhiteSpace(name)
                    && !string.Equals(name.Trim(), SafeString(delegate { return created.Name; }), StringComparison.Ordinal))
                {
                    created.Name = name.Trim();
                }
                log.Info("Created the master copy " + Text.Quote(SafeString(delegate { return created.Name; })) + ".");
                return created;
            }
            catch (Exception ex)
            {
                throw OpennessFailure("library_master_copy_create_failed",
                    "Creating a master copy failed: " + ex.Message, ex);
            }
        }

        /// <summary>
        /// Renames or deletes the master copy that currently occupies
        /// <paramref name="name"/>, so a replacement can take its place. Returns a
        /// description of what happened, or null when nothing existed.
        /// </summary>
        public JsonObject ClearMasterCopyName(MasterCopyFolder folder, string name, bool keepPrevious, DiagnosticLog log)
        {
            MasterCopy existing = folder.MasterCopies.Find(name);
            if (existing == null) return null;

            JsonObject result = new JsonObject();
            result.Add("name", name);
            if (keepPrevious)
            {
                string stamp = DateTime.Now.ToString("yyyyMMddHHmmss");
                string previousName = name + "__previous_" + stamp;
                int suffix = 2;
                while (folder.MasterCopies.Find(previousName) != null)
                {
                    previousName = name + "__previous_" + stamp + "_" + suffix;
                    suffix++;
                }
                existing.Name = previousName;
                result.Add("action", "renamed");
                result.Add("previousName", previousName);
                log.Info("Kept the previous master copy as " + Text.Quote(previousName) + ".");
            }
            else
            {
                existing.Delete();
                result.Add("action", "deleted");
                log.Info("Deleted the previous master copy " + Text.Quote(name) + ".");
            }
            return result;
        }

        // ------------------------------------------------------------- project

        public IEngineeringObject FindProjectObject(PlcSoftware software, string category, string name, string group, DiagnosticLog log)
        {
            if (string.IsNullOrWhiteSpace(name))
            {
                throw new ControllerException("invalid_params", "'object_name' is required when source=project_object.");
            }
            List<string> names = new List<string> { name.Trim() };
            string wantedGroup = NormalizeFolderPath(group);
            if (string.Equals(category, "blocks", StringComparison.OrdinalIgnoreCase))
            {
                List<BlockRef> blocks = CollectBlocks(software, names, true, true);
                foreach (BlockRef reference in blocks)
                {
                    if (wantedGroup.Length == 0
                        || string.Equals(NormalizeFolderPath(reference.GroupPath), wantedGroup, StringComparison.OrdinalIgnoreCase))
                    {
                        return reference.Block;
                    }
                }
            }
            else if (string.Equals(category, "types", StringComparison.OrdinalIgnoreCase))
            {
                List<PlcTypeRef> types = CollectTypes(software, names, true, true);
                foreach (PlcTypeRef reference in types)
                {
                    if (wantedGroup.Length == 0
                        || string.Equals(NormalizeFolderPath(reference.GroupPath), wantedGroup, StringComparison.OrdinalIgnoreCase))
                    {
                        return reference.Type;
                    }
                }
            }
            else if (string.Equals(category, "tag_tables", StringComparison.OrdinalIgnoreCase))
            {
                List<PlcTagTableRef> tables = CollectTagTables(software, names, true, true);
                foreach (PlcTagTableRef reference in tables)
                {
                    if (wantedGroup.Length == 0
                        || string.Equals(NormalizeFolderPath(reference.GroupPath), wantedGroup, StringComparison.OrdinalIgnoreCase))
                    {
                        return reference.Table;
                    }
                }
            }
            else
            {
                throw new ControllerException("invalid_params",
                    "'category' must be one of blocks, types, tag_tables when source=project_object.");
            }

            throw new ControllerException("library_project_object_not_found",
                "No " + category + " object named " + Text.Quote(name)
                    + (string.IsNullOrWhiteSpace(group) ? string.Empty : " in group " + Text.Quote(group))
                    + " was found in the PLC software.",
                JsonObject.Of("category", category, "name", name, "group", group));
        }

        // ------------------------------------------------------- library guard

        /// <summary>
        /// True when the block is an instance of a project-library type version.
        ///
        /// Importing a modified XML over such a block bypasses TIA's check-in /
        /// release workflow and leaves the instance inconsistent, so the import
        /// operation refuses it unless the caller explicitly opts in.
        /// </summary>
        public static bool IsLibraryManaged(PlcBlock block)
        {
            if (block == null) return false;
            try
            {
                return block.GetService<LibraryTypeInstanceInfo>() != null;
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>True when the PLC type is an instance of a project-library type version.</summary>
        public static bool IsLibraryManaged(PlcType type)
        {
            if (type == null) return false;
            try
            {
                return type.GetService<LibraryTypeInstanceInfo>() != null;
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>The library type/version a block instance is linked to, or null.</summary>
        public static JsonObject DescribeLibraryInstance(PlcBlock block)
        {
            if (block == null) return null;
            try { return DescribeLibraryInstance(block.GetService<LibraryTypeInstanceInfo>()); }
            catch (Exception) { return null; }
        }

        /// <summary>The library type/version a PLC type instance is linked to, or null.</summary>
        public static JsonObject DescribeLibraryInstance(PlcType type)
        {
            if (type == null) return null;
            try { return DescribeLibraryInstance(type.GetService<LibraryTypeInstanceInfo>()); }
            catch (Exception) { return null; }
        }

        private static JsonObject DescribeLibraryInstance(LibraryTypeInstanceInfo info)
        {
            if (info == null) return null;
            JsonObject result = new JsonObject();
            try
            {
                LibraryTypeVersion version = info.LibraryTypeVersion;
                if (version == null) return result;
                result.AddIfPresent("type", SafeString(delegate { return version.TypeObject == null ? null : version.TypeObject.Name; }));
                result.AddIfPresent("version", SafeVersion(version));
                result.AddIfPresent("versionGuid", SafeString(delegate { return version.Guid.ToString(); }));
                result.AddIfPresent("state", SafeString(delegate { return version.State.ToString(); }));
            }
            catch (Exception)
            {
                // A disposed/stale instance is reported as "no details".
            }
            return result;
        }

        // ------------------------------------------------------------- helpers

        private static string NormalizeFolderPath(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return string.Empty;
            return string.Join("/", SplitFolderPath(path));
        }

        private static string[] SplitFolderPath(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return new string[0];
            return path.Trim().Trim('/', '\\').Split(new[] { '/', '\\' }, StringSplitOptions.RemoveEmptyEntries);
        }

        private static string CombineFolderPath(string parent, string child)
        {
            if (string.IsNullOrEmpty(parent)) return child ?? string.Empty;
            if (string.IsNullOrEmpty(child)) return parent;
            return parent + "/" + child;
        }

        private static bool MatchesName(string name, string filter)
        {
            if (string.IsNullOrWhiteSpace(filter)) return true;
            return name != null && name.IndexOf(filter.Trim(), StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static string SafeVersion(LibraryTypeVersion version)
        {
            if (version == null) return null;
            try
            {
                return version.VersionNumber.ToString();
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static Version SafeVersionObject(LibraryTypeVersion version)
        {
            try
            {
                return version.VersionNumber;
            }
            catch (Exception)
            {
                return null;
            }
        }
    }
}
