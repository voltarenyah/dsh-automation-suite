using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Security;
using Siemens.Engineering;
using Siemens.Engineering.SW;
using Siemens.Engineering.SW.Blocks;
using Siemens.Engineering.SW.ExternalSources;
using Siemens.Engineering.SW.Tags;
using Siemens.Engineering.SW.Types;
using Siemens.Engineering.SW.Units;
using Siemens.Engineering.SW.WatchAndForceTables;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>
    /// PLC-data half of the Openness session: enumerating, creating, deleting and
    /// changing the objects under <see cref="PlcSoftware"/> — blocks, PLC types,
    /// tag tables with their tags and constants, external sources, watch and
    /// force tables and software units.
    ///
    /// This is the manual chapter "Functions for accessing the data of a PLC
    /// device"; the operation contract is frozen in
    /// <c>docs/EXTENDED-SURFACE.md</c>.
    /// </summary>
    internal sealed partial class OpennessHost
    {
        // ------------------------------------------------------------- lookups

        /// <summary>Normalizes a user-group path so two spellings compare equal.</summary>
        public static string NormalizeGroupPath(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return string.Empty;
            return path.Trim().Replace('\\', '/').Trim('/');
        }

        /// <summary>
        /// Splits <c>"Group/Name"</c> at the last separator. Used by the delete
        /// operation so a caller can name an object either flat or with its group.
        /// </summary>
        public static void SplitGroupAndName(string value, out string groupPath, out string name)
        {
            string text = (value ?? string.Empty).Trim();
            int slash = text.LastIndexOfAny(new[] { '/', '\\' });
            if (slash < 0)
            {
                groupPath = null;
                name = text;
                return;
            }
            groupPath = text.Substring(0, slash).Trim('/');
            name = text.Substring(slash + 1);
        }

        /// <summary>Splits <c>"Table.Tag"</c> at the first dot.</summary>
        public static void SplitTableAndName(string value, out string tableName, out string name)
        {
            string text = (value ?? string.Empty).Trim();
            int dot = text.IndexOf('.');
            if (dot <= 0)
            {
                tableName = null;
                name = text;
                return;
            }
            tableName = text.Substring(0, dot);
            name = text.Substring(dot + 1);
        }

        public BlockRef FindBlock(PlcSoftware software, string groupPath, string name)
        {
            string wantedGroup = NormalizeGroupPath(groupPath);
            foreach (BlockRef reference in CollectBlocks(software, null, true, false))
            {
                if (!string.Equals(reference.Name, name, StringComparison.OrdinalIgnoreCase)) continue;
                if (wantedGroup.Length > 0
                    && !string.Equals(NormalizeGroupPath(reference.GroupPath), wantedGroup, StringComparison.OrdinalIgnoreCase)) continue;
                return reference;
            }
            return null;
        }

        public PlcTypeRef FindType(PlcSoftware software, string groupPath, string name)
        {
            string wantedGroup = NormalizeGroupPath(groupPath);
            foreach (PlcTypeRef reference in CollectTypes(software, null, true, false))
            {
                if (!string.Equals(reference.Name, name, StringComparison.OrdinalIgnoreCase)) continue;
                if (wantedGroup.Length > 0
                    && !string.Equals(NormalizeGroupPath(reference.GroupPath), wantedGroup, StringComparison.OrdinalIgnoreCase)) continue;
                return reference;
            }
            return null;
        }

        public PlcTagTableRef FindTagTable(PlcSoftware software, string groupPath, string name)
        {
            string wantedGroup = NormalizeGroupPath(groupPath);
            foreach (PlcTagTableRef reference in CollectTagTables(software, null, true, false))
            {
                if (!string.Equals(reference.Name, name, StringComparison.OrdinalIgnoreCase)) continue;
                if (wantedGroup.Length > 0
                    && !string.Equals(NormalizeGroupPath(reference.GroupPath), wantedGroup, StringComparison.OrdinalIgnoreCase)) continue;
                return reference;
            }
            return null;
        }

        public static List<string> AvailableNames<T>(IEnumerable<T> items, Func<T, string> nameOf)
        {
            List<string> names = new List<string>();
            foreach (T item in items)
            {
                string name = nameOf(item);
                if (!string.IsNullOrEmpty(name)) names.Add(name);
            }
            names.Sort(StringComparer.OrdinalIgnoreCase);
            return names;
        }

        // -------------------------------------------------------- enumerations

        /// <summary>
        /// Lists blocks of one PLC software.
        ///
        /// <paramref name="names"/> selects exact block names (the fingerprint
        /// workflow needs "these blocks", not "names containing this text"); a
        /// name that matches nothing is reported under <c>missing</c> instead of
        /// failing, because this operation is read-only.
        /// </summary>
        public JsonObject ListBlocks(PlcSoftware software, bool recursive, string nameFilter, IList<string> names,
            bool includeAttributes, bool includeFingerprints, int maxItems, DiagnosticLog log)
        {
            List<JsonObject> items = new List<JsonObject>();
            List<string> missing = new List<string>();
            int total = 0;

            if (names != null && names.Count > 0)
            {
                // An exact-name query has to see the whole tree regardless of the
                // recursive flag: a named block is either found or reported missing.
                List<BlockRef> all = CollectBlocks(software, null, true, false);
                foreach (string requested in names)
                {
                    bool matched = false;
                    foreach (BlockRef reference in all)
                    {
                        if (!string.Equals(reference.Name, requested, StringComparison.OrdinalIgnoreCase)) continue;
                        matched = true;
                        total++;
                        if (items.Count >= maxItems) continue;
                        JsonObject selected = DescribeBlock(reference);
                        AddBlockDetail(selected, reference.Block, includeAttributes, includeFingerprints, log);
                        items.Add(selected);
                    }
                    if (!matched) missing.Add(requested);
                }
            }
            else
            {
                foreach (BlockRef reference in CollectBlocks(software, null, recursive, false))
                {
                    if (!Matches(nameFilter, reference.Name)) continue;
                    total++;
                    if (items.Count >= maxItems) continue;
                    JsonObject item = DescribeBlock(reference);
                    AddBlockDetail(item, reference.Block, includeAttributes, includeFingerprints, log);
                    items.Add(item);
                }
            }

            JsonObject result = new JsonObject();
            result.Add("count", total);
            result.Add("items", items);
            result.Add("truncated", total > items.Count);
            if (missing.Count > 0) result.Add("missing", missing);
            return result;
        }

        private void AddBlockDetail(JsonObject item, PlcBlock block, bool includeAttributes, bool includeFingerprints,
            DiagnosticLog log)
        {
            item.Add("isKnowHowProtected", SafeBool(delegate { return block.IsKnowHowProtected; }));
            item.Add("autoNumber", SafeBool(delegate { return block.AutoNumber; }));
            item.AddIfPresent("parameterModified", SafeDate(delegate { return block.ParameterModified; }));
            item.AddIfPresent("structureModified", SafeDate(delegate { return block.StructureModified; }));
            item.AddIfPresent("codeModifiedDate", SafeDate(delegate { return block.CodeModifiedDate; }));
            if (includeAttributes) item.Add("attributes", ReadAttributeList(block));
            if (includeFingerprints) item.Add("fingerprints", FingerprintsOf(block, log));
        }

        public JsonObject ListTypes(PlcSoftware software, bool recursive, string nameFilter, IList<string> names,
            bool includeAttributes, bool includeFingerprints, int maxItems, DiagnosticLog log)
        {
            List<JsonObject> items = new List<JsonObject>();
            List<string> missing = new List<string>();
            int total = 0;

            if (names != null && names.Count > 0)
            {
                List<PlcTypeRef> all = CollectTypes(software, null, true, false);
                foreach (string requested in names)
                {
                    bool matched = false;
                    foreach (PlcTypeRef reference in all)
                    {
                        if (!string.Equals(reference.Name, requested, StringComparison.OrdinalIgnoreCase)) continue;
                        matched = true;
                        total++;
                        if (items.Count >= maxItems) continue;
                        items.Add(DescribeTypeDetail(reference, includeAttributes, includeFingerprints, log));
                    }
                    if (!matched) missing.Add(requested);
                }
            }
            else
            {
                foreach (PlcTypeRef reference in CollectTypes(software, null, recursive, false))
                {
                    if (!Matches(nameFilter, reference.Name)) continue;
                    total++;
                    if (items.Count >= maxItems) continue;
                    items.Add(DescribeTypeDetail(reference, includeAttributes, includeFingerprints, log));
                }
            }

            JsonObject result = new JsonObject();
            result.Add("count", total);
            result.Add("items", items);
            result.Add("truncated", total > items.Count);
            if (missing.Count > 0) result.Add("missing", missing);
            return result;
        }

        private static JsonObject DescribeTypeDetail(PlcTypeRef reference, bool includeAttributes,
            bool includeFingerprints, DiagnosticLog log)
        {
            JsonObject item = DescribeType(reference);
            PlcType type = reference.Type;
            item.Add("isConsistent", SafeBool(delegate { return type.IsConsistent; }));
            item.Add("isKnowHowProtected", SafeBool(delegate { return type.IsKnowHowProtected; }));
            item.AddIfPresent("interfaceModifiedDate", SafeDate(delegate { return type.InterfaceModifiedDate; }));
            if (includeAttributes) item.Add("attributes", ReadAttributeList(type));
            if (includeFingerprints) item.Add("fingerprints", FingerprintsOf(type, log));
            return item;
        }

        public JsonObject ListTagTables(PlcSoftware software, bool recursive, string nameFilter, IList<string> names,
            bool includeTags, bool includeConstants, int maxItems)
        {
            List<JsonObject> items = new List<JsonObject>();
            List<string> missing = new List<string>();
            int total = 0;

            if (names != null && names.Count > 0)
            {
                List<PlcTagTableRef> all = CollectTagTables(software, null, true, false);
                foreach (string requested in names)
                {
                    bool matched = false;
                    foreach (PlcTagTableRef reference in all)
                    {
                        if (!string.Equals(reference.Name, requested, StringComparison.OrdinalIgnoreCase)) continue;
                        matched = true;
                        total++;
                        if (items.Count >= maxItems) continue;
                        items.Add(DescribeTagTableDetail(reference, includeTags, includeConstants));
                    }
                    if (!matched) missing.Add(requested);
                }
            }
            else
            {
                foreach (PlcTagTableRef reference in CollectTagTables(software, null, recursive, false))
                {
                    if (!Matches(nameFilter, reference.Name)) continue;
                    total++;
                    if (items.Count >= maxItems) continue;
                    items.Add(DescribeTagTableDetail(reference, includeTags, includeConstants));
                }
            }

            JsonObject result = new JsonObject();
            result.Add("count", total);
            result.Add("items", items);
            result.Add("truncated", total > items.Count);
            if (missing.Count > 0) result.Add("missing", missing);
            return result;
        }

        private JsonObject DescribeTagTableDetail(PlcTagTableRef reference, bool includeTags, bool includeConstants)
        {
            JsonObject item = DescribeTagTable(reference);
            PlcTagTable table = reference.Table;
            item.Add("isDefault", SafeBool(delegate { return table.IsDefault; }));
            // V17 exposes the modification time as ModifiedTimeStamp; an
            // earlier note in the coverage matrix claimed otherwise.
            item.AddIfPresent("modifiedTimeStamp", SafeDate(delegate { return table.ModifiedTimeStamp; }));
            if (includeTags) item.Add("tags", ReadTags(table));
            if (includeConstants)
            {
                item.Add("userConstants", ReadUserConstants(table));
                item.Add("systemConstants", ReadSystemConstants(table));
            }
            return item;
        }

        public List<JsonObject> ReadTags(PlcTagTable table)
        {
            List<JsonObject> items = new List<JsonObject>();
            foreach (PlcTag tag in table.Tags)
            {
                items.Add(DescribeTag(tag));
            }
            return items;
        }

        public static JsonObject DescribeTag(PlcTag tag)
        {
            JsonObject item = new JsonObject();
            item.AddIfPresent("name", SafeString(delegate { return tag.Name; }));
            item.AddIfPresent("dataType", SafeString(delegate { return tag.DataTypeName; }));
            item.AddIfPresent("logicalAddress", SafeString(delegate { return tag.LogicalAddress; }));
            item.AddIfPresent("comment", CommentText(SafeComment(delegate { return tag.Comment; })));
            item.Add("externalAccessible", SafeBool(delegate { return tag.ExternalAccessible; }));
            item.Add("externalVisible", SafeBool(delegate { return tag.ExternalVisible; }));
            item.Add("externalWritable", SafeBool(delegate { return tag.ExternalWritable; }));
            return item;
        }

        public List<JsonObject> ReadUserConstants(PlcTagTable table)
        {
            List<JsonObject> items = new List<JsonObject>();
            foreach (PlcUserConstant constant in table.UserConstants)
            {
                JsonObject item = new JsonObject();
                item.AddIfPresent("name", SafeString(delegate { return constant.Name; }));
                item.AddIfPresent("dataType", SafeString(delegate { return constant.DataTypeName; }));
                item.AddIfPresent("value", SafeString(delegate { return constant.Value; }));
                item.AddIfPresent("comment", CommentText(SafeComment(delegate { return constant.Comment; })));
                items.Add(item);
            }
            return items;
        }

        public List<JsonObject> ReadSystemConstants(PlcTagTable table)
        {
            List<JsonObject> items = new List<JsonObject>();
            foreach (PlcSystemConstant constant in table.SystemConstants)
            {
                JsonObject item = new JsonObject();
                item.AddIfPresent("name", SafeString(delegate { return constant.Name; }));
                item.AddIfPresent("dataType", SafeString(delegate { return constant.DataTypeName; }));
                item.AddIfPresent("value", SafeString(delegate { return constant.Value; }));
                items.Add(item);
            }
            return items;
        }

        private static MultilingualText SafeComment(Func<MultilingualText> read)
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

        /// <summary>First non-empty text of a multilingual text, whatever language it is in.</summary>
        public static string CommentText(MultilingualText text)
        {
            if (text == null) return null;
            try
            {
                foreach (MultilingualTextItem item in text.Items)
                {
                    if (item == null) continue;
                    string value = null;
                    try
                    {
                        value = item.Text;
                    }
                    catch (Exception)
                    {
                        continue;
                    }
                    if (!string.IsNullOrEmpty(value)) return value;
                }
            }
            catch (Exception)
            {
                return null;
            }
            return null;
        }

        public JsonObject ListExternalSources(PlcSoftware software, bool recursive, string nameFilter, int maxItems)
        {
            List<JsonObject> items = new List<JsonObject>();
            int total = 0;
            CollectExternalSources(software.ExternalSourceGroup, string.Empty, recursive, nameFilter, maxItems, items, ref total);
            JsonObject result = new JsonObject();
            result.Add("count", total);
            result.Add("items", items);
            result.Add("truncated", total > items.Count);
            return result;
        }

        private void CollectExternalSources(PlcExternalSourceGroup group, string path, bool recursive, string nameFilter,
            int maxItems, List<JsonObject> items, ref int total)
        {
            foreach (PlcExternalSource source in group.ExternalSources)
            {
                string name = SafeString(delegate { return source.Name; });
                if (!Matches(nameFilter, name)) continue;
                total++;
                if (items.Count >= maxItems) continue;
                JsonObject item = new JsonObject();
                item.AddIfPresent("name", name);
                item.AddIfPresent("group", path.Trim('/'));
                items.Add(item);
            }

            if (!recursive) return;
            foreach (PlcExternalSourceUserGroup child in group.Groups)
            {
                string childName = SafeString(delegate { return child.Name; });
                CollectExternalSources(child, path + childName + "/", true, nameFilter, maxItems, items, ref total);
            }
        }

        public JsonObject ListWatchTables(PlcSoftware software, string kind, bool recursive, string nameFilter, int maxItems)
        {
            bool force = string.Equals(kind, "force", StringComparison.OrdinalIgnoreCase);
            List<JsonObject> items = new List<JsonObject>();
            int total = 0;
            CollectWatchAndForceTables(software.WatchAndForceTableGroup, string.Empty, recursive, force, nameFilter,
                maxItems, items, ref total);

            JsonObject result = new JsonObject();
            result.Add("count", total);
            result.Add("items", items);
            result.Add("truncated", total > items.Count);
            return result;
        }

        private void CollectWatchAndForceTables(PlcWatchAndForceTableGroup group, string path, bool recursive, bool force,
            string nameFilter, int maxItems, List<JsonObject> items, ref int total)
        {
            if (force)
            {
                foreach (PlcForceTable table in group.ForceTables)
                {
                    string name = SafeString(delegate { return table.Name; });
                    if (!Matches(nameFilter, name)) continue;
                    total++;
                    if (items.Count >= maxItems) continue;
                    items.Add(DescribeWatchOrForceTable(name, path, table, null));
                }
            }
            else
            {
                foreach (PlcWatchTable table in group.WatchTables)
                {
                    string name = SafeString(delegate { return table.Name; });
                    if (!Matches(nameFilter, name)) continue;
                    total++;
                    if (items.Count >= maxItems) continue;
                    items.Add(DescribeWatchOrForceTable(name, path, null, table));
                }
            }

            if (!recursive) return;
            foreach (PlcWatchAndForceTableUserGroup child in group.Groups)
            {
                string childName = SafeString(delegate { return child.Name; });
                CollectWatchAndForceTables(child, path + childName + "/", true, force, nameFilter, maxItems, items, ref total);
            }
        }

        private static JsonObject DescribeWatchOrForceTable(string name, string path,
            PlcForceTable forceTable, PlcWatchTable watchTable)
        {
            JsonObject item = new JsonObject();
            item.AddIfPresent("name", name);
            item.AddIfPresent("group", path.Trim('/'));
            object entries = forceTable != null ? (object)forceTable.Entries : watchTable.Entries;
            item.Add("entryCount", CountEnumerable(entries));
            if (forceTable != null)
            {
                item.Add("isConsistent", SafeBool(delegate { return forceTable.IsConsistent; }));
            }
            else
            {
                item.Add("isConsistent", SafeBool(delegate { return watchTable.IsConsistent; }));
            }
            return item;
        }

        internal static int CountEnumerable(object value)
        {
            IEnumerable items = value as IEnumerable;
            if (items == null) return 0;
            int count = 0;
            foreach (object unused in items) count++;
            return count;
        }

        // --------------------------------------------------------- find tables

        public PlcWatchAndForceTableGroup ResolveWatchAndForceGroup(PlcSoftware software, string groupPath, bool create,
            DiagnosticLog log)
        {
            PlcWatchAndForceTableGroup current = software.WatchAndForceTableGroup;
            if (string.IsNullOrWhiteSpace(groupPath)) return current;

            foreach (string segment in SplitGroupPath(groupPath))
            {
                PlcWatchAndForceTableUserGroup next = null;
                foreach (PlcWatchAndForceTableUserGroup child in current.Groups)
                {
                    string name = SafeString(delegate { return child.Name; });
                    if (string.Equals(name, segment, StringComparison.OrdinalIgnoreCase)) { next = child; break; }
                }
                if (next == null)
                {
                    if (!create) return null;
                    try
                    {
                        next = current.Groups.Create(segment);
                        log.Info("Created the watch/force table group " + Text.Quote(segment) + ".");
                    }
                    catch (Exception ex)
                    {
                        throw OpennessFailure("group_create_failed",
                            "The watch/force table group " + Text.Quote(segment) + " could not be created: " + ex.Message, ex);
                    }
                }
                current = next;
            }
            return current;
        }

        public PlcWatchTable FindWatchTable(PlcSoftware software, string groupPath, string name)
        {
            PlcWatchAndForceTableGroup group = ResolveWatchAndForceGroup(software, groupPath, false, _log);
            if (group == null) return null;
            try
            {
                return group.WatchTables.Find(name);
            }
            catch (Exception)
            {
                return null;
            }
        }

        public PlcForceTable FindForceTable(PlcSoftware software, string groupPath, string name)
        {
            PlcWatchAndForceTableGroup group = ResolveWatchAndForceGroup(software, groupPath, false, _log);
            if (group == null) return null;
            try
            {
                return group.ForceTables.Find(name);
            }
            catch (Exception)
            {
                return null;
            }
        }

        public PlcWatchTable CreateWatchTable(PlcSoftware software, string groupPath, string name, bool createGroup,
            DiagnosticLog log)        {
            PlcWatchAndForceTableGroup group = ResolveWatchAndForceGroup(software, groupPath, createGroup, log);
            if (group == null)
            {
                throw GroupNotFound(groupPath, ListWatchAndForceGroupPaths(software), "watch/force table group");
            }
            try
            {
                return group.WatchTables.Create(name);
            }
            catch (Exception ex)
            {
                throw OpennessFailure("table_create_failed",
                    "Creating the watch table " + Text.Quote(name) + " failed: " + ex.Message, ex);
            }
        }

        public List<string> ListWatchAndForceGroupPaths(PlcSoftware software)
        {
            List<string> paths = new List<string>();
            CollectWatchAndForceGroupPaths(software.WatchAndForceTableGroup, string.Empty, paths);
            return paths;
        }

        public void ExportWatchTable(PlcWatchTable table, string file)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file)));
                table.Export(new FileInfo(file), ExportOptions.WithDefaults);
            }
            catch (Exception ex)
            {
                throw OpennessFailure("export_failed",
                    "Exporting the watch table " + Text.Quote(SafeString(delegate { return table.Name; })) + " to "
                        + Text.Quote(file) + " failed: " + ex.Message, ex);
            }
        }

        public void ExportForceTable(PlcForceTable table, string file)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file)));
                table.Export(new FileInfo(file), ExportOptions.WithDefaults);
            }
            catch (Exception ex)
            {
                throw OpennessFailure("export_failed",
                    "Exporting the force table " + Text.Quote(SafeString(delegate { return table.Name; })) + " to "
                        + Text.Quote(file) + " failed: " + ex.Message, ex);
            }
        }

        /// <summary>
        /// Imports one XML file into a watch or force table composition. V17 offers
        /// Create only for watch tables, so a force table can exclusively be
        /// brought into the project through this path.
        /// </summary>
        public void ImportWatchOrForceTable(PlcWatchAndForceTableGroup group, string file, ImportOptions options, bool force)
        {
            try
            {
                if (force)
                {
                    group.ForceTables.Import(new FileInfo(file), options);
                }
                else
                {
                    group.WatchTables.Import(new FileInfo(file), options);
                }
            }
            catch (Exception ex)
            {
                throw OpennessFailure("import_failed",
                    "Importing the watch/force table " + Text.Quote(file) + " failed: " + ex.Message, ex);
            }
        }

        /// <summary>Reads a boolean attribute without letting a missing one fail the caller.</summary>
        public static bool ReadBoolAttribute(IEngineeringObject target, string name)
        {
            object value = TryReadAttribute(target, name);
            if (value is bool) return (bool)value;
            bool parsed;
            return bool.TryParse(Convert.ToString(value), out parsed) && parsed;
        }

        private void CollectWatchAndForceGroupPaths(PlcWatchAndForceTableGroup group, string path, List<string> paths)
        {
            foreach (PlcWatchAndForceTableUserGroup child in group.Groups)
            {
                string name = SafeString(delegate { return child.Name; });
                paths.Add((path + name).Trim('/'));
                CollectWatchAndForceGroupPaths(child, path + name + "/", paths);
            }
        }

        // ----------------------------------------------------------- creation

        /// <summary>Creates the user group named by the path, or reports that it already exists.</summary>
        public JsonObject CreateGroup(PlcSoftware software, string kind, string groupPath, bool createParents)
        {
            string normalized = NormalizeGroupPath(groupPath);
            if (normalized.Length == 0)
            {
                throw new ControllerException("invalid_params", "'group_path' is required when creating a group.");
            }

            int slash = normalized.LastIndexOf('/');
            string parent = slash > 0 ? normalized.Substring(0, slash) : string.Empty;
            string leaf = slash > 0 ? normalized.Substring(slash + 1) : normalized;

            try
            {
                switch (kind)
                {
                    case "block_group":
                        if (DescendBlockGroups(software.BlockGroup, normalized, false) != null)
                        {
                            throw AlreadyExists("block group", normalized);
                        }
                        {
                            PlcBlockGroup target = DescendBlockGroups(software.BlockGroup, parent, createParents);
                            if (target == null) throw GroupNotFound(parent, ListBlockGroupPaths(software), "block group");
                            target.Groups.Create(leaf);
                        }
                        break;
                    case "type_group":
                        if (DescendTypeGroups(software.TypeGroup, normalized, false) != null)
                        {
                            throw AlreadyExists("type group", normalized);
                        }
                        {
                            PlcTypeGroup target = DescendTypeGroups(software.TypeGroup, parent, createParents);
                            if (target == null) throw GroupNotFound(parent, ListTypeGroupPaths(software), "type group");
                            target.Groups.Create(leaf);
                        }
                        break;
                    default:
                        if (DescendTagTableGroups(software.TagTableGroup, normalized, false) != null)
                        {
                            throw AlreadyExists("tag table group", normalized);
                        }
                        {
                            PlcTagTableGroup target = DescendTagTableGroups(software.TagTableGroup, parent, createParents);
                            if (target == null) throw GroupNotFound(parent, ListTagTableGroupPaths(software), "tag table group");
                            target.Groups.Create(leaf);
                        }
                        break;
                }
            }
            catch (ControllerException)
            {
                throw;
            }
            catch (Exception ex)
            {
                throw OpennessFailure("group_create_failed",
                    "The group " + Text.Quote(normalized) + " could not be created: " + ex.Message, ex);
            }

            JsonObject result = new JsonObject();
            result.Add("kind", kind);
            result.Add("groupPath", normalized);
            result.Add("fullPath", normalized);
            result.Add("created", true);
            return result;
        }

        private PlcBlockGroup DescendBlockGroups(PlcBlockGroup root, string path, bool create)
        {
            PlcBlockGroup current = root;
            foreach (string segment in SplitGroupPath(path))
            {
                PlcBlockUserGroup next = null;
                foreach (PlcBlockUserGroup child in current.Groups)
                {
                    string name = SafeString(delegate { return child.Name; });
                    if (string.Equals(name, segment, StringComparison.OrdinalIgnoreCase)) { next = child; break; }
                }
                if (next == null)
                {
                    if (!create) return null;
                    next = current.Groups.Create(segment);
                }
                current = next;
            }
            return current;
        }

        private PlcTypeGroup DescendTypeGroups(PlcTypeGroup root, string path, bool create)
        {
            PlcTypeGroup current = root;
            foreach (string segment in SplitGroupPath(path))
            {
                PlcTypeUserGroup next = null;
                foreach (PlcTypeUserGroup child in current.Groups)
                {
                    string name = SafeString(delegate { return child.Name; });
                    if (string.Equals(name, segment, StringComparison.OrdinalIgnoreCase)) { next = child; break; }
                }
                if (next == null)
                {
                    if (!create) return null;
                    next = current.Groups.Create(segment);
                }
                current = next;
            }
            return current;
        }

        private PlcTagTableGroup DescendTagTableGroups(PlcTagTableGroup root, string path, bool create)
        {
            PlcTagTableGroup current = root;
            foreach (string segment in SplitGroupPath(path))
            {
                PlcTagTableUserGroup next = null;
                foreach (PlcTagTableUserGroup child in current.Groups)
                {
                    string name = SafeString(delegate { return child.Name; });
                    if (string.Equals(name, segment, StringComparison.OrdinalIgnoreCase)) { next = child; break; }
                }
                if (next == null)
                {
                    if (!create) return null;
                    next = current.Groups.Create(segment);
                }
                current = next;
            }
            return current;
        }

        private PlcSoftware ProjectSoftwareOrThrow()
        {
            List<PlcSoftwareRef> all = ListPlcSoftware();
            if (all.Count == 0)
            {
                throw new ControllerException("plc_software_not_found",
                    "The open project contains no PLC software; only PLC program objects can be handled.",
                    DescribeDevices());
            }
            return all[0].Software;
        }

        public PlcTagTable CreateTagTable(PlcSoftware software, string groupPath, string name, bool createGroup, DiagnosticLog log)
        {
            PlcTagTableGroup group = ResolveTagTableGroup(software, groupPath, createGroup, log);
            if (group == null)
            {
                throw GroupNotFound(groupPath, ListTagTableGroupPaths(software), "tag table group");
            }
            try
            {
                return group.TagTables.Create(name);
            }
            catch (Exception ex)
            {
                throw OpennessFailure("object_create_failed",
                    "Creating the tag table " + Text.Quote(name) + " failed: " + ex.Message, ex);
            }
        }

        public PlcTag CreateTag(PlcTagTable table, string name, string dataType, string address)
        {
            try
            {
                // The three-argument overload is the documented way to create a
                // tag with a data type and a logical address; an empty address is
                // accepted by TIA Portal and left to be assigned later.
                return table.Tags.Create(name, dataType ?? "Bool", address ?? string.Empty);
            }
            catch (Exception ex)
            {
                throw OpennessFailure("tag_create_failed",
                    "Creating the tag " + Text.Quote(name) + " failed: " + ex.Message, ex);
            }
        }

        public PlcUserConstant CreateUserConstant(PlcTagTable table, string name, string dataType, string value)
        {
            try
            {
                if (string.IsNullOrEmpty(dataType) && string.IsNullOrEmpty(value))
                {
                    return table.UserConstants.Create(name);
                }
                return table.UserConstants.Create(name, dataType, value);
            }
            catch (Exception ex)
            {
                throw OpennessFailure("constant_create_failed",
                    "Creating the user constant " + Text.Quote(name) + " failed: " + ex.Message, ex);
            }
        }

        public PlcBlock CreateInstanceDb(PlcSoftware software, string groupPath, string name, bool autoNumber, int number,
            string instanceOf, bool createGroup, DiagnosticLog log)
        {
            PlcBlockGroup group = ResolveBlockGroup(software, groupPath, createGroup, log);
            if (group == null)
            {
                throw GroupNotFound(groupPath, ListBlockGroupPaths(software), "block group");
            }
            try
            {
                return group.Blocks.CreateInstanceDB(name, autoNumber, number, instanceOf);
            }
            catch (Exception ex)
            {
                throw OpennessFailure("object_create_failed",
                    "Creating the instance DB " + Text.Quote(name) + " for " + Text.Quote(instanceOf) + " failed: "
                        + ex.Message, ex);
            }
        }

        // ----------------------------------------------------------- deletion

        public void DeleteBlock(PlcBlock block)
        {
            try
            {
                block.Delete();
            }
            catch (Exception ex)
            {
                throw OpennessFailure("delete_failed",
                    "Deleting the block " + Text.Quote(SafeBlockName(block)) + " failed: " + ex.Message, ex);
            }
        }

        public void DeleteType(PlcType type)
        {
            try
            {
                type.Delete();
            }
            catch (Exception ex)
            {
                throw OpennessFailure("delete_failed",
                    "Deleting the PLC type " + Text.Quote(SafeName(type)) + " failed: " + ex.Message, ex);
            }
        }

        public void DeleteTagTable(PlcTagTable table)
        {
            try
            {
                table.Delete();
            }
            catch (Exception ex)
            {
                throw OpennessFailure("delete_failed",
                    "Deleting the tag table " + Text.Quote(SafeTagTableName(table)) + " failed: " + ex.Message, ex);
            }
        }

        public void DeleteTag(PlcTag tag, string tableName)
        {
            try
            {
                tag.Delete();
            }
            catch (Exception ex)
            {
                throw OpennessFailure("delete_failed",
                    "Deleting the tag " + Text.Quote(tableName + "." + SafeString(delegate { return tag.Name; }))
                        + " failed: " + ex.Message, ex);
            }
        }

        public void DeleteUserConstant(PlcUserConstant constant, string tableName)
        {
            try
            {
                constant.Delete();
            }
            catch (Exception ex)
            {
                throw OpennessFailure("delete_failed",
                    "Deleting the user constant " + Text.Quote(tableName + "." + SafeString(delegate { return constant.Name; }))
                        + " failed: " + ex.Message, ex);
            }
        }

        public void DeleteWatchTable(PlcWatchTable table)
        {
            try
            {
                table.Delete();
            }
            catch (Exception ex)
            {
                throw OpennessFailure("table_delete_failed",
                    "Deleting the watch table " + Text.Quote(SafeString(delegate { return table.Name; })) + " failed: "
                        + ex.Message, ex);
            }
        }

        public void DeleteBlockGroup(PlcBlockUserGroup group)
        {
            try
            {
                group.Delete();
            }
            catch (Exception ex)
            {
                throw OpennessFailure("group_not_empty",
                    "Deleting the block group " + Text.Quote(SafeString(delegate { return group.Name; })) + " failed: "
                        + ex.Message + ". TIA Portal refuses to delete a group that still contains objects.",
                    ex);
            }
        }

        public void DeleteTypeGroup(PlcTypeUserGroup group)
        {
            try
            {
                group.Delete();
            }
            catch (Exception ex)
            {
                throw OpennessFailure("group_not_empty",
                    "Deleting the type group " + Text.Quote(SafeString(delegate { return group.Name; })) + " failed: "
                        + ex.Message + ". TIA Portal refuses to delete a group that still contains objects.", ex);
            }
        }

        public void DeleteTagTableGroup(PlcTagTableUserGroup group)
        {
            try
            {
                group.Delete();
            }
            catch (Exception ex)
            {
                throw OpennessFailure("group_not_empty",
                    "Deleting the tag table group " + Text.Quote(SafeString(delegate { return group.Name; })) + " failed: "
                        + ex.Message + ". TIA Portal refuses to delete a group that still contains objects.", ex);
            }
        }

        // --------------------------------------------------------- attributes

        /// <summary>Every attribute with its access mode and current value.</summary>
        public static List<JsonObject> ReadAttributeList(IEngineeringObject target)
        {
            List<JsonObject> items = new List<JsonObject>();
            if (target == null) return items;
            try
            {
                foreach (EngineeringAttributeInfo info in target.GetAttributeInfos())
                {
                    if (info == null) continue;
                    JsonObject item = new JsonObject();
                    item.AddIfPresent("name", info.Name);
                    item.AddIfPresent("accessMode", Convert.ToString(info.AccessMode));
                    object value = TryReadAttribute(target, info.Name);
                    item.Add("value", Values.Printable(value));
                    items.Add(item);
                }
            }
            catch (Exception)
            {
                // Attribute discovery is diagnostic only.
            }
            return items;
        }

        /// <summary>Writes one attribute and reports the before/after pair.</summary>
        public static JsonObject WriteAttribute(IEngineeringObject target, string name, object value)
        {
            JsonObject result = new JsonObject();
            result.Add("attribute", name);
            object before = TryReadAttribute(target, name);
            result.Add("before", Values.Printable(before));
            try
            {
                target.SetAttribute(name, value);
            }
            catch (Exception ex)
            {
                throw OpennessFailure("attribute_write_failed",
                    "Writing the attribute " + Text.Quote(name) + " failed: " + ex.Message, ex);
            }
            object after = TryReadAttribute(target, name);
            result.Add("after", Values.Printable(after));
            result.Add("changed", !Convert.ToString(Values.Printable(before), System.Globalization.CultureInfo.InvariantCulture)
                .Equals(Convert.ToString(Values.Printable(after), System.Globalization.CultureInfo.InvariantCulture),
                    StringComparison.Ordinal));
            return result;
        }

        // --------------------------------------------------------- protection

        /// <summary>
        /// The know-how protection service of one block, or null when the block is
        /// not protectable (the manual lists the conditions; GetService returns
        /// null for a block that does not fulfil them).
        /// </summary>
        public static PlcBlockProtectionProvider ProtectionProviderOf(PlcBlock block, out string reason)
        {
            reason = null;
            try
            {
                PlcBlockProtectionProvider provider = block.GetService<PlcBlockProtectionProvider>();
                if (provider == null)
                {
                    reason = "TIA Portal returned no PlcBlockProtectionProvider for this block; it is not know-how "
                        + "protectable (the manual lists the conditions: code block or global DB, not a CPU-DB, not "
                        + "ProDiag, not an encrypted imported classic block, not online, not read-only).";
                }
                return provider;
            }
            catch (Exception ex)
            {
                reason = "Requesting the PlcBlockProtectionProvider failed: " + ex.Message;
                return null;
            }
        }

        /// <summary>
        /// The characters TIA Portal refuses in a know-how protection password.
        /// The manual asks the caller to check, because Protect accepts anything
        /// and an unremovable protection is the consequence.
        /// </summary>
        public static List<char> InvalidPasswordCharacters(PlcBlockProtectionProvider provider)
        {
            List<char> characters = new List<char>();
            try
            {
                IEnumerable<char> reported = provider.GetInvalidPasswordCharacters();
                if (reported == null) return characters;
                foreach (char character in reported) characters.Add(character);
            }
            catch (Exception)
            {
                // Treat an unreadable list as "nothing known to be invalid".
            }
            return characters;
        }

        public static SecureString ToSecureString(string password)
        {
            SecureString secure = new SecureString();
            foreach (char character in password) secure.AppendChar(character);
            secure.MakeReadOnly();
            return secure;
        }

        // ------------------------------------------------------- source generation

        public void GenerateSourceFile(PlcSoftware software, List<PlcBlock> blocks, List<PlcType> types, string file,
            bool withDependencies)
        {
            string full = Path.GetFullPath(file.Trim().Trim('"'));
            string directory = Path.GetDirectoryName(full);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

            GenerateOptions options = withDependencies ? GenerateOptions.WithDependencies : GenerateOptions.None;
            try
            {
                if (types != null && types.Count > 0)
                {
                    software.ExternalSourceGroup.GenerateSource(types, new FileInfo(full), options);
                }
                else
                {
                    software.ExternalSourceGroup.GenerateSource(blocks, new FileInfo(full), options);
                }
            }
            catch (Exception ex)
            {
                throw OpennessFailure("generate_source_failed",
                    "Generating the source file " + Text.Quote(full) + " failed: " + ex.Message, ex);
            }
        }

        // -------------------------------------------------------- checksum

        /// <summary>
        /// The compiled-program checksum of one PLC software, or <c>null</c> when
        /// TIA reports none.
        ///
        /// V17 exposes it through <c>PlcChecksumProvider</c>, whose checksum property
        /// is named <c>Software</c> (verified against the installed V17 assembly;
        /// newer manuals show a <c>Checksum</c> property that V17 does not have).
        /// The value is empty until the software has been fully compiled and becomes
        /// empty again on the next edit, so an empty value is a state ("compile
        /// first"), not a failure. A service that cannot be obtained at all is also
        /// an empty checksum — the caller reports one coded
        /// <c>checksum_unavailable</c> either way.
        /// </summary>
        public static string ChecksumOf(PlcSoftware software)
        {
            if (software == null) return null;
            PlcChecksumProvider provider;
            try
            {
                provider = software.GetService<PlcChecksumProvider>();
            }
            catch (Exception)
            {
                return null;
            }
            if (provider == null) return null;
            try
            {
                return provider.Software;
            }
            catch (Exception)
            {
                return null;
            }
        }

        // -------------------------------------------------------- fingerprints

        public static List<JsonObject> FingerprintsOf(PlcBlock block, DiagnosticLog log)
        {
            FingerprintProvider provider;
            try
            {
                provider = block.GetService<FingerprintProvider>();
            }
            catch (Exception ex)
            {
                return FingerprintFailure(ex, log);
            }
            return CollectFingerprints(provider, log);
        }

        public static List<JsonObject> FingerprintsOf(PlcType type, DiagnosticLog log)
        {
            FingerprintProvider provider;
            try
            {
                provider = type.GetService<FingerprintProvider>();
            }
            catch (Exception ex)
            {
                return FingerprintFailure(ex, log);
            }
            return CollectFingerprints(provider, log);
        }

        private static List<JsonObject> CollectFingerprints(FingerprintProvider provider, DiagnosticLog log)
        {
            List<JsonObject> items = new List<JsonObject>();
            if (provider == null) return items;
            try
            {
                foreach (Fingerprint fingerprint in provider.GetFingerprints())
                {
                    if (fingerprint == null) continue;
                    JsonObject item = new JsonObject();
                    item.AddIfPresent("id", Convert.ToString(fingerprint.Id));
                    item.AddIfPresent("value", fingerprint.Value);
                    items.Add(item);
                }
            }
            catch (Exception ex)
            {
                // The manual: an inconsistent block throws a recoverable
                // exception instead of returning fingerprints.
                return FingerprintFailure(ex, log);
            }
            return items;
        }

        private static List<JsonObject> FingerprintFailure(Exception ex, DiagnosticLog log)
        {
            List<JsonObject> items = new List<JsonObject>();
            JsonObject failed = new JsonObject();
            failed.Add("error", ex.Message);
            items.Add(failed);
            if (log != null) log.Warning("The fingerprints could not be read: " + ex.Message);
            return items;
        }

        // ------------------------------------------------------------- units

        /// <summary>
        /// The software-unit provider of one PLC. V17 only exposes it for a PLC
        /// that supports software units; otherwise the service is missing and the
        /// caller reports <c>unit_provider_unavailable</c> instead of failing.
        /// </summary>
        public PlcUnitProvider UnitProviderOf(PlcSoftware software, out string reason)
        {
            reason = null;
            try
            {
                PlcUnitProvider provider = software.GetService<PlcUnitProvider>();
                if (provider == null)
                {
                    reason = "TIA Portal returned no PlcUnitProvider for this PLC. Software units need a CPU and "
                        + "firmware that support them; a project without that support exposes no unit provider.";
                }
                return provider;
            }
            catch (Exception ex)
            {
                reason = "Requesting the PlcUnitProvider failed: " + ex.Message;
                return null;
            }
        }

        public List<JsonObject> ReadUnits(PlcUnitProvider provider, string nameFilter, int maxItems, out int total)
        {
            List<JsonObject> items = new List<JsonObject>();
            total = 0;
            foreach (PlcUnit unit in provider.UnitGroup.Units)
            {
                string name = SafeString(delegate { return unit.Name; });
                if (!Matches(nameFilter, name)) continue;
                total++;
                if (items.Count >= maxItems) continue;
                items.Add(DescribeUnit(unit));
            }
            return items;
        }

        /// <summary>
        /// Describes one software unit. Non-static because the nested block, type
        /// and tag table groups reuse the host's own counters.
        /// </summary>
        private JsonObject DescribeUnit(PlcUnit unit)
        {
            JsonObject item = new JsonObject();
            item.AddIfPresent("name", SafeString(delegate { return unit.Name; }));
            item.AddIfPresent("author", SafeString(delegate { return unit.Author; }));
            item.AddIfPresent("comment", CommentText(SafeComment(delegate { return unit.Comment; })));
            item.Add("blockCount", CountBlocks(unit.BlockGroup));
            item.Add("typeCount", CountTypes(unit.TypeGroup));
            item.Add("tagTableCount", CountTagTables(unit.TagTableGroup));
            item.Add("externalSourceCount", CountExternalSources(unit.ExternalSourceGroup));

            List<JsonObject> relations = new List<JsonObject>();
            foreach (PlcUnitRelation relation in unit.Relations)
            {
                JsonObject entry = new JsonObject();
                entry.AddIfPresent("relatedObject", SafeString(delegate { return relation.RelatedObject; }));
                entry.AddIfPresent("relationType", SafeString(delegate { return Convert.ToString(relation.RelationType); }));
                relations.Add(entry);
            }
            item.Add("relationCount", relations.Count);
            item.Add("relations", relations);
            return item;
        }

        private static int CountTypes(PlcTypeGroup group)
        {
            int count = 0;
            foreach (PlcType unused in group.Types) count++;
            foreach (PlcTypeUserGroup child in group.Groups) count += CountTypes(child);
            PlcTypeSystemGroup system = group as PlcTypeSystemGroup;
            if (system != null)
            {
                IEnumerable groups = system.SystemTypeGroups as IEnumerable;
                if (groups != null)
                {
                    foreach (object item in groups)
                    {
                        PlcTypeGroup child = item as PlcTypeGroup;
                        if (child != null) count += CountTypes(child);
                    }
                }
            }
            return count;
        }

        private static int CountTagTables(PlcTagTableGroup group)
        {
            int count = 0;
            foreach (PlcTagTable unused in group.TagTables) count++;
            foreach (PlcTagTableUserGroup child in group.Groups) count += CountTagTables(child);
            return count;
        }

        private static int CountExternalSources(PlcExternalSourceGroup group)
        {
            int count = 0;
            foreach (PlcExternalSource unused in group.ExternalSources) count++;
            foreach (PlcExternalSourceUserGroup child in group.Groups) count += CountExternalSources(child);
            return count;
        }

        public PlcUnit FindUnit(PlcUnitProvider provider, string name)
        {
            try
            {
                return provider.UnitGroup.Units.Find(name);
            }
            catch (Exception)
            {
                return null;
            }
        }

        public PlcUnit CreateUnit(PlcUnitProvider provider, string name)
        {
            try
            {
                return provider.UnitGroup.Units.Create(name);
            }
            catch (Exception ex)
            {
                throw OpennessFailure("unit_create_failed",
                    "Creating the software unit " + Text.Quote(name) + " failed: " + ex.Message, ex);
            }
        }

        public void DeleteUnit(PlcUnit unit)
        {
            try
            {
                unit.Delete();
            }
            catch (Exception ex)
            {
                throw OpennessFailure("unit_delete_failed",
                    "Deleting the software unit " + Text.Quote(SafeString(delegate { return unit.Name; })) + " failed: "
                        + ex.Message, ex);
            }
        }

        public PlcUnitRelation CreateUnitRelation(PlcUnit unit, string relatedObject, string relationTypeName)
        {
            UnitRelationType relationType;
            if (!TryParseRelationType(relationTypeName, out relationType))
            {
                throw new ControllerException("invalid_params",
                    "Unknown relation type " + Text.Quote(relationTypeName)
                        + ". Allowed: software_unit, non_unit_db, to_db.");
            }
            try
            {
                return unit.Relations.Create(relatedObject, relationType);
            }
            catch (Exception ex)
            {
                throw OpennessFailure("relation_create_failed",
                    "Creating the relation to " + Text.Quote(relatedObject) + " failed: " + ex.Message, ex);
            }
        }

        public PlcUnitRelation FindUnitRelation(PlcUnit unit, string relatedObject)
        {
            try
            {
                return unit.Relations.Find(relatedObject);
            }
            catch (Exception)
            {
                return null;
            }
        }

        public void DeleteUnitRelation(PlcUnitRelation relation)
        {
            try
            {
                relation.Delete();
            }
            catch (Exception ex)
            {
                throw OpennessFailure("unit_delete_failed",
                    "Deleting the relation to " + Text.Quote(SafeString(delegate { return relation.RelatedObject; }))
                        + " failed: " + ex.Message, ex);
            }
        }

        public static bool TryParseRelationType(string name, out UnitRelationType parsed)
        {
            parsed = UnitRelationType.SoftwareUnit;
            switch ((name ?? "software_unit").ToLowerInvariant())
            {
                case "software_unit": parsed = UnitRelationType.SoftwareUnit; return true;
                case "non_unit_db": parsed = UnitRelationType.NonUnitDB; return true;
                case "to_db": parsed = UnitRelationType.TODB; return true;
                default: return false;
            }
        }

        // ------------------------------------------------------------- helpers

        /// <summary>Case-insensitive substring filter; an absent filter matches everything.</summary>
        public static bool Matches(string filter, string value)
        {
            if (string.IsNullOrEmpty(filter)) return true;
            if (value == null) return false;
            return value.IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        internal static ControllerException AlreadyExists(string what, string name)
        {
            return new ControllerException("object_already_exists",
                "The " + what + " " + Text.Quote(name) + " already exists.",
                JsonObject.Of("kind", what, "name", name));
        }

        internal static ControllerException GroupNotFound(string path, List<string> available, string what)
        {
            return new ControllerException("group_not_found",
                "The " + what + " " + Text.Quote(path) + " does not exist. Pass create_group/create_parents to create it.",
                JsonObject.Of("group", path, "available", available));
        }
    }
}
