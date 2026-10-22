using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using Siemens.Engineering;
using Siemens.Engineering.SW;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>
    /// The evidence-producing operations: <c>PlcChecksum</c> and <c>SyncScan</c>.
    ///
    /// These live on the interface-plugin side on purpose. Reading the PLC checksum
    /// and the per-object fingerprints is the only way to answer "did this source
    /// tree still match the project", and that is a TIA fact, not a git fact. The
    /// controller therefore does the expensive traversal and the object-level
    /// comparison, writes the result (and only the changed XML) into the caller's
    /// STAGE directory, and returns a bounded summary. It never touches git and
    /// never decides what a workspace should contain.
    /// </summary>
    internal sealed partial class OpennessOperations
    {
        /// <summary>How many object rows a result may carry; the counts are complete.</summary>
        private const int MaxReportedObjects = 100;

        /// <summary>How many tombstones a ledger keeps before the oldest are dropped.</summary>
        private const int MaxTombstones = 500;

        // ------------------------------------------------------------- PlcChecksum

        /// <summary>
        /// Read <c>PlcChecksumProvider.Software</c>.
        ///
        /// An empty checksum is a state, not a transport failure: V17 reports it
        /// until the software has been fully compiled and again after every edit
        /// that has not been compiled. It is returned as a coded
        /// <c>checksum_unavailable</c> so the caller can tell "compile first" apart
        /// from "TIA is missing".
        /// </summary>
        private JsonObject PlcChecksum(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            PlcSoftwareRef software = _host.FindPlcSoftware(p.String("device_name", null), p.String("software_name", null));
            string checksum = OpennessHost.ChecksumOf(software.Software);
            if (string.IsNullOrEmpty(checksum))
            {
                throw new ControllerException(
                    "checksum_unavailable",
                    "The PLC software has no checksum: TIA reports one only after a successful compile, and it clears it "
                        + "again on the next edit. Compile the PLC (compile_plc) and call this operation again.",
                    JsonObject.Of("device", software.DeviceName, "software", software.SoftwareName));
            }

            JsonObject data = new JsonObject();
            data.Add("device", software.DeviceName);
            data.Add("software", software.SoftwareName);
            data.Add("checksum", checksum);
            return data;
        }

        // ---------------------------------------------------------------- SyncScan

        /// <summary>
        /// Compare the open project with the evidence ledger and export the changes.
        ///
        /// This is the only write-back path the versioning workflow needs: every
        /// reason a project changed (a user edit, an import from DRAFT, a remote
        /// block) ends here. The caller passes the previous ledger and an empty
        /// STAGE directory; the operation reads the checksum once, enumerates the
        /// composition itself (so the 1000-item listing cap does not apply), writes
        /// only the changed objects, hashes every tag table, and writes the next
        /// ledger into STAGE.
        /// </summary>
        private JsonObject SyncScan(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string sourceRoot = Path.GetFullPath(p.RequiredString("source_root").Trim().Trim('"'));
            string stageDir = Path.GetFullPath(p.RequiredString("stage_dir").Trim().Trim('"'));
            string evidencePath = Path.GetFullPath(p.RequiredString("evidence_path").Trim().Trim('"'));
            string manifestPath = p.String("manifest_path", null);
            if (!string.IsNullOrWhiteSpace(manifestPath)) manifestPath = Path.GetFullPath(manifestPath.Trim().Trim('"'));
            string exportOptionName = p.Enum("export_options", ExportOptionNames, "with_defaults");
            ExportOptions exportOptions = ParseExportOptions(exportOptionName);

            PlcSoftwareRef software = _host.FindPlcSoftware(p.String("device_name", null), p.String("software_name", null));
            string checksum = OpennessHost.ChecksumOf(software.Software);
            if (string.IsNullOrEmpty(checksum))
            {
                throw new ControllerException(
                    "checksum_unavailable",
                    "The PLC software has no checksum: it has not been compiled since the last change. Compile it first; "
                        + "SyncScan refuses to record a state that TIA has not compiled.",
                    JsonObject.Of("device", software.DeviceName, "software", software.SoftwareName));
            }

            EvidenceDocument previous = EvidenceDocument.Load(evidencePath);
            ManifestIndex previousManifest = ManifestIndex.Load(manifestPath);
            bool rebuildManifest = !previousManifest.IsUsable;
            if (previous != null && !string.IsNullOrEmpty(previous.Device)
                && !string.Equals(previous.Device, software.DeviceName, StringComparison.OrdinalIgnoreCase))
            {
                throw new ControllerException(
                    "evidence_device_mismatch",
                    "The evidence ledger belongs to the device " + Text.Quote(previous.Device) + ", but the open project's PLC is "
                        + Text.Quote(software.DeviceName) + ". Use the ledger of this project, or start a new one with a full scan.",
                    JsonObject.Of("ledgerDevice", previous.Device, "openDevice", software.DeviceName));
            }

            // The fast path: a compiled project whose checksum is unchanged cannot
            // have a changed block, a changed type or a changed tag table (V17
            // clears the checksum on every software edit). It also requires a usable
            // manifest: a missing/broken manifest is a view that has to be rebuilt,
            // even when the engineering state is unchanged.
            if (previous != null
                && !rebuildManifest
                && string.Equals(previous.PlcChecksum, checksum, StringComparison.Ordinal)
                && string.Equals(previous.Software, software.SoftwareName, StringComparison.OrdinalIgnoreCase))
            {
                return UnchangedResult(previous, checksum, software);
            }

            Directory.CreateDirectory(stageDir);

            // A scan always covers the whole software. Restricting it to some
            // families would leave the other families' evidence stale while still
            // recording the new PLC checksum, and the checksum fast path would then
            // report "unchanged" for a change nobody looked at.
            List<BlockRef> blocks = _host.CollectBlocks(software.Software, null, true, false);
            List<PlcTypeRef> types = _host.CollectTypes(software.Software, null, true, false);
            List<PlcTagTableRef> tables = _host.CollectTagTables(software.Software, null, true, false);

            List<ExportPlanItem> blockPlan = BuildBlockExportPlan(blocks, Path.Combine(stageDir, BlockFolderName), log);
            List<ExportPlanItem> typePlan = BuildTypeExportPlan(types, Path.Combine(stageDir, TypeFolderName), log);
            List<ExportPlanItem> tablePlan = BuildTagTableExportPlan(tables, Path.Combine(stageDir, TagTableFolderName), log);

            Dictionary<string, EvidenceObject> current = new Dictionary<string, EvidenceObject>(StringComparer.Ordinal);
            IndexFingerprinted(stageDir, blockPlan,
                delegate (int index) { return OpennessHost.FingerprintsOf(blocks[index].Block, log); }, current);
            IndexFingerprinted(stageDir, typePlan,
                delegate (int index) { return OpennessHost.FingerprintsOf(types[index].Type, log); }, current);
            for (int i = 0; i < tablePlan.Count; i++)
            {
                ExportPlanItem item = tablePlan[i];
                EvidenceObject entry = NewEntry(item, RelativePath(stageDir, item.File));
                current[entry.Key] = entry;
            }

            // An object that was unexportable and has not changed stays unexportable:
            // re-exporting a ProDiag / Safety block would fail on every scan. It is
            // retried as soon as its fingerprint changes (or, for a tag table, on
            // every scan, because a tag table has no fingerprint to compare).
            if (previous != null)
            {
                foreach (KeyValuePair<string, EvidenceObject> pair in current)
                {
                    EvidenceObject before;
                    if (!previous.Objects.TryGetValue(pair.Key, out before)) continue;
                    if (before.State == EvidenceDocument.StatePresent) continue;
                    if (!string.Equals(before.Signature, pair.Value.Signature, StringComparison.Ordinal)) continue;
                    pair.Value.State = before.State;
                    pair.Value.Reason = before.Reason;
                    if (!string.IsNullOrEmpty(before.Path)) pair.Value.Path = before.Path;
                }
            }

            // Which block / type objects need an export? Tag tables always do: they
            // have no fingerprint, so the only way to know whether one changed is to
            // export it and compare the normalized content hash.
            EvidenceDelta beforeExport = EvidenceDocument.Compare(previous, current);
            HashSet<string> exportKeys = new HashSet<string>(StringComparer.Ordinal);
            foreach (string key in beforeExport.Added) AddIfNotTagTable(key, current, exportKeys);
            foreach (string key in beforeExport.Changed) AddIfNotTagTable(key, current, exportKeys);
            // A missing/broken manifest is a view that must be rebuilt. The cheapest
            // correct way is to export every object once and build the manifest from
            // the same export records; the evidence diff still decides what changed.
            if (rebuildManifest)
            {
                foreach (string key in current.Keys) AddIfNotTagTable(key, current, exportKeys);
            }

            List<ExportPlanItem> exportPlan = new List<ExportPlanItem>();
            foreach (ExportPlanItem item in blockPlan)
            {
                if (exportKeys.Contains(KeyOf(item))) exportPlan.Add(item);
            }
            foreach (ExportPlanItem item in typePlan)
            {
                if (exportKeys.Contains(KeyOf(item))) exportPlan.Add(item);
            }
            exportPlan.AddRange(tablePlan);

            ExportRun run = RunExportPlan(exportPlan, exportOptions, true, log, changes, progress);

            foreach (JsonObject failure in run.Failures)
            {
                string category = JsonObject.ReadString(failure, "category", null);
                string name = JsonObject.ReadString(failure, "name", null);
                string group = JsonObject.ReadString(failure, "group", null);
                string key = EvidenceDocument.KeyOf(category, group, name);
                EvidenceObject entry;
                if (current.TryGetValue(key, out entry))
                {
                    entry.State = EvidenceDocument.StateUnexportable;
                    entry.Reason = JsonObject.ReadString(failure, "message", "TIA refused the export");
                }
            }
            // Tag tables: the file is the evidence. Hash it after the export and
            // compare with the previous hash. Only a table whose normalized content
            // actually changed is promoted to STAGE; the others are deleted from the
            // scratch export so a block-only sync does not rewrite seven unchanged
            // tables (and does not create DocumentInfo churn in the next commit).
            HashSet<string> promotedKeys = new HashSet<string>(StringComparer.Ordinal);
            foreach (string key in exportKeys)
            {
                EvidenceObject entry;
                if (!current.TryGetValue(key, out entry)) continue;
                if (entry.State == EvidenceDocument.StatePresent) promotedKeys.Add(key);
            }

            foreach (ExportPlanItem item in tablePlan)
            {
                string key = KeyOf(item);
                EvidenceObject entry;
                if (!current.TryGetValue(key, out entry)) continue;
                if (entry.State == EvidenceDocument.StateUnexportable)
                {
                    if (File.Exists(item.File)) File.Delete(item.File);
                    continue;
                }
                if (!File.Exists(item.File))
                {
                    entry.State = EvidenceDocument.StateUnexportable;
                    entry.Reason = "the exported tag table file is missing";
                    continue;
                }
                string text = File.ReadAllText(item.File);
                entry.ContentHash = "sha256:" + Hashing.Sha256OfText(EvidenceDocument.NormalizeXmlForHash(text));
                entry.State = EvidenceDocument.StatePresent;

                EvidenceObject before = null;
                if (previous != null) previous.Objects.TryGetValue(key, out before);
                bool unchanged = !rebuildManifest && before != null
                    && before.State == EvidenceDocument.StatePresent
                    && string.Equals(before.ContentHash, entry.ContentHash, StringComparison.Ordinal);
                if (unchanged)
                {
                    if (File.Exists(item.File)) File.Delete(item.File);
                    if (!string.IsNullOrEmpty(before.Path)) entry.Path = before.Path;
                    continue;
                }
                promotedKeys.Add(key);
            }

            EvidenceDelta delta = EvidenceDocument.Compare(previous, current);
            // An object whose export failed is reported through `unexportable`, not
            // as a content change: its file was not refreshed, so calling it changed
            // would claim more than was written.
            delta.Changed.RemoveAll(delegate (string key) { return current[key].State != EvidenceDocument.StatePresent; });
            delta.Added.RemoveAll(delegate (string key) { return current[key].State != EvidenceDocument.StatePresent; });

            EvidenceDocument next = new EvidenceDocument();
            next.Device = software.DeviceName;
            next.Software = software.SoftwareName;
            next.PlcChecksum = checksum;
            foreach (KeyValuePair<string, EvidenceObject> pair in current)
            {
                next.Objects[pair.Key] = pair.Value;
            }

            if (previous != null)
            {
                foreach (EvidenceTombstone tombstone in previous.Tombstones) next.Tombstones.Add(tombstone.Clone());
            }
            next.Tombstones.RemoveAll(delegate (EvidenceTombstone tombstone) { return current.ContainsKey(tombstone.Key); });
            foreach (string key in delta.Removed)
            {
                EvidenceObject before = previous.Objects[key];
                bool already = false;
                foreach (EvidenceTombstone tombstone in next.Tombstones)
                {
                    if (string.Equals(tombstone.Key, key, StringComparison.Ordinal)) { already = true; break; }
                }
                if (already) continue;
                EvidenceTombstone added = new EvidenceTombstone();
                added.Key = key;
                added.Category = before.Category;
                added.Name = before.Name;
                added.GroupPath = before.GroupPath;
                added.RemovedAtChecksum = checksum;
                added.Reason = "absent-from-complete-list";
                next.Tombstones.Add(added);
            }
            while (next.Tombstones.Count > MaxTombstones) next.Tombstones.RemoveAt(0);
            next.StateId = next.ComputeStateId();

            string evidenceOut = Path.Combine(stageDir, "_evidence.json");
            File.WriteAllText(evidenceOut, JsonWriter.Write(next.ToJson(), true) + "\n", new UTF8Encoding(false));
            changes.Add("evidence", evidenceOut, "written", "the ledger of this scan");

            string manifestOut = Path.Combine(stageDir, "_manifest.json");
            BuildAndWriteManifest(manifestOut, software, exportOptionName, stageDir, sourceRoot,
                blockPlan, typePlan, tablePlan, current, promotedKeys, run, previousManifest, log);
            changes.Add("manifest", manifestOut, "written", "the inventory of this scan");

            JsonObject counts = CountEvidence(next);
            counts.Add("changed", delta.Changed.Count);
            counts.Add("added", delta.Added.Count);
            counts.Add("removed", delta.Removed.Count);

            JsonObject data = new JsonObject();
            data.Add("device", software.DeviceName);
            data.Add("software", software.SoftwareName);
            data.Add("checksum", checksum);
            data.Add("unchanged", false);
            data.Add("counts", counts);
            data.Add("changed", ObjectRows(delta.Changed, previous, current, true));
            data.Add("added", ObjectRows(delta.Added, previous, current, false));
            data.Add("removed", RemovedRows(delta.Removed, previous));
            data.Add("unexportable", UnexportableRows(current));
            data.Add("stage", JsonObject.Of(
                "root", stageDir,
                "evidence", evidenceOut,
                "manifest", manifestOut,
                "files", promotedKeys.Count));
            data.Add("manifestRebuilt", rebuildManifest);
            data.Add("sourceRoot", sourceRoot);
            data.Add("stateId", next.StateId);

            log.Info("SyncScan: " + delta.Changed.Count + " changed, " + delta.Added.Count + " added, "
                + delta.Removed.Count + " removed; " + run.Exported + " file(s) written into " + stageDir + ".");
            return data;
        }

        /// <summary>
        /// Build the device inventory next to the ledger.
        ///
        /// The manifest is a derived view: it carries what the UI and the graph
        /// engine need (file facts, declared name/number, language, Simatic type),
        /// while the ledger carries what equality needs. Keeping both in one scan
        /// means a changed block is exported once and then described by both files.
        /// Entries whose object did not change are copied from the previous
        /// manifest; nothing is read from TIA twice.
        /// </summary>
        private void BuildAndWriteManifest(
            string manifestPath, PlcSoftwareRef software, string exportOptionName,
            string stageDir, string sourceRoot,
            List<ExportPlanItem> blockPlan, List<ExportPlanItem> typePlan, List<ExportPlanItem> tablePlan,
            Dictionary<string, EvidenceObject> current, HashSet<string> promotedKeys,
            ExportRun run, ManifestIndex previous, DiagnosticLog log)
        {
            Dictionary<string, ExportPlanItem> planByKey = new Dictionary<string, ExportPlanItem>(StringComparer.Ordinal);
            AddPlan(planByKey, blockPlan);
            AddPlan(planByKey, typePlan);
            AddPlan(planByKey, tablePlan);

            Dictionary<string, JsonObject> fileByPath = new Dictionary<string, JsonObject>(StringComparer.OrdinalIgnoreCase);
            foreach (JsonObject file in run.Files)
            {
                string path = JsonObject.ReadString(file, "file", null);
                if (!string.IsNullOrEmpty(path)) fileByPath[path] = file;
            }

            List<string> keys = new List<string>(current.Keys);
            keys.Sort(StringComparer.Ordinal);
            List<JsonObject> entries = new List<JsonObject>();
            List<JsonObject> failures = new List<JsonObject>();
            foreach (string key in keys)
            {
                EvidenceObject entry = current[key];
                ExportPlanItem item;
                planByKey.TryGetValue(key, out item);
                if (entry.State == EvidenceDocument.StatePresent)
                {
                    JsonObject row = null;
                    if (promotedKeys.Contains(key) && item != null)
                    {
                        JsonObject file;
                        if (fileByPath.TryGetValue(item.File, out file)) row = ManifestEntry(item, file, stageDir);
                    }
                    JsonObject before;
                    if (row == null && previous.Entries.TryGetValue(key, out before)) row = CopyJson(before);
                    if (row == null && item != null && !string.IsNullOrEmpty(entry.Path))
                    {
                        string full = Path.Combine(sourceRoot, entry.Path.Replace('/', Path.DirectorySeparatorChar));
                        row = ManifestEntryFromSource(item, entry.Path, full);
                    }
                    if (row != null) entries.Add(row);
                    else log.Warning("The manifest has no entry for " + Text.Quote(key) + " and it could not be rebuilt from the source tree.");
                }
                else
                {
                    JsonObject failure;
                    if (previous.Failures.TryGetValue(key, out failure)) failures.Add(CopyJson(failure));
                    else failures.Add(ManifestFailureEntry(entry));
                }
            }

            SortManifestRows(entries);
            SortManifestRows(failures);

            JsonObject manifest = new JsonObject();
            manifest.Add("schemaVersion", 1);
            manifest.Add("protocol", Protocol.Version);
            manifest.Add("generatedBy", Protocol.ControllerName);
            manifest.Add("device", software.DeviceName);
            manifest.Add("software", software.SoftwareName);
            manifest.Add("exportOptions", exportOptionName);
            manifest.Add("categories", new List<string> { CategoryBlocks, CategoryTypes, CategoryTagTables });
            manifest.Add("failureCount", failures.Count);
            manifest.Add("blocks", entries);
            if (failures.Count > 0) manifest.Add("failures", failures);

            try
            {
                File.WriteAllText(manifestPath, JsonWriter.Write(manifest, true), new UTF8Encoding(false));
            }
            catch (Exception ex)
            {
                log.Warning("The manifest could not be written to " + Text.Quote(manifestPath) + ": " + ex.Message);
            }
        }

        private static void AddPlan(Dictionary<string, ExportPlanItem> map, List<ExportPlanItem> plan)
        {
            foreach (ExportPlanItem item in plan) map[KeyOf(item)] = item;
        }

        private static JsonObject ManifestEntry(ExportPlanItem item, JsonObject file, string stageDir)
        {
            JsonObject row = new JsonObject();
            row.Add("category", item.Category);
            row.Add("name", item.Name);
            if (!string.IsNullOrEmpty(item.GroupPath)) row.Add("group", item.GroupPath);
            row.Add("file", RelativePath(stageDir, item.File));
            CopyIfPresent(row, file, "bytes");
            CopyIfPresent(row, file, "sha256");
            CopyIfPresent(row, file, "verified");
            CopyIfPresent(row, file, "simaticType");
            CopyIfPresent(row, file, "declaredName");
            CopyIfPresent(row, file, "declaredNumber");
            CopyIfPresent(row, file, "programmingLanguage");
            return row;
        }

        private static JsonObject ManifestEntryFromSource(ExportPlanItem item, string relativePath, string fullPath)
        {
            JsonObject row = new JsonObject();
            row.Add("category", item.Category);
            row.Add("name", item.Name);
            if (!string.IsNullOrEmpty(item.GroupPath)) row.Add("group", item.GroupPath);
            row.Add("file", relativePath);
            try
            {
                FileInfo info = new FileInfo(fullPath);
                if (!info.Exists)
                {
                    row.Add("verified", false);
                    return row;
                }
                row.Add("bytes", info.Length);
                row.Add("sha256", Hashing.Sha256OfFile(fullPath));
                SimaticMlHeader header = SimaticMl.ReadHeader(fullPath);
                row.AddIfPresent("simaticType", header.SimaticType);
                row.AddIfPresent("declaredName", header.Name);
                row.AddIfPresent("declaredNumber", header.Number);
                row.AddIfPresent("programmingLanguage", header.ProgrammingLanguage);
                row.Add("verified", true);
            }
            catch (Exception)
            {
                row.Add("verified", false);
            }
            return row;
        }

        private static JsonObject ManifestFailureEntry(EvidenceObject entry)
        {
            JsonObject row = new JsonObject();
            row.Add("category", entry.Category);
            row.Add("name", entry.Name);
            if (!string.IsNullOrEmpty(entry.GroupPath)) row.Add("group", entry.GroupPath);
            if (!string.IsNullOrEmpty(entry.Path)) row.Add("file", entry.Path);
            row.Add("code", "export_failed");
            row.Add("message", entry.Reason ?? "TIA refused the export");
            return row;
        }

        private static void CopyIfPresent(JsonObject target, JsonObject source, string key)
        {
            object value = source[key];
            if (value != null) target.Add(key, value);
        }

        private static JsonObject CopyJson(JsonObject source)
        {
            JsonObject copy = new JsonObject();
            foreach (KeyValuePair<string, object> pair in source) copy.Add(pair.Key, pair.Value);
            return copy;
        }

        private static void SortManifestRows(List<JsonObject> rows)
        {
            rows.Sort(delegate (JsonObject left, JsonObject right)
            {
                int result = string.CompareOrdinal(
                    JsonObject.ReadString(left, "category", string.Empty),
                    JsonObject.ReadString(right, "category", string.Empty));
                if (result != 0) return result;
                result = string.Compare(
                    JsonObject.ReadString(left, "name", string.Empty),
                    JsonObject.ReadString(right, "name", string.Empty),
                    StringComparison.OrdinalIgnoreCase);
                if (result != 0) return result;
                return string.Compare(
                    JsonObject.ReadString(left, "group", string.Empty),
                    JsonObject.ReadString(right, "group", string.Empty),
                    StringComparison.OrdinalIgnoreCase);
            });
        }

        /// <summary>
        /// The previous manifest, keyed like the ledger. A missing or unreadable
        /// manifest is not an error: it is a view that has to be rebuilt.
        /// </summary>
        private sealed class ManifestIndex
        {
            public bool IsUsable;
            public readonly Dictionary<string, JsonObject> Entries =
                new Dictionary<string, JsonObject>(StringComparer.Ordinal);
            public readonly Dictionary<string, JsonObject> Failures =
                new Dictionary<string, JsonObject>(StringComparer.Ordinal);

            public static ManifestIndex Load(string path)
            {
                ManifestIndex index = new ManifestIndex();
                if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return index;
                JsonArgs root;
                try
                {
                    root = JsonArgs.Parse(File.ReadAllText(path));
                }
                catch (Exception)
                {
                    return index;
                }
                string outputDir = root.String("outputDir", null);
                IList blocks = root.Raw("blocks") as IList;
                if (blocks == null) return index;
                foreach (object raw in blocks)
                {
                    Dictionary<string, object> dictionary = raw as Dictionary<string, object>;
                    if (dictionary == null) continue;
                    JsonObject entry = ToJsonObject(dictionary);
                    string key = ManifestKey(entry);
                    if (key == null) continue;
                    index.Entries[key] = NormalizeManifestFile(entry, outputDir);
                }
                IList failures = root.Raw("failures") as IList;
                if (failures != null)
                {
                    foreach (object raw in failures)
                    {
                        Dictionary<string, object> dictionary = raw as Dictionary<string, object>;
                        if (dictionary == null) continue;
                        JsonObject entry = ToJsonObject(dictionary);
                        string key = ManifestKey(entry);
                        if (key == null) continue;
                        index.Failures[key] = NormalizeManifestFile(entry, outputDir);
                    }
                }
                index.IsUsable = index.Entries.Count > 0;
                return index;
            }

            private static JsonObject ToJsonObject(Dictionary<string, object> dictionary)
            {
                JsonObject entry = new JsonObject();
                foreach (KeyValuePair<string, object> pair in dictionary) entry.Add(pair.Key, pair.Value);
                return entry;
            }

            private static string ManifestKey(JsonObject entry)
            {
                string category = JsonObject.ReadString(entry, "category", null);
                string name = JsonObject.ReadString(entry, "name", null);
                if (string.IsNullOrEmpty(category) || string.IsNullOrEmpty(name)) return null;
                return EvidenceDocument.KeyOf(category, JsonObject.ReadString(entry, "group", null), name);
            }

            private static JsonObject NormalizeManifestFile(JsonObject entry, string outputDir)
            {
                string file = JsonObject.ReadString(entry, "file", null);
                if (string.IsNullOrEmpty(file) || string.IsNullOrEmpty(outputDir) || !Path.IsPathRooted(file)) return entry;
                JsonObject copy = new JsonObject();
                foreach (KeyValuePair<string, object> pair in entry)
                {
                    if (string.Equals(pair.Key, "file", StringComparison.Ordinal)) copy.Add("file", RelativePath(outputDir, file));
                    else copy.Add(pair.Key, pair.Value);
                }
                return copy;
            }
        }

        private JsonObject UnchangedResult(EvidenceDocument previous, string checksum, PlcSoftwareRef software)
        {
            JsonObject counts = CountEvidence(previous);
            counts.Add("changed", 0);
            counts.Add("added", 0);
            counts.Add("removed", 0);

            JsonObject data = new JsonObject();
            data.Add("device", software.DeviceName);
            data.Add("software", software.SoftwareName);
            data.Add("checksum", checksum);
            data.Add("unchanged", true);
            data.Add("counts", counts);
            data.Add("changed", new List<JsonObject>());
            data.Add("added", new List<JsonObject>());
            data.Add("removed", new List<JsonObject>());
            data.Add("unexportable", new List<JsonObject>());
            data.Add("stage", null);
            data.Add("stateId", previous.StateId);
            return data;
        }

        private void IndexFingerprinted(string stageRoot, List<ExportPlanItem> plan,
            Func<int, List<JsonObject>> fingerprintsAt, Dictionary<string, EvidenceObject> current)
        {
            for (int i = 0; i < plan.Count; i++)
            {
                ExportPlanItem item = plan[i];
                EvidenceObject entry = NewEntry(item, RelativePath(stageRoot, item.File));
                string error;
                entry.Fingerprint = FingerprintMap(fingerprintsAt(i), out error);
                if (!string.IsNullOrEmpty(error))
                {
                    entry.State = EvidenceDocument.StateUnexportable;
                    entry.Reason = error;
                }
                current[entry.Key] = entry;
            }
        }

        private static EvidenceObject NewEntry(ExportPlanItem item, string relativePath)
        {
            EvidenceObject entry = new EvidenceObject();
            entry.Key = KeyOf(item);
            entry.Category = item.Category;
            entry.Name = item.Name;
            entry.GroupPath = item.GroupPath;
            entry.Path = relativePath;
            entry.State = EvidenceDocument.StatePresent;
            return entry;
        }

        private static string KeyOf(ExportPlanItem item)
        {
            return EvidenceDocument.KeyOf(item.Category, item.GroupPath, item.Name);
        }

        private static void AddIfNotTagTable(string key, Dictionary<string, EvidenceObject> current, HashSet<string> exportKeys)
        {
            EvidenceObject entry;
            if (!current.TryGetValue(key, out entry)) return;
            if (string.Equals(entry.Category, EvidenceDocument.CategoryTagTables, StringComparison.Ordinal)) return;
            // A block whose fingerprints could not be read is not exportable either:
            // exporting it would record a file without the fingerprint that is
            // supposed to prove it.
            if (entry.State != EvidenceDocument.StatePresent) return;
            exportKeys.Add(key);
        }

        private static Dictionary<string, string> FingerprintMap(List<JsonObject> fingerprints, out string error)
        {
            error = null;
            Dictionary<string, string> map = new Dictionary<string, string>(StringComparer.Ordinal);
            if (fingerprints == null || fingerprints.Count == 0)
            {
                error = "TIA returned no fingerprints for this object";
                return map;
            }
            foreach (JsonObject item in fingerprints)
            {
                string failure = JsonObject.ReadString(item, "error", null);
                if (!string.IsNullOrEmpty(failure))
                {
                    error = failure;
                    continue;
                }
                string id = JsonObject.ReadString(item, "id", null);
                if (string.IsNullOrEmpty(id)) continue;
                map[id] = JsonObject.ReadString(item, "value", null);
            }
            return map;
        }

        private static string RelativePath(string root, string file)
        {
            string fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string fullFile = Path.GetFullPath(file);
            string prefix = fullRoot + Path.DirectorySeparatorChar;
            if (!fullFile.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return Path.GetFileName(file);
            return fullFile.Substring(prefix.Length).Replace('\\', '/');
        }

        private static JsonObject CountEvidence(EvidenceDocument document)
        {
            int blocks = 0;
            int types = 0;
            int tables = 0;
            int unexportable = 0;
            foreach (KeyValuePair<string, EvidenceObject> pair in document.Objects)
            {
                EvidenceObject entry = pair.Value;
                if (string.Equals(entry.Category, EvidenceDocument.CategoryBlocks, StringComparison.Ordinal)) blocks++;
                else if (string.Equals(entry.Category, EvidenceDocument.CategoryTypes, StringComparison.Ordinal)) types++;
                else if (string.Equals(entry.Category, EvidenceDocument.CategoryTagTables, StringComparison.Ordinal)) tables++;
                if (entry.State != EvidenceDocument.StatePresent) unexportable++;
            }
            JsonObject counts = new JsonObject();
            counts.Add("blocks", blocks);
            counts.Add("types", types);
            counts.Add("tagTables", tables);
            counts.Add("unexportable", unexportable);
            return counts;
        }

        private static List<JsonObject> ObjectRows(List<string> keys, EvidenceDocument previous,
            Dictionary<string, EvidenceObject> current, bool withFaces)
        {
            List<JsonObject> rows = new List<JsonObject>();
            for (int i = 0; i < keys.Count && rows.Count < MaxReportedObjects; i++)
            {
                EvidenceObject entry;
                if (!current.TryGetValue(keys[i], out entry)) continue;
                EvidenceObject before = null;
                if (previous != null) previous.Objects.TryGetValue(keys[i], out before);
                JsonObject row = new JsonObject();
                row.Add("key", entry.Key);
                row.Add("category", entry.Category);
                row.Add("name", entry.Name);
                if (!string.IsNullOrEmpty(entry.GroupPath)) row.Add("group", entry.GroupPath);
                if (withFaces)
                {
                    List<string> faces = ChangedFaces(before, entry);
                    if (faces.Count > 0) row.Add("faces", faces);
                }
                rows.Add(row);
            }
            return rows;
        }

        private static List<JsonObject> RemovedRows(List<string> keys, EvidenceDocument previous)
        {
            List<JsonObject> rows = new List<JsonObject>();
            if (previous == null) return rows;
            for (int i = 0; i < keys.Count && rows.Count < MaxReportedObjects; i++)
            {
                EvidenceObject entry;
                if (!previous.Objects.TryGetValue(keys[i], out entry)) continue;
                JsonObject row = new JsonObject();
                row.Add("key", entry.Key);
                row.Add("category", entry.Category);
                row.Add("name", entry.Name);
                if (!string.IsNullOrEmpty(entry.GroupPath)) row.Add("group", entry.GroupPath);
                rows.Add(row);
            }
            return rows;
        }

        private static List<JsonObject> UnexportableRows(Dictionary<string, EvidenceObject> current)
        {
            List<string> keys = new List<string>();
            foreach (KeyValuePair<string, EvidenceObject> pair in current)
            {
                if (pair.Value.State != EvidenceDocument.StatePresent) keys.Add(pair.Key);
            }
            keys.Sort(StringComparer.Ordinal);
            List<JsonObject> rows = new List<JsonObject>();
            for (int i = 0; i < keys.Count && rows.Count < MaxReportedObjects; i++)
            {
                EvidenceObject entry = current[keys[i]];
                JsonObject row = new JsonObject();
                row.Add("key", entry.Key);
                row.Add("category", entry.Category);
                row.Add("name", entry.Name);
                if (!string.IsNullOrEmpty(entry.GroupPath)) row.Add("group", entry.GroupPath);
                row.Add("reason", entry.Reason ?? "TIA refused the export");
                rows.Add(row);
            }
            return rows;
        }

        private static List<string> ChangedFaces(EvidenceObject before, EvidenceObject after)
        {
            List<string> faces = new List<string>();
            if (string.Equals(after.Category, EvidenceDocument.CategoryTagTables, StringComparison.Ordinal))
            {
                if (before == null || !string.Equals(before.ContentHash, after.ContentHash, StringComparison.Ordinal))
                {
                    faces.Add("contentHash");
                }
                return faces;
            }

            Dictionary<string, string> a = before == null ? null : before.Fingerprint;
            Dictionary<string, string> b = after.Fingerprint;
            SortedSet<string> ids = new SortedSet<string>(StringComparer.Ordinal);
            if (a != null) foreach (string id in a.Keys) ids.Add(id);
            if (b != null) foreach (string id in b.Keys) ids.Add(id);
            foreach (string id in ids)
            {
                string left = null;
                string right = null;
                if (a != null) a.TryGetValue(id, out left);
                if (b != null) b.TryGetValue(id, out right);
                if (!string.Equals(left, right, StringComparison.Ordinal)) faces.Add(id);
            }
            return faces;
        }
    }
}
