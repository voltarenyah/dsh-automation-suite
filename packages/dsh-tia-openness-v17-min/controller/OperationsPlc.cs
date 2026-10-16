using System;
using System.Collections.Generic;
using System.IO;
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
    /// The manual chapter "Functions for accessing the data of a PLC device":
    /// enumerating and changing blocks, PLC types, tag tables with tags and
    /// constants, external sources, watch and force tables and software units.
    ///
    /// The parameter and payload contract is frozen in
    /// <c>docs/EXTENDED-SURFACE.md</c>.
    /// </summary>
    internal sealed partial class OpennessOperations
    {
        private static readonly string[] PlcObjectCategoryNames =
        {
            "blocks", "types", "tag_tables", "external_sources", "watch_tables", "force_tables", "units",
        };
        private static readonly string[] PlcObjectKindNames =
        {
            "block_group", "type_group", "tag_table_group", "tag_table", "watch_table", "unit", "instance_db",
        };
        private static readonly string[] WatchAndForceActionNames = { "create", "delete", "export", "import" };
        private static readonly string[] WatchAndForceKindNames = { "watch", "force" };
        private static readonly string[] UnitActionNames = { "list", "create", "delete", "relation_create", "relation_delete" };
        private static readonly string[] UnitRelationTypeNames = { "software_unit", "non_unit_db", "to_db" };

        // ------------------------------------------------------- ListPlcObjects

        private JsonObject ListPlcObjects(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            List<string> categories = p.EnumList("categories", PlcObjectCategoryNames);
            bool recursive = p.Bool("recursive", true);
            string nameFilter = p.String("name_filter", null);
            bool includeTags = p.Bool("include_tags", false);
            bool includeConstants = p.Bool("include_constants", false);
            bool includeAttributes = p.Bool("include_attributes", false);
            bool includeFingerprints = p.Bool("include_fingerprints", false);
            int maxItems = p.Int("max_items", DefaultMaxItems);
            if (maxItems <= 0) maxItems = DefaultMaxItems;

            // Exact names select their family on their own: a caller that asks for
            // "the fingerprints of FB_Motor and FC_1" should not also have to
            // remember to repeat the family in categories.
            List<string> blockNames = p.StringList("block_names");
            List<string> typeNames = p.StringList("type_names");
            List<string> tagTableNames = p.StringList("tag_table_names");
            if (blockNames.Count > 0 && !categories.Contains("blocks")) categories.Add("blocks");
            if (typeNames.Count > 0 && !categories.Contains("types")) categories.Add("types");
            if (tagTableNames.Count > 0 && !categories.Contains("tag_tables")) categories.Add("tag_tables");
            if (blockNames.Count == 0 && typeNames.Count == 0 && tagTableNames.Count == 0 && categories.Count == 0)
            {
                categories.AddRange(new[] { "blocks", "types", "tag_tables" });
            }

            PlcSoftwareRef software = _host.FindPlcSoftware(p.String("device_name", null), p.String("software_name", null));

            JsonObject data = new JsonObject();
            data.Add("device", software.DeviceName);
            data.Add("software", software.SoftwareName);
            data.Add("categories", categories);

            JsonObject counts = new JsonObject();
            JsonObject missing = new JsonObject();
            bool truncated = false;

            if (categories.Contains("blocks"))
            {
                JsonObject blocks = _host.ListBlocks(software.Software, recursive, nameFilter, blockNames,
                    includeAttributes, includeFingerprints, maxItems, log);
                data.Add("blocks", blocks);
                counts.Add("blocks", JsonObject.ReadInt(blocks, "count", 0));
                truncated |= JsonObject.ReadBool(blocks, "truncated", false);
                AddMissing(missing, "blocks", blocks);
            }
            if (categories.Contains("types"))
            {
                JsonObject types = _host.ListTypes(software.Software, recursive, nameFilter, typeNames,
                    includeAttributes, includeFingerprints, maxItems, log);
                data.Add("types", types);
                counts.Add("types", JsonObject.ReadInt(types, "count", 0));
                truncated |= JsonObject.ReadBool(types, "truncated", false);
                AddMissing(missing, "types", types);
            }
            if (categories.Contains("tag_tables"))
            {
                JsonObject tables = _host.ListTagTables(software.Software, recursive, nameFilter, tagTableNames,
                    includeTags, includeConstants, maxItems);
                data.Add("tagTables", tables);
                counts.Add("tagTables", JsonObject.ReadInt(tables, "count", 0));
                truncated |= JsonObject.ReadBool(tables, "truncated", false);
                AddMissing(missing, "tagTables", tables);
                int tags = 0;
                int constants = 0;
                foreach (JsonObject table in ItemsOf(tables))
                {
                    tags += ItemListCount(table, "tags");
                    constants += ItemListCount(table, "userConstants") + ItemListCount(table, "systemConstants");
                }
                counts.Add("tags", tags);
                counts.Add("constants", constants);
            }
            if (categories.Contains("external_sources"))
            {
                JsonObject sources = _host.ListExternalSources(software.Software, recursive, nameFilter, maxItems);
                data.Add("externalSources", sources);
                counts.Add("externalSources", JsonObject.ReadInt(sources, "count", 0));
                truncated |= JsonObject.ReadBool(sources, "truncated", false);
            }
            if (categories.Contains("watch_tables") || categories.Contains("force_tables"))
            {
                if (categories.Contains("watch_tables"))
                {
                    JsonObject watch = _host.ListWatchTables(software.Software, "watch", recursive, nameFilter, maxItems);
                    data.Add("watchTables", watch);
                    counts.Add("watchTables", JsonObject.ReadInt(watch, "count", 0));
                    truncated |= JsonObject.ReadBool(watch, "truncated", false);
                }
                if (categories.Contains("force_tables"))
                {
                    JsonObject force = _host.ListWatchTables(software.Software, "force", recursive, nameFilter, maxItems);
                    data.Add("forceTables", force);
                    counts.Add("forceTables", JsonObject.ReadInt(force, "count", 0));
                    truncated |= JsonObject.ReadBool(force, "truncated", false);
                }
                if (recursive) data.Add("watchForceGroups", _host.ListWatchAndForceGroupPaths(software.Software));
            }
            if (categories.Contains("units"))
            {
                string reason;
                PlcUnitProvider provider = _host.UnitProviderOf(software.Software, out reason);
                if (provider == null)
                {
                    data.Add("units", JsonObject.Of("available", false, "count", 0, "items", new List<JsonObject>(),
                        "reason", reason));
                    counts.Add("units", 0);
                }
                else
                {
                    int total;
                    List<JsonObject> units = _host.ReadUnits(provider, nameFilter, maxItems, out total);
                    data.Add("units", JsonObject.Of("available", true, "count", total, "items", units,
                        "truncated", total > units.Count));
                    counts.Add("units", total);
                    truncated |= total > units.Count;
                }
            }

            if (recursive)
            {
                if (categories.Contains("blocks")) data.Add("blockGroups", _host.ListBlockGroupPaths(software.Software));
                if (categories.Contains("types")) data.Add("typeGroups", _host.ListTypeGroupPaths(software.Software));
                if (categories.Contains("tag_tables")) data.Add("tagTableGroups", _host.ListTagTableGroupPaths(software.Software));
            }

            data.Add("counts", counts);
            data.Add("truncated", truncated);
            data.Add("maxItems", maxItems);
            if (missing.Count > 0) data.Add("missing", missing);
            log.Info("Listed the PLC objects of " + software.DisplayName + ": " + DescribeCounts(counts) + ".");
            return data;
        }

        /// <summary>Collects the family-local `missing` lists into one top-level object.</summary>
        private static void AddMissing(JsonObject missing, string family, JsonObject listing)
        {
            object raw = listing == null ? null : listing["missing"];
            System.Collections.IEnumerable enumerable = raw as System.Collections.IEnumerable;
            if (enumerable == null) return;
            List<string> names = new List<string>();
            foreach (object item in enumerable)
            {
                if (item != null) names.Add(Convert.ToString(item));
            }
            if (names.Count > 0) missing.Add(family, names);
        }

        private const int DefaultMaxItems = 200;

        private static List<JsonObject> ItemsOf(JsonObject list) 
        {
            List<JsonObject> items = new List<JsonObject>();
            object raw = list == null ? null : list["items"];
            System.Collections.IEnumerable enumerable = raw as System.Collections.IEnumerable;
            if (enumerable == null) return items;
            foreach (object item in enumerable)
            {
                JsonObject entry = item as JsonObject;
                if (entry != null) items.Add(entry);
            }
            return items;
        }

        private static int ItemListCount(JsonObject item, string key)
        {
            object raw = item == null ? null : item[key];
            System.Collections.IEnumerable enumerable = raw as System.Collections.IEnumerable;
            if (enumerable == null) return 0;
            int count = 0;
            foreach (object unused in enumerable) count++;
            return count;
        }

        private static string DescribeCounts(JsonObject counts)
        {
            List<string> parts = new List<string>();
            foreach (KeyValuePair<string, object> pair in counts)
            {
                parts.Add(pair.Key + "=" + Convert.ToString(pair.Value));
            }
            return string.Join(", ", parts.ToArray());
        }

        // ----------------------------------------------------- CreatePlcObjects

        private JsonObject CreatePlcObjects(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string kind = p.RequiredEnum("kind", PlcObjectKindNames);
            string name = p.String("name", null);
            string groupPath = p.String("group_path", null);
            bool createParents = p.Bool("create_parents", false);
            bool isGroup = kind == "block_group" || kind == "type_group" || kind == "tag_table_group";

            if (isGroup)
            {
                if (string.IsNullOrWhiteSpace(groupPath))
                {
                    throw new ControllerException("invalid_params",
                        "'group_path' is required when kind is " + Text.Quote(kind) + ".");
                }
            }
            else if (string.IsNullOrWhiteSpace(name))
            {
                throw new ControllerException("invalid_params", "'name' is required when kind is " + Text.Quote(kind) + ".");
            }

            PlcSoftwareRef software = _host.FindPlcSoftware(p.String("device_name", null), p.String("software_name", null));
            string normalizedGroup = OpennessHost.NormalizeGroupPath(groupPath);
            string label = isGroup ? normalizedGroup : name;


            progress.Report("create", "Creating the " + kind + " " + Text.Quote(label) + ".");
            JsonObject data = new JsonObject();
            data.Add("kind", kind);
            data.Add("name", label);
            data.AddIfPresent("groupPath", normalizedGroup);
            data.Add("createParents", createParents);
            data.Add("dryRun", false);

            using (TransactionScope scope = _host.BeginTransaction("Create PLC object"))
            {
                switch (kind)
                {
                    case "block_group":
                    case "type_group":
                    case "tag_table_group":
                        {
                            JsonObject created = _host.CreateGroup(software.Software, kind, normalizedGroup, createParents);
                            data.Add("fullPath", JsonObject.ReadString(created, "fullPath", normalizedGroup));
                            break;
                        }
                    case "tag_table":
                        {
                            PlcTagTable table = _host.CreateTagTable(software.Software, normalizedGroup, name, createParents, log);
                            data.Add("fullPath", JoinPath(normalizedGroup, table.Name));
                            break;
                        }
                    case "watch_table":
                        {
                            PlcWatchTable table = _host.CreateWatchTable(software.Software, normalizedGroup, name, createParents, log);
                            data.Add("fullPath", JoinPath(normalizedGroup, table.Name));
                            break;
                        }
                    case "unit":
                        {
                            string reason;
                            PlcUnitProvider provider = _host.UnitProviderOf(software.Software, out reason);
                            if (provider == null)
                            {
                                throw new ControllerException("unit_provider_unavailable", reason);
                            }
                            if (_host.FindUnit(provider, name) != null)
                            {
                                throw OpennessHost.AlreadyExists("software unit", name);
                            }
                            PlcUnit unit = _host.CreateUnit(provider, name);
                            data.Add("fullPath", unit.Name);
                            break;
                        }
                    default:
                        {
                            string instanceOf = p.RequiredString("instance_of");
                            PlcBlock block = _host.CreateInstanceDb(software.Software, normalizedGroup, name,
                                p.Bool("auto_number", true), p.Int("number", 0), instanceOf, createParents, log);
                            data.Add("instanceOf", instanceOf);
                            data.Add("fullPath", JoinPath(normalizedGroup, block.Name));
                            break;
                        }
                }
                scope.Commit();
            }

            data.Add("created", true);
            changes.Add(kind, JsonObject.ReadString(data, "fullPath", label), "created", software.DisplayName);
            log.Info("Created the " + kind + " " + Text.Quote(label) + ".");
            return data;
        }

        private static string JoinPath(string group, string name)
        {
            string normalized = OpennessHost.NormalizeGroupPath(group);
            if (string.IsNullOrEmpty(normalized)) return name;
            return normalized + "/" + name;
        }

        // ----------------------------------------------------- DeletePlcObjects

        private JsonObject DeletePlcObjects(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            bool dryRun = p.Bool("dry_run", true);
            bool strictMissing = p.Bool("strict_missing", true);
            string groupPath = p.String("group_path", null);
            string tableParameter = p.String("tag_table", null);

            PlcSoftwareRef software = _host.FindPlcSoftware(p.String("device_name", null), p.String("software_name", null));
            List<DeleteTarget> targets = new List<DeleteTarget>();

            foreach (string raw in p.StringList("block_names"))
            {
                string group, name;
                OpennessHost.SplitGroupAndName(raw, out group, out name);
                BlockRef found = _host.FindBlock(software.Software, group ?? groupPath, name);
                targets.Add(new DeleteTarget("block", name, found == null ? (group ?? groupPath) : found.GroupPath, found));
            }
            foreach (string raw in p.StringList("type_names"))
            {
                string group, name;
                OpennessHost.SplitGroupAndName(raw, out group, out name);
                PlcTypeRef found = _host.FindType(software.Software, group ?? groupPath, name);
                targets.Add(new DeleteTarget("type", name, found == null ? (group ?? groupPath) : found.GroupPath, found));
            }
            foreach (string raw in p.StringList("tag_table_names"))
            {
                string group, name;
                OpennessHost.SplitGroupAndName(raw, out group, out name);
                PlcTagTableRef found = _host.FindTagTable(software.Software, group ?? groupPath, name);
                targets.Add(new DeleteTarget("tag_table", name, found == null ? (group ?? groupPath) : found.GroupPath, found));
            }
            foreach (string raw in p.StringList("watch_table_names"))
            {
                string group, name;
                OpennessHost.SplitGroupAndName(raw, out group, out name);
                string effectiveGroup = group ?? groupPath;
                PlcWatchTable found = _host.FindWatchTable(software.Software, effectiveGroup, name);
                targets.Add(new DeleteTarget("watch_table", name, effectiveGroup, found));
            }
            foreach (string raw in p.StringList("unit_names"))
            {
                string reason;
                PlcUnitProvider provider = _host.UnitProviderOf(software.Software, out reason);
                if (provider == null)
                {
                    throw new ControllerException("unit_provider_unavailable", reason);
                }
                targets.Add(new DeleteTarget("unit", raw.Trim(), null, _host.FindUnit(provider, raw.Trim())));
            }
            foreach (string raw in p.StringList("block_group_paths"))
            {
                string path = JoinGroup(groupPath, raw);
                PlcBlockUserGroup found = FindBlockGroup(software.Software, path);
                targets.Add(new DeleteTarget("block_group", path, null, found));
            }
            foreach (string raw in p.StringList("type_group_paths"))
            {
                string path = JoinGroup(groupPath, raw);
                PlcTypeUserGroup found = FindTypeGroup(software.Software, path);
                targets.Add(new DeleteTarget("type_group", path, null, found));
            }
            foreach (string raw in p.StringList("tag_table_group_paths"))
            {
                string path = JoinGroup(groupPath, raw);
                PlcTagTableUserGroup found = FindTagTableGroup(software.Software, path);
                targets.Add(new DeleteTarget("tag_table_group", path, null, found));
            }

            List<string> tagNames = p.StringList("tag_names");
            List<string> constantNames = p.StringList("constant_names");
            if (tagNames.Count > 0 || constantNames.Count > 0)
            {
                if (tagNames.Count > 0)
                {
                    foreach (string raw in tagNames)
                    {
                        string tableName = tableParameter;
                        string name = raw;
                        if (string.IsNullOrEmpty(tableName)) OpennessHost.SplitTableAndName(raw, out tableName, out name);
                        PlcTag tag = FindTag(software.Software, groupPath, tableName, name, out PlcTagTable table);
                        targets.Add(new DeleteTarget("tag", tableName + "." + name, table == null ? null : table.Name, tag));
                    }
                }
                if (constantNames.Count > 0)
                {
                    foreach (string raw in constantNames)
                    {
                        string tableName = tableParameter;
                        string name = raw;
                        if (string.IsNullOrEmpty(tableName)) OpennessHost.SplitTableAndName(raw, out tableName, out name);
                        PlcUserConstant constant = FindUserConstant(software.Software, groupPath, tableName, name, out PlcTagTable table);
                        targets.Add(new DeleteTarget("user_constant", tableName + "." + name,
                            table == null ? null : table.Name, constant));
                    }
                }
            }

            if (targets.Count == 0)
            {
                throw new ControllerException("invalid_params",
                    "delete_plc_objects needs at least one object to delete (block_names, type_names, tag_table_names, "
                        + "watch_table_names, unit_names, *_group_paths, tag_names or constant_names).");
            }

            List<JsonObject> planned = new List<JsonObject>();
            List<string> missing = new List<string>();
            foreach (DeleteTarget target in targets)
            {
                JsonObject entry = new JsonObject();
                entry.Add("kind", target.Kind);
                entry.Add("name", target.Name);
                entry.AddIfPresent("group", OpennessHost.NormalizeGroupPath(target.Group));
                entry.Add("exists", target.Handle != null);
                planned.Add(entry);
                if (target.Handle == null) missing.Add(target.Kind + " " + target.Name);
            }

            if (missing.Count > 0 && strictMissing)
            {
                throw new ControllerException("object_not_found",
                    "These objects were not found: " + string.Join(", ", missing.ToArray())
                        + ". Pass strict_missing=false to skip them, or check the names with list_plc_objects.",
                    JsonObject.Of("missing", missing, "available", AvailableNames(software.Software), "planned", planned));
            }

            if (dryRun)
            {
                JsonObject plan = new JsonObject();
                plan.Add("planned", planned);
                plan.Add("missing", missing);
                plan.Add("wouldDelete", CountExisting(targets));
                plan.Add("wouldWrite", true);
                plan.Add("dryRun", true);
                log.Info("Dry run: nothing was deleted. " + CountExisting(targets) + " object(s) would be removed.");
                return plan;
            }

            progress.Report("delete", "Deleting " + CountExisting(targets) + " PLC object(s).");
            List<JsonObject> deleted = new List<JsonObject>();
            using (TransactionScope scope = _host.BeginTransaction("Delete PLC objects"))
            {
                foreach (DeleteTarget target in targets)
                {
                    if (target.Handle == null) continue;
                    DeleteOne(target);
                    JsonObject entry = new JsonObject();
                    entry.Add("kind", target.Kind);
                    entry.Add("name", target.Name);
                    entry.AddIfPresent("group", OpennessHost.NormalizeGroupPath(target.Group));
                    deleted.Add(entry);
                    changes.Add(target.Kind, target.Name, "deleted", software.DisplayName);
                }
                scope.Commit();
            }

            JsonObject data = new JsonObject();
            data.Add("planned", planned);
            data.Add("deleted", deleted);
            data.Add("missing", missing);
            data.Add("counts", JsonObject.Of("deleted", deleted.Count, "missing", missing.Count));
            data.Add("dryRun", false);
            log.Info("Deleted " + deleted.Count + " PLC object(s)" + (missing.Count > 0 ? ", skipped " + missing.Count : "") + ".");
            return data;
        }

        private static int CountExisting(List<DeleteTarget> targets)
        {
            int count = 0;
            foreach (DeleteTarget target in targets) if (target.Handle != null) count++;
            return count;
        }

        private void DeleteOne(DeleteTarget target)
        {
            switch (target.Kind)
            {
                case "block": _host.DeleteBlock((PlcBlock)target.Handle); break;
                case "type": _host.DeleteType((PlcType)target.Handle); break;
                case "tag_table": _host.DeleteTagTable((PlcTagTable)target.Handle); break;
                case "tag": _host.DeleteTag((PlcTag)target.Handle, target.Group); break;
                case "user_constant": _host.DeleteUserConstant((PlcUserConstant)target.Handle, target.Group); break;
                case "watch_table": _host.DeleteWatchTable((PlcWatchTable)target.Handle); break;
                case "block_group": _host.DeleteBlockGroup((PlcBlockUserGroup)target.Handle); break;
                case "type_group": _host.DeleteTypeGroup((PlcTypeUserGroup)target.Handle); break;
                case "tag_table_group": _host.DeleteTagTableGroup((PlcTagTableUserGroup)target.Handle); break;
                case "unit": _host.DeleteUnit((PlcUnit)target.Handle); break;
                default:
                    throw new ControllerException("invalid_params", "Unknown object kind " + Text.Quote(target.Kind) + ".");
            }
        }

        private static string JoinGroup(string prefix, string path)
        {
            string normalizedPrefix = OpennessHost.NormalizeGroupPath(prefix);
            string normalizedPath = OpennessHost.NormalizeGroupPath(path);
            if (normalizedPrefix.Length == 0) return normalizedPath;
            if (normalizedPath.Length == 0) return normalizedPrefix;
            return normalizedPrefix + "/" + normalizedPath;
        }

        private PlcBlockUserGroup FindBlockGroup(PlcSoftware software, string path)
        {
            PlcBlockGroup current = software.BlockGroup;
            foreach (string segment in SplitPath(path))
            {
                PlcBlockUserGroup next = null;
                foreach (PlcBlockUserGroup child in current.Groups)
                {
                    if (NameOf(child).Equals(segment, StringComparison.OrdinalIgnoreCase)) { next = child; break; }
                }
                if (next == null) return null;
                current = next;
            }
            return current as PlcBlockUserGroup;
        }

        private PlcTypeUserGroup FindTypeGroup(PlcSoftware software, string path)
        {
            PlcTypeGroup current = software.TypeGroup;
            foreach (string segment in SplitPath(path))
            {
                PlcTypeUserGroup next = null;
                foreach (PlcTypeUserGroup child in current.Groups)
                {
                    if (NameOf(child).Equals(segment, StringComparison.OrdinalIgnoreCase)) { next = child; break; }
                }
                if (next == null) return null;
                current = next;
            }
            return current as PlcTypeUserGroup;
        }

        private PlcTagTableUserGroup FindTagTableGroup(PlcSoftware software, string path)
        {
            PlcTagTableGroup current = software.TagTableGroup;
            foreach (string segment in SplitPath(path))
            {
                PlcTagTableUserGroup next = null;
                foreach (PlcTagTableUserGroup child in current.Groups)
                {
                    if (NameOf(child).Equals(segment, StringComparison.OrdinalIgnoreCase)) { next = child; break; }
                }
                if (next == null) return null;
                current = next;
            }
            return current as PlcTagTableUserGroup;
        }

        private static string NameOf(IEngineeringObject target)
        {
            object value = OpennessHost.TryReadAttribute(target, "Name");
            return value == null ? string.Empty : Convert.ToString(value);
        }

        private static string[] SplitPath(string path)
        {
            return OpennessHost.NormalizeGroupPath(path).Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries);
        }

        private PlcTag FindTag(PlcSoftware software, string groupPath, string tableName, string name, out PlcTagTable table)
        {
            table = null;
            if (string.IsNullOrEmpty(tableName)) return null;
            PlcTagTableRef reference = _host.FindTagTable(software, groupPath, tableName);
            if (reference == null) return null;
            table = reference.Table;
            try
            {
                return table.Tags.Find(name);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private PlcUserConstant FindUserConstant(PlcSoftware software, string groupPath, string tableName, string name,
            out PlcTagTable table)
        {
            table = null;
            if (string.IsNullOrEmpty(tableName)) return null;
            PlcTagTableRef reference = _host.FindTagTable(software, groupPath, tableName);
            if (reference == null) return null;
            table = reference.Table;
            try
            {
                return table.UserConstants.Find(name);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private List<string> AvailableNames(PlcSoftware software)
        {
            List<string> available = new List<string>();
            foreach (BlockRef reference in _host.CollectBlocks(software, null, true, false)) available.Add("block " + reference.Name);
            foreach (PlcTypeRef reference in _host.CollectTypes(software, null, true, false)) available.Add("type " + reference.Name);
            foreach (PlcTagTableRef reference in _host.CollectTagTables(software, null, true, false)) available.Add("tag_table " + reference.Name);
            available.Sort(StringComparer.OrdinalIgnoreCase);
            return available;
        }

        private sealed class DeleteTarget
        {
            public DeleteTarget(string kind, string name, string group, object handle)
            {
                Kind = kind;
                Name = name;
                Group = group;
                Handle = handle;
            }

            public readonly string Kind;
            public readonly string Name;
            public readonly string Group;
            public readonly object Handle;
        }

        // ------------------------------------------------------------ WriteTags

        private JsonObject WriteTags(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string tableName = p.RequiredString("tag_table");
            string groupPath = p.String("group_path", null);
            List<JsonArgs> tags = p.ObjectList("tags");
            List<JsonArgs> constants = p.ObjectList("constants");
            List<string> deleteTags = p.StringList("delete_tags");
            List<string> deleteConstants = p.StringList("delete_constants");
            bool dryRun = p.Bool("dry_run", true);

            if (tags.Count == 0 && constants.Count == 0 && deleteTags.Count == 0 && deleteConstants.Count == 0)
            {
                throw new ControllerException("invalid_params",
                    "write_tags needs at least one of 'tags', 'constants', 'delete_tags' or 'delete_constants'.");
            }

            PlcSoftwareRef software = _host.FindPlcSoftware(p.String("device_name", null), p.String("software_name", null));
            PlcTagTableRef reference = _host.FindTagTable(software.Software, groupPath, tableName);
            if (reference == null)
            {
                throw new ControllerException("tag_table_not_found",
                    "The tag table " + Text.Quote(tableName) + " does not exist.",
                    JsonObject.Of("tagTable", tableName, "group", OpennessHost.NormalizeGroupPath(groupPath),
                        "available", AvailableTagTables(software.Software)));
            }
            PlcTagTable table = reference.Table;

            JsonObject data = new JsonObject();
            data.Add("tagTable", tableName);
            data.AddIfPresent("groupPath", OpennessHost.NormalizeGroupPath(groupPath));
            data.Add("dryRun", false);

            if (dryRun)
            {
                List<JsonObject> tagPlan = new List<JsonObject>();
                foreach (JsonArgs entry in tags)
                {
                    string name = entry.RequiredString("name");
                    PlcTag existing = SafeFindTag(table, name);
                    tagPlan.Add(JsonObject.Of("name", name, "action", existing == null ? "create" : "update",
                        "exists", existing != null));
                }
                List<JsonObject> constantPlan = new List<JsonObject>();
                foreach (JsonArgs entry in constants)
                {
                    string name = entry.RequiredString("name");
                    PlcUserConstant existing = SafeFindConstant(table, name);
                    constantPlan.Add(JsonObject.Of("name", name, "action", existing == null ? "create" : "update",
                        "exists", existing != null));
                }
                data.Add("tags", tagPlan);
                data.Add("constants", constantPlan);
                data.Add("deleteTags", deleteTags);
                data.Add("deleteConstants", deleteConstants);
                data.Add("wouldWrite", true);
                log.Info("Dry run: no tag was written. " + tagPlan.Count + " tag(s) and " + constantPlan.Count
                    + " constant(s) would be written, " + (deleteTags.Count + deleteConstants.Count) + " deleted.");
                return data;
            }

            progress.Report("tags", "Writing tags of " + tableName + ".");
            List<JsonObject> tagResults = new List<JsonObject>();
            List<JsonObject> constantResults = new List<JsonObject>();
            List<string> deletedTags = new List<string>();
            List<string> deletedConstants = new List<string>();

            using (TransactionScope scope = _host.BeginTransaction("Write PLC tags"))
            {
                foreach (string name in deleteTags)
                {
                    PlcTag tag = SafeFindTag(table, name);
                    if (tag == null)
                    {
                        throw new ControllerException("tag_not_found",
                            "The tag " + Text.Quote(tableName + "." + name) + " does not exist.",
                            JsonObject.Of("tagTable", tableName, "tag", name));
                    }
                    _host.DeleteTag(tag, tableName);
                    deletedTags.Add(name);
                    changes.Add("tag", tableName + "." + name, "deleted");
                }
                foreach (string name in deleteConstants)
                {
                    PlcUserConstant constant = SafeFindConstant(table, name);
                    if (constant == null)
                    {
                        throw new ControllerException("tag_not_found",
                            "The user constant " + Text.Quote(tableName + "." + name) + " does not exist.",
                            JsonObject.Of("tagTable", tableName, "constant", name));
                    }
                    _host.DeleteUserConstant(constant, tableName);
                    deletedConstants.Add(name);
                    changes.Add("constant", tableName + "." + name, "deleted");
                }

                foreach (JsonArgs entry in tags)
                {
                    tagResults.Add(WriteOneTag(table, tableName, entry, changes));
                }
                foreach (JsonArgs entry in constants)
                {
                    constantResults.Add(WriteOneConstant(table, tableName, entry, changes));
                }
                scope.Commit();
            }

            data.Add("tags", tagResults);
            data.Add("constants", constantResults);
            data.Add("deletedTags", deletedTags);
            data.Add("deletedConstants", deletedConstants);
            data.Add("counts", JsonObject.Of(
                "created", CountAction(tagResults, "created") + CountAction(constantResults, "created"),
                "updated", CountAction(tagResults, "updated") + CountAction(constantResults, "updated"),
                "unchanged", CountAction(tagResults, "unchanged") + CountAction(constantResults, "unchanged"),
                "deleted", deletedTags.Count + deletedConstants.Count));
            log.Info("Wrote " + (tags.Count + constants.Count) + " tag/constant entr(y/ies) in " + tableName + ".");
            return data;
        }

        private static int CountAction(List<JsonObject> results, string action)
        {
            int count = 0;
            foreach (JsonObject item in results)
            {
                if (string.Equals(JsonObject.ReadString(item, "action", null), action, StringComparison.Ordinal)) count++;
            }
            return count;
        }

        private PlcTag SafeFindTag(PlcTagTable table, string name)
        {
            try
            {
                return table.Tags.Find(name);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private PlcUserConstant SafeFindConstant(PlcTagTable table, string name)
        {
            try
            {
                return table.UserConstants.Find(name);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private JsonObject WriteOneTag(PlcTagTable table, string tableName, JsonArgs entry, ChangeLog changes)
        {
            string name = entry.RequiredString("name");
            JsonObject result = new JsonObject();
            result.Add("name", name);

            PlcTag tag = SafeFindTag(table, name);
            bool exists = tag != null;
            if (!exists)
            {
                if (!entry.Bool("create", true))
                {
                    result.Add("action", "skipped");
                    result.Add("reason", "The tag does not exist and 'create' is false.");
                    return result;
                }
                tag = _host.CreateTag(table, name, entry.String("data_type", "Bool"), entry.String("logical_address", string.Empty));
                result.Add("action", "created");
                List<JsonObject> creation = new List<JsonObject>();
                creation.Add(JsonObject.Of("attribute", "Name", "before", null, "after", name, "changed", true));
                result.Add("changes", creation);
                changes.Add("tag", tableName + "." + name, "created");
                return result;
            }

            string action = "unchanged";
            List<JsonObject> attributeChanges = new List<JsonObject>();
            if (entry.Bool("update", true))
            {
                if (entry.Has("data_type")) ApplyTagAttribute(tag, "DataTypeName", entry.String("data_type", null), attributeChanges);
                if (entry.Has("logical_address")) ApplyTagAttribute(tag, "LogicalAddress", entry.String("logical_address", null), attributeChanges);
                if (entry.Has("external_accessible")) ApplyTagAttribute(tag, "ExternalAccessible", entry.Bool("external_accessible", false), attributeChanges);
                if (entry.Has("external_visible")) ApplyTagAttribute(tag, "ExternalVisible", entry.Bool("external_visible", false), attributeChanges);
                if (entry.Has("external_writable")) ApplyTagAttribute(tag, "ExternalWritable", entry.Bool("external_writable", false), attributeChanges);
                if (entry.Has("comment"))
                {
                    JsonObject comment = _host.WriteMultilingualText(SafeTagComment(tag), entry.String("comment", null));
                    if (JsonObject.ReadBool(comment, "changed", false))
                    {
                        attributeChanges.Add(JsonObject.Of("attribute", "Comment",
                            "before", JsonObject.ReadString(comment, "before", null),
                            "after", JsonObject.ReadString(comment, "after", null), "changed", true));
                    }
                    else if (comment["reason"] != null)
                    {
                        result.Add("commentSkipped", comment["reason"]);
                    }
                }
                if (attributeChanges.Count > 0) action = "updated";
            }

            result.Add("action", action);
            result.Add("changes", attributeChanges);
            if (action == "updated")
            {
                foreach (JsonObject change in attributeChanges)
                {
                    changes.Add("tag", tableName + "." + name, "updated",
                        JsonObject.ReadString(change, "attribute", "?") + ": "
                            + JsonObject.ReadString(change, "before", "?") + " -> " + JsonObject.ReadString(change, "after", "?"));
                }
            }
            return result;
        }

        private static MultilingualText SafeTagComment(PlcTag tag)
        {
            try
            {
                return tag.Comment;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static void ApplyTagAttribute(PlcTag tag, string attribute, object value, List<JsonObject> target)
        {
            object before = OpennessHost.TryReadAttribute(tag, attribute);
            string beforeText = Convert.ToString(Values.Printable(before));
            string afterText = Convert.ToString(Values.Printable(value));
            if (string.Equals(beforeText, afterText, StringComparison.Ordinal)) return;
            JsonObject written = OpennessHost.WriteAttribute(tag, attribute, value);
            target.Add(written);
        }

        private JsonObject WriteOneConstant(PlcTagTable table, string tableName, JsonArgs entry, ChangeLog changes)
        {
            string name = entry.RequiredString("name");
            JsonObject result = new JsonObject();
            result.Add("name", name);

            PlcUserConstant constant = SafeFindConstant(table, name);
            if (constant == null)
            {
                if (!entry.Bool("create", true))
                {
                    result.Add("action", "skipped");
                    result.Add("reason", "The user constant does not exist and 'create' is false.");
                    return result;
                }
                constant = _host.CreateUserConstant(table, name, entry.String("data_type", null), entry.String("value", null));
                List<JsonObject> written = TryApplyConstantAttributes(constant, entry);
                result.Add("action", "created");
                result.Add("changes", written);
                changes.Add("constant", tableName + "." + name, "created");
                return result;
            }

            List<JsonObject> constantChanges = entry.Bool("update", true) ? TryApplyConstantAttributes(constant, entry) : new List<JsonObject>();
            result.Add("action", constantChanges.Count > 0 ? "updated" : "unchanged");
            result.Add("changes", constantChanges);
            if (constantChanges.Count > 0) changes.Add("constant", tableName + "." + name, "updated");
            return result;
        }

        private List<JsonObject> TryApplyConstantAttributes(PlcUserConstant constant, JsonArgs entry)
        {
            List<JsonObject> written = new List<JsonObject>();
            if (entry.Has("data_type")) ApplyConstantAttribute(constant, "DataTypeName", entry.String("data_type", null), written);
            if (entry.Has("value")) ApplyConstantAttribute(constant, "Value", entry.String("value", null), written);
            if (entry.Has("comment"))
            {
                JsonObject comment = _host.WriteMultilingualText(SafeConstantComment(constant), entry.String("comment", null));
                if (JsonObject.ReadBool(comment, "changed", false))
                {
                    written.Add(JsonObject.Of("attribute", "Comment",
                        "before", JsonObject.ReadString(comment, "before", null),
                        "after", JsonObject.ReadString(comment, "after", null), "changed", true));
                }
            }
            return written;
        }

        private static MultilingualText SafeConstantComment(PlcUserConstant constant)
        {
            try
            {
                return constant.Comment;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static void ApplyConstantAttribute(PlcUserConstant constant, string attribute, object value,
            List<JsonObject> target)
        {
            object before = OpennessHost.TryReadAttribute(constant, attribute);
            if (string.Equals(Convert.ToString(Values.Printable(before)), Convert.ToString(Values.Printable(value)),
                StringComparison.Ordinal)) return;
            target.Add(OpennessHost.WriteAttribute(constant, attribute, value));
        }

        private List<string> AvailableTagTables(PlcSoftware software)
        {
            List<string> names = new List<string>();
            foreach (PlcTagTableRef reference in _host.CollectTagTables(software, null, true, false)) names.Add(reference.Name);
            names.Sort(StringComparer.OrdinalIgnoreCase);
            return names;
        }

        // --------------------------------------------------- SetBlockAttributes

        private JsonObject SetBlockAttributes(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string target = p.Enum("target", new[] { "block", "type" }, "block");
            List<string> names = p.StringList("names");
            if (names.Count == 0)
            {
                throw new ControllerException("invalid_params", "'names' is required and must not be empty.");
            }
            JsonArgs attributes = p.Object("attributes");
            int attributeCount = 0;
            foreach (string unused in attributes.Keys) attributeCount++;
            if (attributeCount == 0)
            {
                throw new ControllerException("invalid_params", "'attributes' must contain at least one attribute name.");
            }
            JsonArgs valueTypes = p.Object("value_types");
            string groupPath = p.String("group_path", null);
            bool dryRun = p.Bool("dry_run", true);

            PlcSoftwareRef software = _host.FindPlcSoftware(p.String("device_name", null), p.String("software_name", null));

            // Resolve every target first so a typo cannot leave a half-applied set.
            List<object> resolved = new List<object>();
            List<string> groups = new List<string>();
            List<string> missing = new List<string>();
            foreach (string raw in names)
            {
                string group, name;
                OpennessHost.SplitGroupAndName(raw, out group, out name);
                object handle;
                if (target == "type")
                {
                    PlcTypeRef found = _host.FindType(software.Software, group ?? groupPath, name);
                    handle = found == null ? null : found.Type;
                    groups.Add(found == null ? (group ?? groupPath) : found.GroupPath);
                }
                else
                {
                    BlockRef found = _host.FindBlock(software.Software, group ?? groupPath, name);
                    handle = found == null ? null : found.Block;
                    groups.Add(found == null ? (group ?? groupPath) : found.GroupPath);
                }
                if (handle == null) missing.Add(name);
                resolved.Add(handle);
            }

            if (missing.Count > 0)
            {
                throw new ControllerException(target == "type" ? "type_not_found" : "block_not_found",
                    "These " + target + "s were not found: " + string.Join(", ", missing.ToArray()) + ".",
                    JsonObject.Of("missing", missing,
                        "available", target == "type"
                            ? AvailableNames(software.Software)
                            : AvailableNames(software.Software)));
            }

            JsonObject data = new JsonObject();
            data.Add("target", target);
            JsonObject attributePayload = new JsonObject();
            foreach (string attribute in attributes.Keys)
            {
                attributePayload.Add(attribute, Values.Printable(attributes.Raw(attribute)));
            }
            data.Add("attributes", attributePayload);
            data.Add("dryRun", false);

            if (dryRun)
            {
                List<JsonObject> planned = new List<JsonObject>();
                for (int i = 0; i < resolved.Count; i++)
                {
                    IEngineeringObject engineering = (IEngineeringObject)resolved[i];
                    List<JsonObject> changesForObject = new List<JsonObject>();
                    foreach (string attribute in attributes.Keys)
                    {
                        object converted = Values.Convert(attributes.Raw(attribute), valueTypes.String(attribute, "auto"), attribute);
                        JsonObject entry = new JsonObject();
                        entry.Add("attribute", attribute);
                        entry.Add("before", Values.Printable(OpennessHost.TryReadAttribute(engineering, attribute)));
                        entry.Add("after", Values.Printable(converted));
                        entry.Add("readOnly", OpennessHost.IsAttributeKnownReadOnly(engineering, attribute));
                        changesForObject.Add(entry);
                    }
                    planned.Add(JsonObject.Of("name", names[i], "group", OpennessHost.NormalizeGroupPath(groups[i]),
                        "changes", changesForObject));
                }
                data.Add("applied", planned);
                data.Add("wouldWrite", true);
                log.Info("Dry run: no attribute was written for " + resolved.Count + " " + target + "(s).");
                return data;
            }

            progress.Report("attributes", "Writing attributes of " + resolved.Count + " " + target + "(s).");
            List<JsonObject> applied = new List<JsonObject>();
            using (TransactionScope scope = _host.BeginTransaction("Set object attributes"))
            {
                for (int i = 0; i < resolved.Count; i++)
                {
                    IEngineeringObject engineering = (IEngineeringObject)resolved[i];
                    List<JsonObject> changesForObject = new List<JsonObject>();
                    foreach (string attribute in attributes.Keys)
                    {
                        if (OpennessHost.IsAttributeKnownReadOnly(engineering, attribute))
                        {
                            throw new ControllerException("attribute_not_writeable",
                                "The attribute " + Text.Quote(attribute) + " of " + Text.Quote(names[i])
                                    + " is read-only: GetAttributeInfos reports no write access for it.",
                                JsonObject.Of("object", names[i], "attribute", attribute));
                        }
                        object converted = Values.Convert(attributes.Raw(attribute), valueTypes.String(attribute, "auto"), attribute);
                        JsonObject written = OpennessHost.WriteAttribute(engineering, attribute, converted);
                        changesForObject.Add(written);
                        if (JsonObject.ReadBool(written, "changed", false))
                        {
                            changes.Add(target, names[i], "attribute_set",
                                attribute + ": " + JsonObject.ReadString(written, "before", "?")
                                    + " -> " + JsonObject.ReadString(written, "after", "?"));
                        }
                    }
                    applied.Add(JsonObject.Of("name", names[i], "group", OpennessHost.NormalizeGroupPath(groups[i]),
                        "changes", changesForObject));
                }
                scope.Commit();
            }

            data.Add("applied", applied);
            log.Info("Wrote attributes on " + applied.Count + " " + target + "(s).");
            return data;
        }

        // --------------------------------------------------------- ProtectBlocks

        private JsonObject ProtectBlocks(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            List<string> blockNames = p.StringList("block_names");
            if (blockNames.Count == 0)
            {
                throw new ControllerException("invalid_params", "'block_names' is required and must not be empty.");
            }
            string action = p.RequiredEnum("action", new[] { "protect", "unprotect" });
            string password = p.RequiredString("password");
            string groupPath = p.String("group_path", null);
            bool dryRun = p.Bool("dry_run", true);
            bool protect = string.Equals(action, "protect", StringComparison.Ordinal);

            PlcSoftwareRef software = _host.FindPlcSoftware(p.String("device_name", null), p.String("software_name", null));

            List<BlockRef> blocks = new List<BlockRef>();
            List<string> missing = new List<string>();
            foreach (string raw in blockNames)
            {
                string group, name;
                OpennessHost.SplitGroupAndName(raw, out group, out name);
                BlockRef found = _host.FindBlock(software.Software, group ?? groupPath, name);
                if (found == null) missing.Add(name); else blocks.Add(found);
            }
            if (missing.Count > 0)
            {
                throw new ControllerException("block_not_found",
                    "These blocks were not found: " + string.Join(", ", missing.ToArray()) + ".",
                    JsonObject.Of("missing", missing, "available", AvailableNames(software.Software)));
            }

            JsonObject data = new JsonObject();
            data.Add("action", action);
            data.Add("passwordProvided", password.Length > 0);
            data.Add("dryRun", false);

            if (dryRun)
            {
                List<JsonObject> planned = new List<JsonObject>();
                foreach (BlockRef reference in blocks)
                {
                    string reason;
                    PlcBlockProtectionProvider provider = OpennessHost.ProtectionProviderOf(reference.Block, out reason);
                    JsonObject entry = new JsonObject();
                    entry.Add("name", reference.Name);
                    entry.AddIfPresent("group", OpennessHost.NormalizeGroupPath(reference.GroupPath));
                    entry.Add("protectionAvailable", provider != null);
                    entry.AddIfPresent("reason", reason);
                    entry.Add("isKnowHowProtected", OpennessHost.ReadBoolAttribute(reference.Block, "IsKnowHowProtected"));
                    planned.Add(entry);
                }
                data.Add("planned", planned);
                data.Add("wouldWrite", true);
                log.Info("Dry run: no block protection was changed.");
                return data;
            }

            progress.Report("protect", (protect ? "Protecting " : "Unprotecting ") + blocks.Count + " block(s).");
            List<JsonObject> protectedBlocks = new List<JsonObject>();
            List<JsonObject> failed = new List<JsonObject>();
            using (TransactionScope scope = _host.BeginTransaction(protect ? "Protect blocks" : "Unprotect blocks"))
            {
                foreach (BlockRef reference in blocks)
                {
                    string reason;
                    PlcBlockProtectionProvider provider = OpennessHost.ProtectionProviderOf(reference.Block, out reason);
                    if (provider == null)
                    {
                        failed.Add(JsonObject.Of("name", reference.Name, "code", "protection_unavailable", "message", reason));
                        continue;
                    }

                    IList<char> invalid = OpennessHost.InvalidPasswordCharacters(provider);
                    char? offender = null;
                    foreach (char character in password)
                    {
                        if (invalid.Contains(character)) { offender = character; break; }
                    }
                    if (offender.HasValue)
                    {
                        throw new ControllerException("invalid_params",
                            "The password contains a character that TIA Portal refuses for know-how protection: 0x"
                                + ((int)offender.Value).ToString("X4") + ".",
                            JsonObject.Of("block", reference.Name, "invalidCharacters",
                                Convert.ToString(offender.Value)));
                    }

                    try
                    {
                        // The SecureString is created per block: Protect/Unprotect
                        // consume it and it is never echoed back in the payload.
                        using (System.Security.SecureString secure = OpennessHost.ToSecureString(password))
                        {
                            if (protect) provider.Protect(secure); else provider.Unprotect(secure);
                        }
                    }
                    catch (Exception ex)
                    {
                        failed.Add(JsonObject.Of("name", reference.Name, "code",
                            protect ? "protect_failed" : "unprotect_failed", "message", ex.Message));
                        changes.Add("block", reference.Name, "protection_failed", ex.Message);
                        continue;
                    }

                    protectedBlocks.Add(JsonObject.Of("name", reference.Name,
                        "group", OpennessHost.NormalizeGroupPath(reference.GroupPath)));
                    changes.Add("block", reference.Name, protect ? "protected" : "unprotected");
                }
                scope.Commit();
            }

            data.Add("protected", protectedBlocks);
            data.Add("failed", failed);
            data.Add("counts", JsonObject.Of("protected", protectedBlocks.Count, "failed", failed.Count));
            if (protectedBlocks.Count == 0 && failed.Count > 0)
            {
                JsonObject first = failed[0];
                throw new ControllerException(JsonObject.ReadString(first, "code", "protect_failed"),
                    "No block could be " + (protect ? "protected" : "unprotected") + ": "
                        + JsonObject.ReadString(first, "message", "?"),
                    JsonObject.Of("failures", failed), data);
            }
            log.Info((protect ? "Protected " : "Unprotected ") + protectedBlocks.Count + " block(s); "
                + failed.Count + " failed.");
            return data;
        }

        // -------------------------------------------------------- GenerateSource

        private JsonObject GenerateSource(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string outputFile = p.RequiredString("output_file");
            List<string> blockNames = p.StringList("block_names");
            List<string> typeNames = p.StringList("type_names");
            bool withDependencies = p.Bool("with_dependencies", false);
            bool overwrite = p.Bool("overwrite", false);

            if (blockNames.Count == 0 && typeNames.Count == 0)
            {
                throw new ControllerException("invalid_params",
                    "generate_source needs 'block_names' or 'type_names' (or both).");
            }

            string full = Path.GetFullPath(outputFile.Trim().Trim('"'));
            string extension = Path.GetExtension(full).ToLowerInvariant();
            string[] allowed = { ".scl", ".awl", ".db", ".udt" };
            bool extensionOk = false;
            foreach (string candidate in allowed) if (candidate == extension) extensionOk = true;
            if (!extensionOk)
            {
                throw new ControllerException("invalid_params",
                    "The manual only allows .scl (SCL blocks), .awl (STL blocks), .db (data blocks) and .udt (PLC types); "
                        + "the file ends in " + Text.Quote(extension) + ".",
                    JsonObject.Of("outputFile", full, "allowedExtensions", allowed));
            }
            if (typeNames.Count > 0 && blockNames.Count > 0 && extension != ".udt")
            {
                throw new ControllerException("invalid_params",
                    "Blocks and PLC types cannot share one source file: types need the .udt extension, blocks need "
                        + ".scl/.awl/.db. Generate them into two files.",
                    JsonObject.Of("outputFile", full, "blockCount", blockNames.Count, "typeCount", typeNames.Count));
            }
            if (File.Exists(full) && !overwrite)
            {
                throw new ControllerException("file_exists",
                    "The file " + Text.Quote(full) + " already exists; pass overwrite=true to replace it "
                        + "(the manual: Openness throws when a file of the same name exists).",
                    JsonObject.Of("outputFile", full));
            }

            PlcSoftwareRef software = _host.FindPlcSoftware(p.String("device_name", null), p.String("software_name", null));

            List<PlcBlock> blocks = new List<PlcBlock>();
            List<string> missingBlocks = new List<string>();
            string groupPath = p.String("group_path", null);
            foreach (string raw in blockNames)
            {
                string group, name;
                OpennessHost.SplitGroupAndName(raw, out group, out name);
                BlockRef found = _host.FindBlock(software.Software, group ?? groupPath, name);
                if (found == null) missingBlocks.Add(name); else blocks.Add(found.Block);
            }
            List<PlcType> types = new List<PlcType>();
            List<string> missingTypes = new List<string>();
            foreach (string raw in typeNames)
            {
                string group, name;
                OpennessHost.SplitGroupAndName(raw, out group, out name);
                PlcTypeRef found = _host.FindType(software.Software, group ?? groupPath, name);
                if (found == null) missingTypes.Add(name); else types.Add(found.Type);
            }

            List<string> missing = new List<string>();
            missing.AddRange(missingBlocks);
            missing.AddRange(missingTypes);
            if (missing.Count > 0)
            {
                throw new ControllerException("object_not_found",
                    "These objects were not found: " + string.Join(", ", missing.ToArray()) + ".",
                    JsonObject.Of("missing", missing, "available", AvailableNames(software.Software)));
            }

            JsonObject data = new JsonObject();
            data.Add("outputFile", full);
            data.Add("extension", extension);
            data.Add("withDependencies", withDependencies);
            data.Add("blockCount", blocks.Count);
            data.Add("typeCount", types.Count);
            data.Add("dryRun", false);


            progress.Report("source", "Generating " + full + ".");
            _host.GenerateSourceFile(software.Software, blocks, types, full, withDependencies);
            if (File.Exists(full))
            {
                data.Add("bytes", new FileInfo(full).Length);
                data.Add("sha256", Hashing.Sha256OfFile(full));
            }
            changes.Add("file", full, File.Exists(full) ? "written" : "missing",
                blocks.Count + " block(s), " + types.Count + " type(s)");
            log.Info("Generated the source file " + Text.Quote(full) + ".");
            return data;
        }

        // --------------------------------------------------- WatchAndForceTables

        private JsonObject WatchAndForceTables(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string action = p.RequiredEnum("action", WatchAndForceActionNames);
            string kind = p.Enum("kind", WatchAndForceKindNames, "watch");
            string groupPath = p.String("group_path", null);
            bool createGroup = p.Bool("create_group", false);
            bool force = string.Equals(kind, "force", StringComparison.Ordinal);

            PlcSoftwareRef software = _host.FindPlcSoftware(p.String("device_name", null), p.String("software_name", null));

            if (string.Equals(action, "create", StringComparison.Ordinal))
            {
                if (force)
                {
                    throw new ControllerException("table_create_failed",
                        "TIA Portal Openness V17 exposes no Create for force tables (PlcForceTableComposition has only "
                            + "Import/Find); import a force table XML instead of creating one.",
                        JsonObject.Of("kind", kind));
                }
                string name = p.RequiredString("name");
                JsonObject created;
                using (TransactionScope scope = _host.BeginTransaction("Create watch table"))
                {
                    PlcWatchTable table = _host.CreateWatchTable(software.Software, groupPath, name, createGroup, log);
                    created = JsonObject.Of("action", action, "kind", kind, "name", table.Name,
                        "group", OpennessHost.NormalizeGroupPath(groupPath), "created", true, "dryRun", false);
                    scope.Commit();
                }
                changes.Add("watch_table", name, "created");
                log.Info("Created the watch table " + Text.Quote(name) + ".");
                return created;
            }

            if (string.Equals(action, "delete", StringComparison.Ordinal))
            {
                string name = p.RequiredString("name");
                if (force)
                {
                    throw new ControllerException("table_delete_failed",
                        "TIA Portal Openness V17 exposes no Delete for force tables (PlcForceTable has no Delete method); "
                            + "a force table can only be replaced by importing another one.",
                        JsonObject.Of("kind", kind, "name", name));
                }
                PlcWatchTable table = _host.FindWatchTable(software.Software, groupPath, name);
                if (table == null)
                {
                    throw new ControllerException("watch_table_not_found",
                        "The watch table " + Text.Quote(name) + " does not exist in "
                            + Text.Quote(OpennessHost.NormalizeGroupPath(groupPath)) + ".",
                        JsonObject.Of("name", name, "group", OpennessHost.NormalizeGroupPath(groupPath)));
                }
                using (TransactionScope scope = _host.BeginTransaction("Delete watch table"))
                {
                    _host.DeleteWatchTable(table);
                    scope.Commit();
                }
                changes.Add("watch_table", name, "deleted");
                return JsonObject.Of("action", action, "kind", kind, "name", name,
                    "group", OpennessHost.NormalizeGroupPath(groupPath), "deleted", true, "dryRun", false);
            }

            if (string.Equals(action, "export", StringComparison.Ordinal))
            {
                string name = p.RequiredString("name");
                string outputFile = p.RequiredString("output_file");
                bool overwrite = p.Bool("overwrite", false);
                string full = Path.GetFullPath(outputFile.Trim().Trim('"'));

                if (force)
                {
                    PlcForceTable table = _host.FindForceTable(software.Software, groupPath, name);
                    if (table == null)
                    {
                        throw new ControllerException("force_table_not_found",
                            "The force table " + Text.Quote(name) + " does not exist.",
                            JsonObject.Of("name", name, "group", OpennessHost.NormalizeGroupPath(groupPath)));
                    }
                    if (File.Exists(full) && !overwrite)
                    {
                        throw new ControllerException("file_exists",
                            "The file " + Text.Quote(full) + " already exists; pass overwrite=true to replace it.",
                            JsonObject.Of("outputFile", full));
                    }
                    _host.ExportForceTable(table, full);
                }
                else
                {
                    PlcWatchTable table = _host.FindWatchTable(software.Software, groupPath, name);
                    if (table == null)
                    {
                        throw new ControllerException("watch_table_not_found",
                            "The watch table " + Text.Quote(name) + " does not exist.",
                            JsonObject.Of("name", name, "group", OpennessHost.NormalizeGroupPath(groupPath)));
                    }
                    if (File.Exists(full) && !overwrite)
                    {
                        throw new ControllerException("file_exists",
                            "The file " + Text.Quote(full) + " already exists; pass overwrite=true to replace it.",
                            JsonObject.Of("outputFile", full));
                    }
                    _host.ExportWatchTable(table, full);
                }

                JsonObject data = new JsonObject();
                data.Add("action", action);
                data.Add("kind", kind);
                data.Add("name", name);
                data.Add("file", full);
                if (File.Exists(full))
                {
                    data.Add("bytes", new FileInfo(full).Length);
                    data.Add("sha256", Hashing.Sha256OfFile(full));
                }
                data.Add("dryRun", false);
                changes.Add(kind + "_table", name, "exported", full);
                return data;
            }

            // import
            List<string> importPaths = p.StringList("import_paths");
            if (importPaths.Count == 0)
            {
                throw new ControllerException("invalid_params", "'import_paths' is required when action=import.");
            }
            string importOptionName = p.Enum("import_options", ImportOptionNames, "none");
            ImportOptions importOptions = string.Equals(importOptionName, "override", StringComparison.Ordinal)
                ? ImportOptions.Override
                : ImportOptions.None;

            List<string> files = new List<string>();
            foreach (string path in importPaths)
            {
                string candidate = Path.GetFullPath(path.Trim().Trim('"'));
                if (Directory.Exists(candidate))
                {
                    files.AddRange(Directory.GetFiles(candidate, "*.xml", SearchOption.AllDirectories));
                }
                else if (File.Exists(candidate))
                {
                    files.Add(candidate);
                }
                else
                {
                    throw new ControllerException("invalid_params",
                        "No file or directory exists at " + Text.Quote(candidate) + ".", JsonObject.Of("path", candidate));
                }
            }
            if (files.Count == 0)
            {
                throw new ControllerException("invalid_params", "No *.xml file was found in the given import paths.");
            }


            progress.Report("import", "Importing " + files.Count + " watch/force table file(s).");
            List<JsonObject> imported = new List<JsonObject>();
            using (TransactionScope scope = _host.BeginTransaction("Import watch/force tables"))
            {
                PlcWatchAndForceTableGroup group = _host.ResolveWatchAndForceGroup(software.Software, groupPath, createGroup, log);
                if (group == null)
                {
                    throw OpennessHost.GroupNotFound(groupPath, _host.ListWatchAndForceGroupPaths(software.Software),
                        "watch/force table group");
                }
                foreach (string file in files)
                {
                    _host.ImportWatchOrForceTable(group, file, importOptions, force);
                    imported.Add(JsonObject.Of("file", file, "name", Path.GetFileNameWithoutExtension(file)));
                    changes.Add(kind + "_table", Path.GetFileNameWithoutExtension(file), "imported", file);
                }
                scope.Commit();
            }

            JsonObject result = new JsonObject();
            result.Add("action", action);
            result.Add("kind", kind);
            result.Add("imported", imported);
            result.Add("committed", true);
            result.Add("dryRun", false);
            log.Info("Imported " + imported.Count + " watch/force table file(s).");
            return result;
        }

        // --------------------------------------------------------- SoftwareUnits

        private JsonObject SoftwareUnits(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string action = p.Enum("action", UnitActionNames, "list");
            PlcSoftwareRef software = _host.FindPlcSoftware(p.String("device_name", null), p.String("software_name", null));

            string reason;
            PlcUnitProvider provider = _host.UnitProviderOf(software.Software, out reason);

            if (string.Equals(action, "list", StringComparison.Ordinal))
            {
                if (provider == null)
                {
                    JsonObject unavailable = new JsonObject();
                    unavailable.Add("available", false);
                    unavailable.Add("unitCount", 0);
                    unavailable.Add("units", new List<JsonObject>());
                    unavailable.Add("reason", reason);
                    log.Info("The PLC exposes no software units: " + reason);
                    return unavailable;
                }
                int total;
                int maxItems = p.Int("max_items", DefaultMaxItems);
                if (maxItems <= 0) maxItems = DefaultMaxItems;
                List<JsonObject> units = _host.ReadUnits(provider, p.String("name_filter", null), maxItems, out total);
                JsonObject data = new JsonObject();
                data.Add("available", true);
                data.Add("unitCount", total);
                data.Add("units", units);
                data.Add("truncated", total > units.Count);
                log.Info("Listed " + total + " software unit(s).");
                return data;
            }

            if (provider == null)
            {
                throw new ControllerException("unit_provider_unavailable", reason);
            }

            string name = p.RequiredString("name");

            PlcUnit unit = _host.FindUnit(provider, name);

            if (string.Equals(action, "create", StringComparison.Ordinal))
            {
                if (unit != null) throw OpennessHost.AlreadyExists("software unit", name);
                using (TransactionScope scope = _host.BeginTransaction("Create software unit"))
                {
                    PlcUnit created = _host.CreateUnit(provider, name);
                    scope.Commit();
                    changes.Add("unit", created.Name, "created");
                    return JsonObject.Of("action", action, "name", created.Name, "created", true, "dryRun", false);
                }
            }

            if (string.Equals(action, "delete", StringComparison.Ordinal))
            {
                if (unit == null)
                {
                    int unitTotal;
                    List<JsonObject> available = _host.ReadUnits(provider, null, DefaultMaxItems, out unitTotal);
                    List<string> names = new List<string>();
                    foreach (JsonObject item in available)
                    {
                        names.Add(JsonObject.ReadString(item, "name", "?"));
                    }
                    throw new ControllerException("unit_not_found",
                        "The software unit " + Text.Quote(name) + " does not exist.",
                        JsonObject.Of("name", name, "available", names));
                }
                using (TransactionScope scope = _host.BeginTransaction("Delete software unit"))
                {
                    _host.DeleteUnit(unit);
                    scope.Commit();
                }
                changes.Add("unit", name, "deleted");
                return JsonObject.Of("action", action, "name", name, "deleted", true, "dryRun", false);
            }

            if (unit == null)
            {
                throw new ControllerException("unit_not_found",
                    "The software unit " + Text.Quote(name) + " does not exist.", JsonObject.Of("name", name));
            }

            string relatedObject = p.RequiredString("related_object");
            string relationType = p.Enum("relation_type", UnitRelationTypeNames, "software_unit");

            if (string.Equals(action, "relation_create", StringComparison.Ordinal))
            {
                if (_host.FindUnitRelation(unit, relatedObject) != null)
                {
                    throw new ControllerException("relation_create_failed",
                        "The unit " + Text.Quote(name) + " already has a relation to " + Text.Quote(relatedObject) + ".",
                        JsonObject.Of("unit", name, "relatedObject", relatedObject));
                }
                using (TransactionScope scope = _host.BeginTransaction("Create unit relation"))
                {
                    _host.CreateUnitRelation(unit, relatedObject, relationType);
                    scope.Commit();
                }
                changes.Add("unit", name, "relation_created", relatedObject);
                return JsonObject.Of("action", action, "name", name, "relatedObject", relatedObject,
                    "relationType", relationType, "created", true, "dryRun", false);
            }

            PlcUnitRelation relation = _host.FindUnitRelation(unit, relatedObject);
            if (relation == null)
            {
                throw new ControllerException("unit_not_found",
                    "The unit " + Text.Quote(name) + " has no relation to " + Text.Quote(relatedObject) + ".",
                    JsonObject.Of("unit", name, "relatedObject", relatedObject));
            }
            using (TransactionScope scope = _host.BeginTransaction("Delete unit relation"))
            {
                _host.DeleteUnitRelation(relation);
                scope.Commit();
            }
            changes.Add("unit", name, "relation_deleted", relatedObject);
            return JsonObject.Of("action", action, "name", name, "relatedObject", relatedObject,
                "deleted", true, "dryRun", false);
        }
    }
}
