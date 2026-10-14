using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Siemens.Engineering;
using Siemens.Engineering.Compiler;
using Siemens.Engineering.HW;
using Siemens.Engineering.HW.Features;
using Siemens.Engineering.SW;
using Siemens.Engineering.SW.Blocks;
using Siemens.Engineering.SW.ExternalSources;
using Siemens.Engineering.SW.Tags;
using Siemens.Engineering.SW.Types;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>One PLC software instance found in the open project.</summary>
    internal sealed class PlcSoftwareRef
    {
        public PlcSoftware Software;
        public string DeviceName;
        public string SoftwareName;

        public string DisplayName
        {
            get
            {
                return string.IsNullOrEmpty(DeviceName) ? SoftwareName : DeviceName + " / " + SoftwareName;
            }
        }
    }

    /// <summary>One PLC block plus the user-group path it was found under.</summary>
    internal sealed class BlockRef
    {
        public PlcBlock Block;
        public string GroupPath;

        public string Name { get { return Block.Name; } }
    }

    /// <summary>One PLC type (UDT) plus the user-group path it was found under.</summary>
    internal sealed class PlcTypeRef
    {
        public PlcType Type;
        public string GroupPath;

        public string Name { get { return Type == null ? null : Type.Name; } }
    }

    /// <summary>One PLC tag table plus the user-group path it was found under.</summary>
    internal sealed class PlcTagTableRef
    {
        public PlcTagTable Table;
        public string GroupPath;

        public string Name { get { return Table == null ? null : Table.Name; } }
    }

    /// <summary>
    /// Owns the Openness session: the TIA Portal instance, the open project, the
    /// exclusive-access transactions, and the PLC block traversal.
    ///
    /// Every method here runs on the single thread that reads the request
    /// channel. Openness objects are not thread safe and are never shared with
    /// another thread.
    ///
    /// The class is partial: the project-data helpers live in
    /// <c>OpennessHost.Project.cs</c>, the PLC-data helpers in
    /// <c>OpennessHost.Plc.cs</c> and the F-related helpers in
    /// <c>OpennessHost.Safety.cs</c>.
    /// </summary>
    internal sealed partial class OpennessHost : IDisposable
    {
        private readonly DiagnosticLog _log;
        private TiaPortal _portal;
        private Project _project;
        private bool _disposed;

        public OpennessHost(DiagnosticLog log)
        {
            _log = log;
        }

        public bool HasProject { get { return _project != null; } }

        public bool HasPortal { get { return _portal != null; } }

        public Project Project { get { return _project; } }

        // ---------------------------------------------------------------- portal

        /// <summary>
        /// Creates the TIA Portal instance, or attaches to a running one when the
        /// caller asked for a visible session and one exists.
        /// </summary>
        private void EnsurePortal(bool withWindow, IProgressSink progress)
        {
            if (_portal != null) return;

            if (withWindow)
            {
                List<TiaPortalProcess> processes = new List<TiaPortalProcess>();
                try
                {
                    processes.AddRange(TiaPortal.GetProcesses());
                }
                catch (Exception ex)
                {
                    _log.Warning("Running TIA Portal instances could not be enumerated: " + ex.Message);
                }

                if (processes.Count > 0)
                {
                    TiaPortalProcess existing = processes[0];
                    progress.Report("open", "Attaching to the running TIA Portal process " + existing.Id + ".");
                    _log.Info("Attached to TIA Portal process " + existing.Id
                        + (existing.ProjectPath != null ? " (" + existing.ProjectPath + ")" : string.Empty));
                    _portal = existing.Attach();
                    return;
                }
            }

            TiaPortalMode mode = withWindow ? TiaPortalMode.WithUserInterface : TiaPortalMode.WithoutUserInterface;
            progress.Report("open", "Starting TIA Portal V17 (" + (withWindow ? "with" : "without") + " user interface).");
            _portal = new TiaPortal(mode);
            _log.Info("Started a new TIA Portal instance in mode " + mode + ".");
        }

        // --------------------------------------------------------------- project

        public JsonObject OpenProject(string projectPath, bool withWindow, bool allowUpgrade, IProgressSink progress)
        {
            if (_project != null)
            {
                throw new ControllerException(
                    "project_already_open",
                    "A project is already open (" + Text.Quote(SafeProjectName()) + "). Close it first with CloseProject.",
                    JsonObject.Of("openProject", SafeProjectPath()));
            }

            string fullPath = NormalizeExistingFile(projectPath, "project_path");
            string extension = Path.GetExtension(fullPath);
            if (!extension.StartsWith(".ap", StringComparison.OrdinalIgnoreCase))
            {
                _log.Warning("The project file has the unusual extension " + Text.Quote(extension)
                    + "; a TIA Portal project file normally ends in .ap17.");
            }
            else if (!string.Equals(extension, ".ap17", StringComparison.OrdinalIgnoreCase))
            {
                _log.Warning("The project file ends in " + Text.Quote(extension)
                    + " but this controller is bound to TIA Portal V17 (.ap17). Opening it without "
                    + "allow_upgrade will fail, and allow_upgrade rewrites the project to V17.");
            }

            EnsurePortal(withWindow, progress);

            FileInfo file = new FileInfo(fullPath);
            progress.Report("open", (allowUpgrade ? "Opening and upgrading " : "Opening ") + fullPath);
            DateTime started = DateTime.UtcNow;
            try
            {
                _project = allowUpgrade ? _portal.Projects.OpenWithUpgrade(file) : _portal.Projects.Open(file);
            }
            catch (Exception ex)
            {
                throw OpennessFailure(
                    "project_open_failed",
                    "TIA Portal could not open " + Text.Quote(fullPath) + ": " + ex.Message,
                    ex);
            }

            JsonObject data = new JsonObject();
            data.Add("projectName", SafeProjectName());
            data.Add("projectPath", SafeProjectPath());
            data.Add("requestedPath", fullPath);
            data.Add("upgraded", allowUpgrade);
            data.Add("withUserInterface", withWindow);
            data.Add("openDurationMs", (long)(DateTime.UtcNow - started).TotalMilliseconds);
            data.Add("isModified", SafeIsModified());
            data.Add("plcSoftware", DescribePlcSoftware());
            data.Add("blockSummary", DescribeBlockSummary());
            return data;
        }

        private string NormalizeExistingFile(string path, string parameterName)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                throw new ControllerException("invalid_params", "'" + parameterName + "' is required.");
            }
            string full;
            try
            {
                full = Path.GetFullPath(path.Trim().Trim('"'));
            }
            catch (Exception ex)
            {
                throw new ControllerException("invalid_params", "'" + parameterName + "' is not a valid path: " + ex.Message);
            }
            if (!File.Exists(full))
            {
                throw new ControllerException(
                    "project_not_found",
                    "No file exists at " + Text.Quote(full) + ".",
                    JsonObject.Of("path", full));
            }
            return full;
        }

        public void SaveProject()
        {
            EnsureProjectOpen("SaveProject");
            try
            {
                _project.Save();
            }
            catch (Exception ex)
            {
                throw OpennessFailure("project_save_failed", "Saving the project failed: " + ex.Message, ex);
            }
        }

        /// <summary>Saves the project under a different name or in another directory.</summary>
        public void SaveProjectAs(string directory)
        {
            EnsureProjectOpen("SaveProject");
            if (string.IsNullOrWhiteSpace(directory))
            {
                throw new ControllerException("invalid_params", "'save_as_dir' must be a non-empty path.");
            }
            string full = Path.GetFullPath(directory.Trim().Trim('"'));
            try
            {
                _project.SaveAs(new DirectoryInfo(full));
            }
            catch (Exception ex)
            {
                throw OpennessFailure("project_save_failed",
                    "Saving the project as " + Text.Quote(full) + " failed: " + ex.Message, ex);
            }
        }

        public JsonObject CloseProject(bool save, bool closePortal)
        {
            EnsureProjectOpen("CloseProject");

            JsonObject data = new JsonObject();
            data.Add("projectName", SafeProjectName());
            data.Add("projectPath", SafeProjectPath());
            data.Add("saved", save);
            data.Add("isModifiedBeforeClose", SafeIsModified());

            if (save)
            {
                SaveProject();
            }

            try
            {
                _project.Close();
            }
            catch (Exception ex)
            {
                throw OpennessFailure("project_close_failed", "Closing the project failed: " + ex.Message, ex);
            }

            _project = null;
            data.Add("closed", true);

            if (closePortal && _portal != null)
            {
                try
                {
                    _portal.Dispose();
                }
                catch (Exception ex)
                {
                    _log.Warning("The TIA Portal instance could not be disposed: " + ex.Message);
                }
                _portal = null;
                data.Add("portalClosed", true);
            }

            return data;
        }

        // ----------------------------------------------------------- transaction

        /// <summary>
        /// Opens an exclusive-access session plus one transaction. The caller owns
        /// the returned scope: call <see cref="TransactionScope.Commit"/> after the
        /// last successful change, otherwise disposing rolls the transaction back.
        /// </summary>
        public TransactionScope BeginTransaction(string description)
        {
            EnsureProjectOpen("BeginTransaction");
            ExclusiveAccess access;
            Transaction transaction;
            try
            {
                // Exclusive access is granted per TIA Portal instance; the V17
                // overload without a text is used because the description belongs
                // to the undo unit created by the transaction.
                access = _portal.ExclusiveAccess();
                transaction = access.Transaction(_project, description);
            }
            catch (Exception ex)
            {
                throw OpennessFailure(
                    "transaction_failed",
                    "An exclusive access transaction could not be opened (" + description + "): " + ex.Message,
                    ex);
            }
            return new TransactionScope(access, transaction, _log);
        }

        // --------------------------------------------------------- plc software

        /// <summary>
        /// Every PLC software instance of the open project.
        ///
        /// Three sources have to be walked: the flat device composition, the
        /// "ungrouped devices" system group, and the device <b>user</b> groups (which
        /// nest). A project whose devices live in a user group exposes no PLC through
        /// <c>project.Devices</c> alone, so walking only that one collection silently
        /// reports "no PLC software" for a perfectly normal project.
        /// </summary>
        public List<PlcSoftwareRef> ListPlcSoftware()
        {
            EnsureProjectOpen("ListPlcSoftware");
            List<PlcSoftwareRef> found = new List<PlcSoftwareRef>();

            foreach (Device device in _project.Devices)
            {
                CollectPlcSoftware(device, device.Name, found);
            }

            DeviceSystemGroup ungrouped = _project.UngroupedDevicesGroup;
            if (ungrouped != null)
            {
                foreach (Device device in ungrouped.Devices)
                {
                    CollectPlcSoftware(device, device.Name, found);
                }
            }

            foreach (DeviceUserGroup group in _project.DeviceGroups)
            {
                CollectPlcSoftware(group, found);
            }

            return found;
        }

        private void CollectPlcSoftware(DeviceUserGroup group, List<PlcSoftwareRef> found)
        {
            foreach (Device device in group.Devices)
            {
                CollectPlcSoftware(device, device.Name, found);
            }
            foreach (DeviceUserGroup child in group.Groups)
            {
                CollectPlcSoftware(child, found);
            }
        }

        /// <summary>
        /// What the project actually contains, for the "no PLC software" failure: a
        /// project with only HMI devices is a legitimate input, and the caller needs to
        /// see that instead of a bare refusal.
        /// </summary>
        public JsonObject DescribeDevices()
        {
            List<JsonObject> devices = new List<JsonObject>();
            List<JsonObject> groups = new List<JsonObject>();

            foreach (Device device in _project.Devices) devices.Add(DescribeDevice(device, null));
            DeviceSystemGroup ungrouped = _project.UngroupedDevicesGroup;
            if (ungrouped != null)
            {
                foreach (Device device in ungrouped.Devices) devices.Add(DescribeDevice(device, ungrouped.Name));
            }
            foreach (DeviceUserGroup group in _project.DeviceGroups) DescribeGroup(group, group.Name, groups, devices);

            JsonObject result = new JsonObject();
            result.Add("deviceCount", devices.Count);
            result.Add("devices", devices);
            result.Add("deviceGroupCount", groups.Count);
            result.Add("deviceGroups", groups);
            result.Add("hint", "Only PLC software can be handled. A project that contains only HMI or other devices has no "
                + "PLC program blocks to export.");
            return result;
        }

        private void DescribeGroup(DeviceUserGroup group, string path, List<JsonObject> groups, List<JsonObject> devices)
        {
            JsonObject entry = new JsonObject();
            entry.Add("group", path);
            entry.Add("deviceCount", CountDevices(group));
            groups.Add(entry);

            foreach (Device device in group.Devices) devices.Add(DescribeDevice(device, path));
            foreach (DeviceUserGroup child in group.Groups) DescribeGroup(child, path + "/" + child.Name, groups, devices);
        }

        private int CountDevices(DeviceUserGroup group)
        {
            int count = 0;
            foreach (Device device in group.Devices) count++;
            foreach (DeviceUserGroup child in group.Groups) count += CountDevices(child);
            return count;
        }

        private static JsonObject DescribeDevice(Device device, string groupPath)
        {
            JsonObject item = new JsonObject();
            item.Add("name", device.Name);
            item.AddIfPresent("group", groupPath);

            int itemCount = 0;
            foreach (DeviceItem unused in device.DeviceItems) itemCount++;
            item.Add("deviceItemCount", itemCount);

            SoftwareContainer container = device.GetService<SoftwareContainer>();
            item.Add("hasSoftwareContainer", container != null && container.Software != null);
            if (container != null && container.Software != null)
            {
                item.Add("softwareType", container.Software.GetType().Name);
            }
            return item;
        }

        private void CollectPlcSoftware(Device device, string deviceName, List<PlcSoftwareRef> found)
        {
            SoftwareContainer container = device.GetService<SoftwareContainer>();
            AddPlcSoftware(container, deviceName, found);

            foreach (DeviceItem item in device.DeviceItems)
            {
                CollectPlcSoftware(item, deviceName, found);
            }
        }

        private void CollectPlcSoftware(DeviceItem item, string deviceName, List<PlcSoftwareRef> found)
        {
            SoftwareContainer container = item.GetService<SoftwareContainer>();
            AddPlcSoftware(container, deviceName, found);

            foreach (DeviceItem child in item.DeviceItems)
            {
                CollectPlcSoftware(child, deviceName, found);
            }
        }

        private static void AddPlcSoftware(SoftwareContainer container, string deviceName, List<PlcSoftwareRef> found)
        {
            if (container == null || container.Software == null) return;
            PlcSoftware plc = container.Software as PlcSoftware;
            if (plc == null) return;

            foreach (PlcSoftwareRef existing in found)
            {
                if (ReferenceEquals(existing.Software, plc)) return;
            }

            PlcSoftwareRef reference = new PlcSoftwareRef();
            reference.Software = plc;
            reference.DeviceName = deviceName;
            reference.SoftwareName = plc.Name;
            found.Add(reference);
        }

        /// <summary>
        /// Resolves the PLC software to operate on. Device and software names are
        /// optional; when omitted and exactly one PLC exists it is used, and an
        /// ambiguous project fails with the list of candidates.
        /// </summary>
        public PlcSoftwareRef FindPlcSoftware(string deviceName, string softwareName)
        {
            List<PlcSoftwareRef> all = ListPlcSoftware();
            if (all.Count == 0)
            {
                throw new ControllerException(
                    "plc_software_not_found",
                    "The open project contains no PLC software; only PLC program blocks can be handled.",
                    DescribeDevices());
            }

            List<PlcSoftwareRef> matches = new List<PlcSoftwareRef>();
            foreach (PlcSoftwareRef candidate in all)
            {
                if (!string.IsNullOrEmpty(deviceName)
                    && !string.Equals(candidate.DeviceName, deviceName, StringComparison.OrdinalIgnoreCase)) continue;
                if (!string.IsNullOrEmpty(softwareName)
                    && !string.Equals(candidate.SoftwareName, softwareName, StringComparison.OrdinalIgnoreCase)) continue;
                matches.Add(candidate);
            }

            if (matches.Count == 1) return matches[0];

            List<string> names = new List<string>();
            foreach (PlcSoftwareRef candidate in (matches.Count > 0 ? matches : all)) names.Add(candidate.DisplayName);

            if (matches.Count == 0)
            {
                throw new ControllerException(
                    "plc_software_not_found",
                    "No PLC software matches device " + Text.Quote(deviceName) + " / software " + Text.Quote(softwareName)
                        + ". Available: " + string.Join(", ", names.ToArray()) + ".",
                    JsonObject.Of("available", names));
            }

            throw new ControllerException(
                "plc_software_ambiguous",
                "More than one PLC software matches; pass device_name and/or software_name. Candidates: "
                    + string.Join(", ", names.ToArray()) + ".",
                JsonObject.Of("candidates", names));
        }

        private JsonObject DescribePlcSoftware()
        {
            List<JsonObject> items = new List<JsonObject>();
            foreach (PlcSoftwareRef reference in ListPlcSoftware())
            {
                JsonObject item = new JsonObject();
                item.Add("device", reference.DeviceName);
                item.Add("software", reference.SoftwareName);
                item.Add("blockCount", CountBlocks(reference.Software.BlockGroup));
                items.Add(item);
            }
            return JsonObject.Of("count", items.Count, "items", items);
        }

        private JsonObject DescribeBlockSummary()
        {
            List<JsonObject> items = new List<JsonObject>();
            foreach (PlcSoftwareRef reference in ListPlcSoftware())
            {
                foreach (BlockRef block in CollectBlocks(reference.Software, null, true, false))
                {
                    items.Add(DescribeBlock(block));
                }
            }
            return JsonObject.Of("count", items.Count, "items", items);
        }

        // --------------------------------------------------------------- blocks

        /// <summary>
        /// Collects blocks of one PLC software. When <paramref name="names"/> is
        /// null or empty every block is returned; otherwise only the requested
        /// names are returned and a missing name is an error. When
        /// <paramref name="recursive"/> is false only the root block composition is
        /// inspected.
        /// </summary>
        public List<BlockRef> CollectBlocks(PlcSoftware software, IList<string> names, bool recursive, bool strict)
        {
            List<BlockRef> found = new List<BlockRef>();
            HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
            CollectBlocks(software.BlockGroup, string.Empty, recursive, found, seen);

            if (names == null || names.Count == 0) return found;

            List<BlockRef> selected = new List<BlockRef>();
            List<string> missing = new List<string>();
            foreach (string requested in names)
            {
                bool matched = false;
                foreach (BlockRef candidate in found)
                {
                    if (!string.Equals(candidate.Name, requested, StringComparison.OrdinalIgnoreCase)) continue;
                    matched = true;
                    selected.Add(candidate);
                }
                if (!matched) missing.Add(requested);
            }

            if (missing.Count > 0 && strict)
            {
                List<string> available = new List<string>();
                foreach (BlockRef candidate in found) available.Add(candidate.GroupPath + candidate.Name);
                available.Sort(StringComparer.OrdinalIgnoreCase);

                throw new ControllerException(
                    "block_not_found",
                    "These blocks were not found: " + string.Join(", ", missing.ToArray())
                        + ". The project has " + found.Count + " block(s).",
                    JsonObject.Of("missing", missing, "available", available));
            }

            return selected;
        }

        private void CollectBlocks(PlcBlockGroup group, string path, bool recursive, List<BlockRef> found, HashSet<string> seen)
        {
            foreach (PlcBlock block in group.Blocks)
            {
                string key = path + "\u0000" + block.Name;
                if (!seen.Add(key)) continue;
                BlockRef reference = new BlockRef();
                reference.Block = block;
                reference.GroupPath = path;
                found.Add(reference);
            }

            if (!recursive) return;

            foreach (PlcBlockUserGroup child in group.Groups)
            {
                CollectBlocks(child, path + child.Name + "/", true, found, seen);
            }

            PlcBlockSystemGroup systemGroup = group as PlcBlockSystemGroup;
            if (systemGroup != null)
            {
                IEnumerable systemGroups = systemGroup.SystemBlockGroups as IEnumerable;
                if (systemGroups != null)
                {
                    foreach (object item in systemGroups)
                    {
                        PlcBlockGroup child = item as PlcBlockGroup;
                        if (child == null) continue;
                        CollectBlocks(child, path + child.Name + "/", true, found, seen);
                    }
                }
            }
        }

        private int CountBlocks(PlcBlockGroup group)
        {
            int count = 0;
            foreach (PlcBlock block in group.Blocks) count++;
            foreach (PlcBlockUserGroup child in group.Groups) count += CountBlocks(child);
            PlcBlockSystemGroup systemGroup = group as PlcBlockSystemGroup;
            if (systemGroup != null)
            {
                IEnumerable systemGroups = systemGroup.SystemBlockGroups as IEnumerable;
                if (systemGroups != null)
                {
                    foreach (object item in systemGroups)
                    {
                        PlcBlockGroup child = item as PlcBlockGroup;
                        if (child != null) count += CountBlocks(child);
                    }
                }
            }
            return count;
        }

        public static JsonObject DescribeBlock(BlockRef reference)
        {
            PlcBlock block = reference.Block;
            JsonObject item = new JsonObject();
            item.Add("name", SafeString(delegate { return block.Name; }));
            item.AddIfPresent("group", reference.GroupPath);
            item.AddIfPresent("programmingLanguage", SafeString(delegate { return Convert.ToString(block.ProgrammingLanguage); }));
            item.Add("number", SafeInt(delegate { return block.Number; }));
            item.Add("isConsistent", SafeBool(delegate { return block.IsConsistent; }));
            item.AddIfPresent("modifiedDate", SafeDate(delegate { return block.ModifiedDate; }));
            item.AddIfPresent("compileDate", SafeDate(delegate { return block.CompileDate; }));
            item.AddIfPresent("memoryLayout", SafeString(delegate { return Convert.ToString(block.MemoryLayout); }));
            item.AddIfPresent("headerAuthor", SafeString(delegate { return block.HeaderAuthor; }));
            item.AddIfPresent("headerVersion", SafeString(delegate { return Convert.ToString(block.HeaderVersion); }));
            return item;
        }

        /// <summary>
        /// Reads the attributes V17 exposes on the object itself (no interface
        /// cast), intersecting the caller's list with the attributes the object
        /// reports through <c>GetAttributeInfos()</c>.
        /// </summary>
        public static JsonObject ReadAttributes(IEngineeringObject target, IList<string> candidates)
        {
            JsonObject result = new JsonObject();
            HashSet<string> available = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                foreach (EngineeringAttributeInfo info in target.GetAttributeInfos())
                {
                    if (info != null && !string.IsNullOrEmpty(info.Name)) available.Add(info.Name);
                }
            }
            catch (Exception)
            {
                // Attribute discovery is diagnostic only.
            }

            result.Add("availableCount", available.Count);
            foreach (string candidate in candidates)
            {
                if (!available.Contains(candidate)) continue;
                try
                {
                    result.Add(candidate, target.GetAttribute(candidate));
                }
                catch (Exception ex)
                {
                    result.Add(candidate + ":error", ex.Message);
                }
            }
            return result;
        }

        // ------------------------------------------------------------- compile

        /// <summary>
        /// Returns the compilable service of one PLC software.
        ///
        /// V17 keeps the concrete compile provider internal and publishes only the
        /// <see cref="ICompilable"/> interface, so the service is requested by that
        /// interface — the same way <c>SoftwareContainer</c> is requested elsewhere
        /// in this controller.
        /// </summary>
        public ICompilable CompilableFor(PlcSoftware software)
        {
            ICompilable compilable = null;
            try
            {
                compilable = software.GetService<ICompilable>();
            }
            catch (Exception ex)
            {
                // Some object shapes expose no compile service at all.
                compilable = null;
                _log.Info("The PLC software exposes no ICompilable service: " + ex.Message);
            }

            if (compilable == null && _project != null)
            {
                try
                {
                    compilable = _project.GetService<ICompilable>();
                }
                catch (Exception)
                {
                    compilable = null;
                }
            }

            if (compilable == null)
            {
                throw new ControllerException(
                    "compile_provider_unavailable",
                    "TIA Portal returned no ICompilable service for this PLC software or project, so it cannot be "
                        + "compiled through Openness. Check that the project contains a compiled-capable PLC.");
            }
            return compilable;
        }

        // -------------------------------------------------------- PLC types (UDT)

        /// <summary>Collects PLC types (UDTs) of one PLC software, optionally filtered by name.</summary>
        public List<PlcTypeRef> CollectTypes(PlcSoftware software, IList<string> names, bool recursive, bool strict)
        {
            List<PlcTypeRef> found = new List<PlcTypeRef>();
            HashSet<PlcType> seen = new HashSet<PlcType>();
            CollectTypes(software.TypeGroup, string.Empty, recursive, found, seen);
            return SelectByName(found, delegate (PlcTypeRef r) { return r.Name; }, names, strict,
                "PLC type", "type_not_found", GroupedNames(found, delegate (PlcTypeRef r) { return r.GroupPath + r.Name; }));
        }

        private void CollectTypes(PlcTypeGroup group, string path, bool recursive, List<PlcTypeRef> found, HashSet<PlcType> seen)
        {
            foreach (PlcType type in group.Types)
            {
                if (!seen.Add(type)) continue;
                PlcTypeRef reference = new PlcTypeRef();
                reference.Type = type;
                reference.GroupPath = path;
                found.Add(reference);
            }

            if (!recursive) return;

            foreach (PlcTypeUserGroup child in group.Groups)
            {
                CollectTypes(child, path + child.Name + "/", true, found, seen);
            }

            PlcTypeSystemGroup systemGroup = group as PlcTypeSystemGroup;
            if (systemGroup != null)
            {
                IEnumerable systemGroups = systemGroup.SystemTypeGroups as IEnumerable;
                if (systemGroups != null)
                {
                    foreach (object item in systemGroups)
                    {
                        PlcTypeGroup child = item as PlcTypeGroup;
                        if (child != null) CollectTypes(child, path + child.Name + "/", true, found, seen);
                    }
                }
            }
        }

        public void ExportType(PlcType type, string file, ExportOptions options)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file)));
                type.Export(new FileInfo(file), options);
            }
            catch (Exception ex)
            {
                throw OpennessFailure("export_failed",
                    "Exporting PLC type " + Text.Quote(SafeName(type)) + " to " + Text.Quote(file) + " failed: " + ex.Message, ex);
            }
        }

        /// <summary>Imports a PLC type into a specific type group (same collision rule as blocks).</summary>
        public void ImportType(PlcTypeGroup group, string file, ImportOptions importOptions, IList<string> swImportOptions)
        {
            try
            {
                if (swImportOptions != null && swImportOptions.Count > 0)
                {
                    SWImportOptions combined = SWImportOptions.None;
                    foreach (string option in swImportOptions)
                    {
                        SWImportOptions parsed;
                        if (TryParseSWImportOption(option, out parsed)) combined = combined | parsed;
                    }
                    group.Types.Import(new FileInfo(file), importOptions, combined);
                }
                else
                {
                    group.Types.Import(new FileInfo(file), importOptions);
                }
            }
            catch (Exception ex)
            {
                throw OpennessFailure("import_failed",
                    "Importing the PLC type " + Text.Quote(file) + " failed: " + ex.Message, ex);
            }
        }

        public PlcTypeGroup ResolveTypeGroup(PlcSoftware software, string groupPath, bool create, DiagnosticLog log)
        {
            PlcTypeGroup current = software.TypeGroup;
            if (string.IsNullOrWhiteSpace(groupPath)) return current;
            foreach (string segment in SplitGroupPath(groupPath))
            {
                PlcTypeUserGroup next = null;
                foreach (PlcTypeUserGroup child in current.Groups)
                {
                    if (string.Equals(child.Name, segment, StringComparison.OrdinalIgnoreCase)) { next = child; break; }
                }
                if (next == null)
                {
                    if (!create) return null;
                    try { next = current.Groups.Create(segment); }
                    catch (Exception ex) { throw OpennessFailure("group_create_failed", "The type group " + Text.Quote(segment) + " could not be created: " + ex.Message, ex); }
                }
                current = next;
            }
            return current;
        }

        public List<string> ListTypeGroupPaths(PlcSoftware software)
        {
            List<string> paths = new List<string>();
            CollectTypeGroupPaths(software.TypeGroup, string.Empty, paths);
            return paths;
        }

        private void CollectTypeGroupPaths(PlcTypeGroup group, string path, List<string> paths)
        {
            foreach (PlcTypeUserGroup child in group.Groups)
            {
                paths.Add((path + child.Name).Trim('/'));
                CollectTypeGroupPaths(child, path + child.Name + "/", paths);
            }
        }

        // -------------------------------------------------------- PLC tag tables

        /// <summary>Collects tag tables of one PLC software, optionally filtered by name.</summary>
        public List<PlcTagTableRef> CollectTagTables(PlcSoftware software, IList<string> names, bool recursive, bool strict)
        {
            List<PlcTagTableRef> found = new List<PlcTagTableRef>();
            HashSet<PlcTagTable> seen = new HashSet<PlcTagTable>();
            CollectTagTables(software.TagTableGroup, string.Empty, recursive, found, seen);
            return SelectByName(found, delegate (PlcTagTableRef r) { return r.Name; }, names, strict,
                "tag table", "tag_table_not_found", GroupedNames(found, delegate (PlcTagTableRef r) { return r.GroupPath + r.Name; }));
        }

        private void CollectTagTables(PlcTagTableGroup group, string path, bool recursive, List<PlcTagTableRef> found, HashSet<PlcTagTable> seen)
        {
            foreach (PlcTagTable table in group.TagTables)
            {
                if (!seen.Add(table)) continue;
                PlcTagTableRef reference = new PlcTagTableRef();
                reference.Table = table;
                reference.GroupPath = path;
                found.Add(reference);
            }

            if (!recursive) return;

            foreach (PlcTagTableUserGroup child in group.Groups)
            {
                CollectTagTables(child, path + child.Name + "/", true, found, seen);
            }

            // PlcTagTableSystemGroup exposes no system sub-groups in V17 (only Parent),
            // so unlike blocks and types there is nothing further to walk here.
        }

        public void ExportTagTable(PlcTagTable table, string file, ExportOptions options)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file)));
                table.Export(new FileInfo(file), options);
            }
            catch (Exception ex)
            {
                throw OpennessFailure("export_failed",
                    "Exporting tag table " + Text.Quote(SafeTagTableName(table)) + " to " + Text.Quote(file) + " failed: " + ex.Message, ex);
            }
        }

        public void ImportTagTable(PlcTagTableGroup group, string file, ImportOptions importOptions)
        {
            try
            {
                group.TagTables.Import(new FileInfo(file), importOptions);
            }
            catch (Exception ex)
            {
                throw OpennessFailure("import_failed",
                    "Importing the tag table " + Text.Quote(file) + " failed: " + ex.Message, ex);
            }
        }

        public PlcTagTableGroup ResolveTagTableGroup(PlcSoftware software, string groupPath, bool create, DiagnosticLog log)
        {
            PlcTagTableGroup current = software.TagTableGroup;
            if (string.IsNullOrWhiteSpace(groupPath)) return current;
            foreach (string segment in SplitGroupPath(groupPath))
            {
                PlcTagTableUserGroup next = null;
                foreach (PlcTagTableUserGroup child in current.Groups)
                {
                    if (string.Equals(child.Name, segment, StringComparison.OrdinalIgnoreCase)) { next = child; break; }
                }
                if (next == null)
                {
                    if (!create) return null;
                    try { next = current.Groups.Create(segment); }
                    catch (Exception ex) { throw OpennessFailure("group_create_failed", "The tag table group " + Text.Quote(segment) + " could not be created: " + ex.Message, ex); }
                }
                current = next;
            }
            return current;
        }

        public List<string> ListTagTableGroupPaths(PlcSoftware software)
        {
            List<string> paths = new List<string>();
            CollectTagTableGroupPaths(software.TagTableGroup, string.Empty, paths);
            return paths;
        }

        private void CollectTagTableGroupPaths(PlcTagTableGroup group, string path, List<string> paths)
        {
            foreach (PlcTagTableUserGroup child in group.Groups)
            {
                paths.Add((path + child.Name).Trim('/'));
                CollectTagTableGroupPaths(child, path + child.Name + "/", paths);
            }
        }

        public static JsonObject DescribeType(PlcTypeRef reference)
        {
            JsonObject item = new JsonObject();
            item.Add("name", SafeString(delegate { return reference.Type.Name; }));
            item.AddIfPresent("group", reference.GroupPath);
            item.AddIfPresent("modifiedDate", SafeDate(delegate { return reference.Type.ModifiedDate; }));
            return item;
        }

        public static JsonObject DescribeTagTable(PlcTagTableRef reference)
        {
            JsonObject item = new JsonObject();
            item.Add("name", SafeString(delegate { return reference.Table.Name; }));
            item.AddIfPresent("group", reference.GroupPath);
            int tags = SafeInt(delegate
            {
                int count = 0;
                foreach (PlcTag unused in reference.Table.Tags) count++;
                return count;
            });
            item.Add("tagCount", tags);
            return item;
        }

        private static string SafeName(PlcType type) { return SafeString(delegate { return type.Name; }); }

        private static string SafeTagTableName(PlcTagTable table) { return SafeString(delegate { return table.Name; }); }

        private static string[] SplitGroupPath(string groupPath)
        {
            return groupPath.Split(new[] { '/', '\\' }, StringSplitOptions.RemoveEmptyEntries);
        }

        /// <summary>Shared name filter for the three object families.</summary>
        private static List<T> SelectByName<T>(List<T> found, Func<T, string> nameOf, IList<string> names, bool strict,
            string what, string errorCode, List<string> available)
        {
            if (names == null || names.Count == 0) return found;

            List<T> selected = new List<T>();
            List<string> missing = new List<string>();
            foreach (string requested in names)
            {
                bool matched = false;
                foreach (T candidate in found)
                {
                    if (!string.Equals(nameOf(candidate), requested, StringComparison.OrdinalIgnoreCase)) continue;
                    matched = true;
                    selected.Add(candidate);
                }
                if (!matched) missing.Add(requested);
            }

            if (missing.Count > 0 && strict)
            {
                throw new ControllerException(errorCode,
                    "These " + what + "(s) were not found: " + string.Join(", ", missing) + ". The project has "
                        + found.Count + " of them.",
                    JsonObject.Of("missing", missing, "available", available));
            }
            return selected;
        }

        private static List<string> GroupedNames<T>(List<T> items, Func<T, string> nameOf)
        {
            List<string> names = new List<string>();
            foreach (T item in items) names.Add(nameOf(item));
            names.Sort(StringComparer.OrdinalIgnoreCase);
            return names;
        }

        // ---------------------------------------------------------- block I/O

        public void ExportBlock(PlcBlock block, string file, ExportOptions options)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file)));
                block.Export(new FileInfo(file), options);
            }
            catch (Exception ex)
            {
                throw OpennessFailure(
                    "export_failed",
                    "Exporting block " + Text.Quote(SafeBlockName(block)) + " to " + Text.Quote(file) + " failed: " + ex.Message,
                    ex);
            }
        }

        /// <summary>
        /// Imports one Simatic ML file into a specific block group.
        ///
        /// The target group matters: import evaluates block name/number collisions
        /// across the whole PLC, so importing a block that lives in a user group into
        /// the root group fails even with <c>ImportOptions.Override</c> ("An object
        /// with this name or this number already exists"). Importing into the group
        /// the block actually lives in is what makes an export→import round trip work.
        /// </summary>
        public void ImportBlock(PlcBlockGroup group, string file, ImportOptions importOptions, IList<string> swImportOptions)
        {
            try
            {
                if (swImportOptions != null && swImportOptions.Count > 0)
                {
                    SWImportOptions combined = SWImportOptions.None;
                    foreach (string option in swImportOptions)
                    {
                        SWImportOptions parsed;
                        if (TryParseSWImportOption(option, out parsed)) combined = combined | parsed;
                    }
                    group.Blocks.Import(new FileInfo(file), importOptions, combined);
                }
                else
                {
                    group.Blocks.Import(new FileInfo(file), importOptions);
                }
            }
            catch (Exception ex)
            {
                throw OpennessFailure(
                    "import_failed",
                    "Importing " + Text.Quote(file) + " failed: " + ex.Message,
                    ex);
            }
        }

        /// <summary>
        /// Resolves a user-group path such as <c>A/B</c> relative to the PLC's block
        /// system group. With <paramref name="create"/> the missing groups are created;
        /// otherwise the method returns null and the caller decides (hard failure for
        /// an explicitly requested group, fallback to the root group for a mirrored
        /// directory layout).
        /// </summary>
        public PlcBlockGroup ResolveBlockGroup(PlcSoftware software, string groupPath, bool create, DiagnosticLog log)
        {
            PlcBlockGroup current = software.BlockGroup;
            if (string.IsNullOrWhiteSpace(groupPath)) return current;

            string[] segments = groupPath.Split(new[] { '/', '\\' }, StringSplitOptions.RemoveEmptyEntries);
            foreach (string segment in segments)
            {
                PlcBlockUserGroup next = null;
                foreach (PlcBlockUserGroup child in current.Groups)
                {
                    if (string.Equals(child.Name, segment, StringComparison.OrdinalIgnoreCase)) { next = child; break; }
                }
                if (next == null)
                {
                    if (!create) return null;
                    try
                    {
                        next = current.Groups.Create(segment);
                        log.Info("Created the block group " + Text.Quote(groupPath) + " (segment " + Text.Quote(segment) + ").");
                    }
                    catch (Exception ex)
                    {
                        throw OpennessFailure("group_create_failed",
                            "The block group " + Text.Quote(segment) + " could not be created: " + ex.Message, ex);
                    }
                }
                current = next;
            }
            return current;
        }

        /// <summary>User-group paths of one PLC software, for diagnostics.</summary>
        public List<string> ListBlockGroupPaths(PlcSoftware software)
        {
            List<string> paths = new List<string>();
            CollectGroupPaths(software.BlockGroup, string.Empty, paths);
            return paths;
        }

        private void CollectGroupPaths(PlcBlockGroup group, string path, List<string> paths)
        {
            foreach (PlcBlockUserGroup child in group.Groups)
            {
                string childPath = path + child.Name + "/";
                paths.Add(childPath.TrimEnd('/'));
                CollectGroupPaths(child, childPath, paths);
            }
        }

        public void ImportBlock(PlcSoftware software, string file, ImportOptions importOptions, IList<string> swImportOptions)
        {
            ImportBlock(software.BlockGroup, file, importOptions, swImportOptions);
        }

        public PlcExternalSource CreateExternalSource(PlcSoftware software, string name, string file)
        {
            try
            {
                return software.ExternalSourceGroup.ExternalSources.CreateFromFile(name, file);
            }
            catch (Exception ex)
            {
                throw OpennessFailure(
                    "import_failed",
                    "Adding the external source " + Text.Quote(file) + " to the project failed: " + ex.Message,
                    ex);
            }
        }

        public void GenerateBlocksFromSource(PlcExternalSource source, PlcBlockUserGroup targetGroup, GenerateBlockOption option)
        {
            try
            {
                if (targetGroup != null)
                {
                    source.GenerateBlocksFromSource(targetGroup, option);
                }
                else
                {
                    source.GenerateBlocksFromSource(option);
                }
            }
            catch (Exception ex)
            {
                throw OpennessFailure(
                    "import_failed",
                    "Generating blocks from the external source " + Text.Quote(source.Name) + " failed: " + ex.Message,
                    ex);
            }
        }

        public void DeleteExternalSource(PlcExternalSource source)
        {
            try
            {
                source.Delete();
            }
            catch (Exception ex)
            {
                _log.Warning("The temporary external source " + Text.Quote(source.Name) + " could not be deleted: " + ex.Message);
            }
        }

        private static bool TryParseSWImportOption(string option, out SWImportOptions parsed)
        {
            parsed = SWImportOptions.None;
            switch ((option ?? string.Empty).ToLowerInvariant())
            {
                case "ignore_structural_changes": parsed = SWImportOptions.IgnoreStructuralChanges; return true;
                case "ignore_missing_referenced_objects": parsed = SWImportOptions.IgnoreMissingReferencedObjects; return true;
                case "ignore_unit_attributes": parsed = SWImportOptions.IgnoreUnitAttributes; return true;
                default: return false;
            }
        }

        // -------------------------------------------------------------- status

        public JsonObject DescribeSession()
        {
            JsonObject session = new JsonObject();
            session.Add("portalOpen", _portal != null);
            if (_portal != null)
            {
                session.Add("portalMode", Convert.ToString(_portal.GetType().Name));
            }
            session.Add("projectOpen", _project != null);
            if (_project != null)
            {
                session.Add("projectName", SafeProjectName());
                session.Add("projectPath", SafeProjectPath());
                session.Add("isModified", SafeIsModified());
                session.Add("plcSoftware", DescribePlcSoftware());
            }
            return session;
        }

        // ----------------------------------------------------------- internals

        private void EnsureProjectOpen(string operation)
        {
            if (_project == null)
            {
                throw new ControllerException(
                    "project_not_open",
                    operation + " requires an open project. Call OpenProject first.");
            }
        }

        private string SafeProjectName()
        {
            if (_project == null) return null;
            return SafeString(delegate { return _project.Name; });
        }

        private string SafeProjectPath()
        {
            if (_project == null) return null;
            return SafeString(delegate { return Convert.ToString(_project.Path); });
        }

        private bool SafeIsModified()
        {
            return SafeBool(delegate { return _project.IsModified; });
        }

        private static string SafeBlockName(PlcBlock block)
        {
            return SafeString(delegate { return block.Name; });
        }

        private static string SafeString(Func<string> read)
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

        private static bool SafeBool(Func<bool> read)
        {
            try
            {
                return read();
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static int SafeInt(Func<int> read)
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

        private static object SafeDate(Func<DateTime> read)
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
        /// Turns an Openness exception into a structured failure, adding the
        /// Siemens error code when the exception carries one.
        /// </summary>
        internal static ControllerException OpennessFailure(string code, string message, Exception ex)
        {
            JsonObject details = new JsonObject();
            details.Add("exceptionType", ex.GetType().FullName);
            details.AddIfPresent("hresult", "0x" + ex.HResult.ToString("X8"));

            if (ex.InnerException != null)
            {
                details.Add("innerException", ex.InnerException.GetType().Name + ": " + ex.InnerException.Message);
            }

            string hint = HintFor(ex);
            if (hint != null) details.Add("hint", hint);

            return new ControllerException(code, message, details);
        }

        /// <summary>Maps the well-known Openness failures onto actionable hints.</summary>
        private static string HintFor(Exception ex)
        {
            string text = ex.Message ?? string.Empty;
            if (text.IndexOf("Access is denied", StringComparison.OrdinalIgnoreCase) >= 0
                || text.IndexOf("0x80070005", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "Access was denied. The Windows user running this controller must be a member of the local "
                    + "group 'Siemens TIA Openness' and must be allowed to open the project file.";
            }
            if (text.IndexOf("Siemens.Engineering", StringComparison.OrdinalIgnoreCase) >= 0
                && text.IndexOf("loaded", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "The Openness assembly could not be used. Rebuild with the Siemens.Engineering.dll of the "
                    + "installed TIA Portal V17.";
            }
            if (text.IndexOf("Openness", StringComparison.OrdinalIgnoreCase) >= 0
                && text.IndexOf("licens", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "The Openness licence or user group is missing for this Windows user.";
            }
            return null;
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;

            if (_project != null)
            {
                try
                {
                    _project.Close();
                    _log.Info("The open project was closed because the controller is shutting down.");
                }
                catch (Exception ex)
                {
                    _log.Warning("The open project could not be closed during shutdown: " + ex.Message);
                }
                _project = null;
            }

            if (_portal != null)
            {
                try
                {
                    _portal.Dispose();
                }
                catch (Exception ex)
                {
                    _log.Warning("The TIA Portal instance could not be disposed during shutdown: " + ex.Message);
                }
                _portal = null;
            }
        }
    }

    /// <summary>
    /// One exclusive-access session with one open transaction. Disposing commits
    /// only after <see cref="Commit"/> was called; otherwise the transaction is
    /// rolled back, which is what makes a partially failed import safe.
    /// </summary>
    internal sealed class TransactionScope : IDisposable
    {
        private readonly ExclusiveAccess _access;
        private readonly Transaction _transaction;
        private readonly DiagnosticLog _log;
        private bool _committed;
        private bool _disposed;

        public TransactionScope(ExclusiveAccess access, Transaction transaction, DiagnosticLog log)
        {
            _access = access;
            _transaction = transaction;
            _log = log;
        }

        public bool IsCommitted { get { return _committed; } }

        /// <summary>Marks the transaction for commit when the scope is disposed.</summary>
        public void Commit()
        {
            if (_disposed) throw new InvalidOperationException("The transaction scope is already disposed.");
            if (_committed) return;
            _transaction.CommitOnDispose();
            _committed = true;
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;

            try
            {
                _transaction.Dispose();
            }
            catch (Exception ex)
            {
                _log.Warning("Disposing the transaction failed: " + ex.Message);
            }

            try
            {
                _access.Dispose();
            }
            catch (Exception ex)
            {
                _log.Warning("Releasing the exclusive access session failed: " + ex.Message);
            }
        }
    }
}
