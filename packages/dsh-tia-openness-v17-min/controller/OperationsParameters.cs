using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Siemens.Engineering;
using Siemens.Engineering.HW;
using Siemens.Engineering.HW.Features;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>
    /// The "C bucket": parameter values that only exist in the object model and are never
    /// part of a CAx/AML export.
    ///
    /// There is deliberately **no** parameter whitelist. Attribute names are per device
    /// type (`SignalType` on an analog module, `Failsafe_*` on an F module, vendor-defined
    /// names on a GSD device), and Openness publishes no static "which parameters does
    /// this type have" table — only the runtime <c>GetAttributeInfos()</c> list, which
    /// carries a name and an access mode and nothing else. So the operation is a generic
    /// attribute reader: enumerate what an object publishes, and read the values the
    /// caller asked for.
    ///
    /// Two modes keep the cost honest:
    ///   list   — one GetAttributeInfos() per object; answers "what can I look up here".
    ///   values — additionally reads every published attribute; use it on a filtered item,
    ///            because a whole device can publish thousands of attributes.
    ///
    /// P1a covers device items and their channels (plus GSD identity, which is typed).
    /// GSD parameter blocks (GetPrmData), structured vendor data and port/cabling details
    /// are P1b/P1c and are rejected here on purpose rather than silently ignored.
    /// </summary>
    internal sealed partial class OpennessOperations
    {
        private static readonly string[] ParameterModeNames = { "list", "values" };
        private static readonly string[] ParameterIncludeNames = { "attributes", "channels", "gsd" };

        private JsonObject HardwareParameters(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            if (!_host.HasProject)
            {
                throw new ControllerException("project_not_open",
                    "HardwareParameters reads the object model, so a project must be open. Call OpenProject first "
                        + "(the AML readers hardware_inventory/hardware_configuration do not need one).");
            }

            string deviceName = p.RequiredString("device");
            string itemPath = p.String("item", null);
            bool hasChannel = p.Has("channel");
            int channelNumber = hasChannel ? p.Int("channel", 0) : 0;
            string attributeName = p.String("attribute", null);
            string mode = p.Enum("mode", ParameterModeNames, "list");
            bool withValues = string.Equals(mode, "values", StringComparison.Ordinal);

            List<string> include = p.EnumList("include", ParameterIncludeNames);
            if (include.Count == 0)
            {
                include.Add("attributes");
                include.Add("channels");
            }
            bool withChannels = include.Contains("channels");
            bool withGsd = include.Contains("gsd");

            int maxItems = p.Int("max_items", 200);
            if (maxItems <= 0) maxItems = 200;
            int offset = p.Int("offset", 0);
            if (offset < 0) offset = 0;

            Device device = FindDevice(deviceName);
            progress.Report("parameters",
                "Reading the published attributes of " + Text.Quote(deviceName) + (itemPath == null ? "." : " (" + itemPath + ")."));

            List<ItemPath> items = FlattenItems(device, itemPath);

            List<ItemPath> page = items.Skip(offset).Take(maxItems).ToList();
            List<JsonObject> rows = new List<JsonObject>();
            int attributeCount = 0, channelCount = 0;
            foreach (ItemPath item in page)
            {
                JsonObject row = DescribeItem(item, withValues, withChannels, withGsd, attributeName,
                    hasChannel, channelNumber, ref attributeCount, ref channelCount);
                rows.Add(row);
            }

            JsonObject data = new JsonObject();
            data.Add("device", deviceName);
            data.Add("mode", mode);
            data.Add("include", include);
            data.Add("items", rows);
            data.Add("counts", JsonObject.Of("items", rows.Count, "attributes", attributeCount, "channels", channelCount));
            data.Add("totalItems", items.Count);
            data.Add("offset", offset);
            data.Add("truncated", offset + rows.Count < items.Count);
            if (offset + rows.Count < items.Count) data.Add("nextOffset", offset + rows.Count);
            data.Add("note", "Attribute names are whatever this object publishes (GetAttributeInfos); there is no "
                + "per-type parameter table. Switch mode to 'values' to read them.");

            log.Info("Read " + rows.Count + " device item(s) of " + Text.Quote(deviceName)
                + " (" + attributeCount + " attributes, " + channelCount + " channels).");
            return data;
        }

        // ------------------------------------------------------------- selection

        /// <summary>One device item plus the path of names that reaches it.</summary>
        private sealed class ItemPath
        {
            public DeviceItem Item;
            public List<string> Path;
            public int Depth;

            public string Text { get { return string.Join("/", Path.ToArray()); } }
        }

        private Device FindDevice(string name)
        {
            List<Device> devices = _host.CollectDevices().ToList();
            Device match = devices.FirstOrDefault(d => string.Equals(d.Name, name, StringComparison.Ordinal));
            if (match != null) return match;

            throw new ControllerException("device_not_found",
                "No device named " + Text.Quote(name) + " is open in the project. Available: "
                    + string.Join(", ", devices.Select(d => d.Name)),
                JsonObject.Of("available", devices.Select(d => d.Name).ToList()));
        }

        /// <summary>
        /// Flattens the device-item tree, or the subtree named by <paramref name="itemPath"/>.
        ///
        /// Path segments match a child by name (ordinal) or, with a leading '#', by
        /// PositionNumber — the slot number the AML tools report. A path that does not
        /// resolve is retried as "the shallowest item whose name matches the last segment",
        /// because the AML and the object model nest differently: in an ET200SP station the
        /// AML puts the modules under the rack while the object model makes them siblings.
        /// </summary>
        private List<ItemPath> FlattenItems(Device device, string itemPath)
        {
            List<ItemPath> roots = new List<ItemPath>();
            if (string.IsNullOrWhiteSpace(itemPath))
            {
                foreach (DeviceItem item in device.DeviceItems)
                    roots.Add(new ItemPath { Item = item, Path = new List<string> { item.Name }, Depth = 0 });
            }
            else
            {
                string[] segments = itemPath.Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries)
                    .Select(s => s.Trim()).Where(s => s.Length > 0).ToArray();
                Resolved resolved = ResolvePath(device, segments);
                roots.Add(new ItemPath { Item = resolved.Item, Path = resolved.Walked, Depth = 0 });
            }

            List<ItemPath> flattened = new List<ItemPath>();
            foreach (ItemPath root in roots) Flatten(root, flattened);
            return flattened;
        }

        /// <summary>A resolved item plus the path that actually reaches it.</summary>
        private sealed class Resolved
        {
            public DeviceItem Item;
            public List<string> Walked;
            public string ResolvedBy;
        }

        /// <summary>Strict path walk, then a name-only fallback that prefers the shallowest match.</summary>
        private Resolved ResolvePath(Device device, string[] segments)
        {
            DeviceItem current = null;
            List<string> walked = new List<string>();
            IEnumerable<DeviceItem> candidates = device.DeviceItems;
            bool strict = true;
            foreach (string segment in segments)
            {
                List<DeviceItem> matches = candidates.Where(i => Matches(i, segment)).ToList();
                if (matches.Count == 0) { strict = false; break; }
                if (matches.Count > 1)
                {
                    throw new ControllerException("item_ambiguous",
                        "The segment " + Text.Quote(segment) + " matches " + matches.Count
                            + " device items. Use a longer path or '#<position>'.",
                        JsonObject.Of("candidates", matches.Select(i => Describe(i)).ToList()));
                }
                current = matches[0];
                walked.Add(segment);
                candidates = current.DeviceItems;
            }
            if (strict && current != null)
            {
                return new Resolved { Item = current, Walked = walked, ResolvedBy = "path" };
            }

            // Fallback: the last segment anywhere in the device, shallowest first.
            string last = segments[segments.Length - 1];
            List<ItemPath> all = new List<ItemPath>();
            foreach (DeviceItem root in device.DeviceItems)
                Flatten(new ItemPath { Item = root, Path = new List<string> { root.Name }, Depth = 0 }, all);
            List<ItemPath> loose = all.Where(i => Matches(i.Item, last)).ToList();
            if (loose.Count > 0)
            {
                int shallowest = loose.Min(i => i.Depth);
                List<ItemPath> top = loose.Where(i => i.Depth == shallowest).ToList();
                if (top.Count == 1)
                {
                    return new Resolved { Item = top[0].Item, Walked = top[0].Path, ResolvedBy = "name" };
                }
                throw new ControllerException("item_ambiguous",
                    Text.Quote(last) + " matches " + top.Count + " device items at the same depth. Use a full path.",
                    JsonObject.Of("candidates", top.Select(i => i.Text).ToList()));
            }

            throw new ControllerException("item_not_found",
                "No device item matches " + Text.Quote(string.Join("/", segments)) + " under "
                    + Text.Quote(device.Name) + ". In the object model a rack and its modules are siblings, not parent and child.",
                JsonObject.Of("device", device.Name,
                    "availablePaths", all.Take(40).Select(i => i.Text).ToList()));
        }


        private void Flatten(ItemPath node, List<ItemPath> sink)
        {
            sink.Add(node);
            foreach (DeviceItem child in node.Item.DeviceItems)
            {
                List<string> path = new List<string>(node.Path) { child.Name };
                Flatten(new ItemPath { Item = child, Path = path, Depth = node.Depth + 1 }, sink);
            }
        }

        private static bool Matches(DeviceItem item, string segment)
        {
            if (segment.StartsWith("#", StringComparison.Ordinal))
            {
                int position;
                if (!int.TryParse(segment.Substring(1), out position)) return false;
                return item.PositionNumber == position;
            }
            return string.Equals(item.Name, segment, StringComparison.Ordinal);
        }

        private static JsonObject Describe(DeviceItem item)
        {
            JsonObject row = new JsonObject();
            row.Add("name", item.Name);
            row.Add("position", item.PositionNumber);
            row.AddIfPresent("typeIdentifier", item.TypeIdentifier);
            return row;
        }

        // ------------------------------------------------------------- describing

        private JsonObject DescribeItem(ItemPath node, bool withValues, bool withChannels, bool withGsd,
            string attributeName, bool hasChannel, int channelNumber, ref int attributeCount, ref int channelCount)
        {
            DeviceItem item = node.Item;
            JsonObject row = new JsonObject();
            row.Add("name", item.Name);
            row.Add("path", node.Text);
            row.Add("depth", node.Depth);
            row.Add("position", item.PositionNumber);
            row.AddIfPresent("typeIdentifier", item.TypeIdentifier);
            row.AddIfPresent("classification", Convert.ToString(item.Classification));

            if (attributeName != null)
            {
                JsonObject single = ReadOneAttribute(item, attributeName, withValues);
                row.Add("attribute", single);
                if (single != null) attributeCount++;
            }
            else
            {
                List<JsonObject> attributes = ReadAttributes(item, withValues);
                row.Add("attributes", attributes);
                attributeCount += attributes.Count;
            }

            if (withChannels)
            {
                List<JsonObject> channels = new List<JsonObject>();
                foreach (Channel channel in ChannelsOf(item))
                {
                    if (hasChannel && channel.Number != channelNumber) continue;
                    JsonObject channelRow = new JsonObject();
                    channelRow.Add("number", channel.Number);
                    channelRow.AddIfPresent("type", Convert.ToString(channel.Type));
                    channelRow.AddIfPresent("ioType", Convert.ToString(channel.IoType));
                    // ChannelAddress is the one per-channel value worth promoting out of the
                    // attribute list: the AML only gives the module's StartAddress + Length.
                    channelRow.AddIfPresent("address", Convert.ToString(OpennessHost.TryReadAttribute(channel, "ChannelAddress")));
                    if (attributeName != null) channelRow.Add("attribute", ReadOneAttribute(channel, attributeName, withValues));
                    else channelRow.Add("attributes", ReadAttributes(channel, withValues));
                    channels.Add(channelRow);
                }
                row.Add("channels", channels);
                channelCount += channels.Count;
            }

            if (withGsd)
            {
                JsonObject gsd = DescribeGsd(item);
                if (gsd != null) row.Add("gsd", gsd);
            }

            return row;
        }

        private static IEnumerable<Channel> ChannelsOf(DeviceItem item)
        {
            ChannelComposition channels;
            try
            {
                channels = item.Channels;
            }
            catch (Exception)
            {
                return new List<Channel>();
            }
            if (channels == null) return new List<Channel>();
            try
            {
                return channels.ToList();
            }
            catch (Exception)
            {
                return new List<Channel>();
            }
        }

        /// <summary>The published attribute names of one object, with values only in mode=values.</summary>
        private static List<JsonObject> ReadAttributes(IEngineeringObject target, bool withValues)
        {
            List<JsonObject> rows = new List<JsonObject>();
            foreach (JsonObject info in OpennessHost.AttributeInfosOf(target))
            {
                string name = JsonObject.ReadString(info, "name", null);
                if (string.IsNullOrEmpty(name)) continue;
                JsonObject row = new JsonObject();
                row.Add("name", name);
                row.AddIfPresent("accessMode", JsonObject.ReadString(info, "accessMode", null));
                if (withValues)
                {
                    object value = OpennessHost.TryReadAttribute(target, name);
                    row.Add("value", ParameterValue(value));
                }
                rows.Add(row);
            }
            return rows;
        }

        /// <summary>
        /// One named attribute. An unknown name is a structured failure that carries the
        /// available names, because guessing which parameters a module has is exactly what
        /// this operation exists to avoid.
        /// </summary>
        private static JsonObject ReadOneAttribute(IEngineeringObject target, string name, bool withValues)
        {
            bool published = false;
            string accessMode = null;
            foreach (JsonObject info in OpennessHost.AttributeInfosOf(target))
            {
                string candidate = JsonObject.ReadString(info, "name", null);
                if (!string.Equals(candidate, name, StringComparison.Ordinal)) continue;
                published = true;
                accessMode = JsonObject.ReadString(info, "accessMode", null);
                break;
            }

            object value = OpennessHost.TryReadAttribute(target, name);
            if (!published && value == null)
            {
                throw new ControllerException("attribute_not_found",
                    "No attribute named " + Text.Quote(name) + " is published by this object.",
                    JsonObject.Of("attribute", name,
                        "available", OpennessHost.AttributeInfosOf(target).Select(i => JsonObject.ReadString(i, "name", null)).ToList()));
            }

            JsonObject row = new JsonObject();
            row.Add("name", name);
            row.AddIfPresent("accessMode", accessMode);
            if (withValues) row.Add("value", ParameterValue(value));
            return row;
        }

        private static JsonObject DescribeGsd(DeviceItem item)
        {
            GsdDeviceItem gsd;
            try
            {
                gsd = item.GetService<GsdDeviceItem>();
            }
            catch (Exception)
            {
                return null;
            }
            if (gsd == null) return null;

            JsonObject row = new JsonObject();
            row.AddIfPresent("gsdId", gsd.GsdId);
            row.AddIfPresent("gsdName", gsd.GsdName);
            row.AddIfPresent("gsdType", gsd.GsdType);
            row.Add("isProfibus", gsd.IsProfibus);
            row.Add("isProfinet", gsd.IsProfinet);
            row.Add("note", "Parameter blocks (GetPrmData) are P1b and not exposed yet.");
            return row;
        }

        /// <summary>
        /// Converts an Openness attribute value to something JSON can carry without losing
        /// what it was: enums by name, dates as ISO-8601, byte arrays as base64, and
        /// anything else that is not a JSON primitive through ToString.
        /// </summary>
        private static object ParameterValue(object value)
        {
            if (value == null) return null;
            if (value is string || value is bool || value is int || value is long || value is double || value is decimal) return value;

            byte[] bytes = value as byte[];
            if (bytes != null) return Convert.ToBase64String(bytes);

            DateTime date = default(DateTime);
            if (value is DateTime) return ((DateTime)value).ToString("o");
            if (value is System.Enum) return value.ToString();
            if (value is IFormattable) return Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture);
            return value.ToString();
        }
    }
}