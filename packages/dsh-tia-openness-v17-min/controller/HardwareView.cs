using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml.Linq;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>
    /// The single merged model the Hardware panel renders.
    ///
    /// <c>HardwareInventory</c> and <c>HardwareConfiguration</c> answer one question
    /// each; a panel needs both at once and must not issue two round trips that can
    /// disagree. This operation parses the export once and returns the joined shape,
    /// which the tool layer writes to <c>&lt;workspace&gt;/.dsh/hardware-view.json</c>.
    ///
    /// Everything here comes from the AML file, so the view is a snapshot of the
    /// export — not live state, and not the object model. Parameter values
    /// (<c>hardware_parameters</c>) are deliberately absent: they need an open
    /// project, and mixing a live read into a file snapshot would misdate it.
    /// </summary>
    internal sealed partial class OpennessOperations
    {
        private JsonObject HardwareView(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            AmlDocument aml = AmlDocument.Open(p.String("aml_path", null), true);
            List<AmlDevice> devices = aml.Devices();

            AmlLinks links = aml.ResolveLinks();
            JsonObject network = aml.Network(devices);

            // Subnets come back flat; a subnet owns its nodes, so join them here.
            Dictionary<string, List<JsonObject>> nodesBySubnet = new Dictionary<string, List<JsonObject>>(StringComparer.Ordinal);
            foreach (JsonObject node in ReadObjects(network, "nodes"))
            {
                string subnet = SubnetOf(links, JsonObject.ReadString(node, "device", null));
                if (subnet == null) continue;
                if (!nodesBySubnet.ContainsKey(subnet)) nodesBySubnet[subnet] = new List<JsonObject>();
                nodesBySubnet[subnet].Add(node);
            }

            List<JsonObject> subnets = new List<JsonObject>();
            foreach (JsonObject subnet in ReadObjects(network, "subnets"))
            {
                string name = JsonObject.ReadString(subnet, "name", null);
                List<JsonObject> nodes;
                if (!nodesBySubnet.TryGetValue(name ?? string.Empty, out nodes)) nodes = new List<JsonObject>();
                JsonObject row = new JsonObject();
                row.Add("name", name);
                row.AddIfPresent("type", JsonObject.ReadString(subnet, "type", null));
                row.Add("nodes", nodes);
                subnets.Add(row);
            }

            Dictionary<string, List<JsonObject>> signalsByChannelDevice = new Dictionary<string, List<JsonObject>>(StringComparer.Ordinal);
            Dictionary<string, List<JsonObject>> signalsByTagDevice = DictionaryOfLists();
            foreach (JsonObject signal in links.Signals)
            {
                JsonObject channel = signal["channel"] as JsonObject;
                JsonObject tag = signal["tag"] as JsonObject;
                if (channel == null || tag == null) continue;
                JsonObject flat = new JsonObject();
                flat.AddIfPresent("slot", JsonObject.ReadString(channel, "slot", null));
                flat.AddIfPresent("module", JsonObject.ReadString(channel, "module", null));
                flat.AddIfPresent("channel", JsonObject.ReadString(channel, "channel", null));
                flat.AddIfPresent("tag", JsonObject.ReadString(tag, "name", null));
                flat.AddIfPresent("address", JsonObject.ReadString(tag, "logicalAddress", null));
                flat.AddIfPresent("dataType", JsonObject.ReadString(tag, "dataType", null));
                AddTo(signalsByChannelDevice, JsonObject.ReadString(channel, "device", null), flat);
                AddTo(signalsByTagDevice, JsonObject.ReadString(tag, "device", null), flat);
            }

            List<JsonObject> deviceRows = new List<JsonObject>();
            Dictionary<string, int> channelTotals = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (string key in new[] { "di", "do", "ai", "ao", "total" }) channelTotals[key] = 0;
            int rackCount = 0, moduleCount = 0;

            foreach (AmlDevice device in devices)
            {
                string name = device.Name;
                List<JsonObject> nodes = ReadObjects(network, "nodes");
                JsonObject firstNode = nodes.FirstOrDefault(n => string.Equals(JsonObject.ReadString(n, "device", null), name, StringComparison.Ordinal));

                List<JsonObject> moduleRows = new List<JsonObject>();
                Dictionary<string, int> deviceChannels = new Dictionary<string, int>(StringComparer.Ordinal);
                foreach (string key in new[] { "di", "do", "ai", "ao", "total" }) deviceChannels[key] = 0;

                foreach (AmlRack rack in device.Racks())
                {
                    rackCount++;
                    foreach (AmlModule module in rack.Modules)
                    {
                        moduleCount++;
                        JsonObject row = new JsonObject();
                        row.AddIfPresent("slot", module.Slot);
                        row.Add("name", module.Name);
                        row.AddIfPresent("typeName", Aml.Attr(module.Element, "TypeName"));
                        row.AddIfPresent("orderNumber", Aml.OrderNumberOf(Aml.Attr(module.Element, "TypeIdentifier")));
                        row.AddIfPresent("firmware", Aml.Attr(module.Element, "FirmwareVersion"));
                        row.AddIfPresent("deviceItemType", Aml.Attr(module.Element, "DeviceItemType"));
                        row.Add("channels", ToJson(module.ChannelCounts()));
                        row.Add("addresses", module.Addresses());
                        foreach (KeyValuePair<string, int> pair in module.ChannelCounts())
                        {
                            deviceChannels[pair.Key] = deviceChannels.ContainsKey(pair.Key) ? deviceChannels[pair.Key] + pair.Value : pair.Value;
                            channelTotals[pair.Key] = channelTotals.ContainsKey(pair.Key) ? channelTotals[pair.Key] + pair.Value : pair.Value;
                        }
                        moduleRows.Add(row);
                    }
                }

                // A device carries no TypeName of its own; the readable model and the
                // MLFB sit on the head module (CPU for a controller, head module for an
                // IO station, DAP for a GSD device).
                JsonObject head = moduleRows.FirstOrDefault(m => string.Equals(JsonObject.ReadString(m, "deviceItemType", null), "HeadModule", StringComparison.Ordinal))
                    ?? moduleRows.FirstOrDefault(m => string.Equals(JsonObject.ReadString(m, "deviceItemType", null), "CPU", StringComparison.Ordinal))
                    ?? moduleRows.FirstOrDefault();

                JsonObject deviceRow = new JsonObject();
                deviceRow.Add("name", name);
                deviceRow.AddIfPresent("groupPath", string.Join("/", device.Groups.ToArray()));
                deviceRow.Add("role", RoleOf(Aml.Attr(device.Element, "TypeIdentifier")));
                deviceRow.AddIfPresent("typeIdentifier", Aml.Attr(device.Element, "TypeIdentifier"));
                deviceRow.AddIfPresent("typeName", head == null ? null : JsonObject.ReadString(head, "typeName", null));
                deviceRow.AddIfPresent("orderNumber", head == null ? null : JsonObject.ReadString(head, "orderNumber", null));
                deviceRow.AddIfPresent("firmware", head == null ? null : JsonObject.ReadString(head, "firmware", null));
                deviceRow.AddIfPresent("ip", firstNode == null ? null : JsonObject.ReadString(firstNode, "ip", null));
                deviceRow.AddIfPresent("mask", firstNode == null ? null : JsonObject.ReadString(firstNode, "subnetMask", null));
                deviceRow.AddIfPresent("profinetName", firstNode == null ? null : JsonObject.ReadString(firstNode, "profinetName", null));
                deviceRow.AddIfPresent("interface", InterfaceOf(nodes, name));
                deviceRow.AddIfPresent("subnet", SubnetOf(links, name));
                deviceRow.Add("status", "ok");
                // The sheet shows the module count per station; the channel totals
                // alone left it at zero.
                deviceChannels["modules"] = moduleRows.Count;
                deviceRow.Add("kpis", ToJson(deviceChannels));
                deviceRow.Add("modules", moduleRows);
                List<JsonObject> owned;
                deviceRow.Add("signals", signalsByChannelDevice.TryGetValue(name, out owned) ? owned : new List<JsonObject>());
                deviceRow.Add("tagSignals", signalsByTagDevice.TryGetValue(name, out owned) ? owned : new List<JsonObject>());
                deviceRows.Add(deviceRow);
            }

            JsonObject data = aml.Header();
            data.Add("generatedAt", DateTime.Now.ToString("yyyy-MM-dd HH:mm"));
            JsonObject counts = new JsonObject();
            counts.Add("devices", deviceRows.Count);
            counts.Add("racks", rackCount);
            counts.Add("modules", moduleCount);
            counts.Add("channels", ToJson(channelTotals));
            data.Add("counts", counts);

            JsonObject content = new JsonObject();
            content.Add("signals", links.Signals.Count);
            content.Add("subnets", subnets.Count);
            content.Add("nodes", ReadObjects(network, "nodes").Count);
            data.Add("content", content);

            JsonObject networks = new JsonObject();
            networks.Add("subnets", subnets);
            networks.Add("ioSystems", new List<JsonObject>(ReadObjects(network, "ioSystems")));
            data.Add("networks", networks);

            JsonObject linkCounts = new JsonObject();
            int port = 0, subnetLinks = 0, ioLinks = 0;
            foreach (JsonObject link in links.Connections)
            {
                string kind = JsonObject.ReadString(link, "kind", null);
                if (kind == "port-port") port++;
                else if (kind == "node-subnet") subnetLinks++;
                else if (kind == "interface-iosystem") ioLinks++;
            }
            linkCounts.Add("port", port);
            linkCounts.Add("subnet", subnetLinks);
            linkCounts.Add("ioSystem", ioLinks);
            data.Add("links", linkCounts);

            data.Add("devices", deviceRows);
            log.Info("Built the hardware view: " + deviceRows.Count + " devices, " + moduleCount + " modules, "
                + links.Signals.Count + " signals.");
            return data;
        }

        // ------------------------------------------------------------- helpers

        private static Dictionary<string, List<JsonObject>> DictionaryOfLists()
        {
            return new Dictionary<string, List<JsonObject>>(StringComparer.Ordinal);
        }

        private static void AddTo(Dictionary<string, List<JsonObject>> map, string key, JsonObject row)
        {
            if (key == null) return;
            if (!map.ContainsKey(key)) map[key] = new List<JsonObject>();
            map[key].Add(row);
        }

        private static List<JsonObject> ReadObjects(JsonObject source, string key)
        {
            List<JsonObject> rows = new List<JsonObject>();
            System.Collections.IEnumerable items = source == null ? null : source[key] as System.Collections.IEnumerable;
            if (items == null) return rows;
            foreach (object item in items)
            {
                JsonObject row = item as JsonObject;
                if (row != null) rows.Add(row);
            }
            return rows;
        }

        /// <summary>The first subnet this device's node belongs to.</summary>
        private static string SubnetOf(AmlLinks links, string device)
        {
            foreach (JsonObject link in links.Connections)
            {
                if (JsonObject.ReadString(link, "kind", null) != "node-subnet") continue;
                JsonObject a = link["sideA"] as JsonObject;
                JsonObject b = link["sideB"] as JsonObject;
                if (a == null || b == null) continue;
                JsonObject nodeSide = JsonObject.ReadString(a, "interface", null) == "LogicalEndPoint_Node" ? a : b;
                JsonObject subnetSide = ReferenceEquals(nodeSide, a) ? b : a;
                if (!string.Equals(JsonObject.ReadString(nodeSide, "device", null), device, StringComparison.Ordinal)) continue;
                return JsonObject.ReadString(subnetSide, "element", null);
            }
            return null;
        }

        /// <summary>Interface labels ("X1 · X2") of every node this device owns.</summary>
        private static string InterfaceOf(List<JsonObject> nodes, string device)
        {
            List<string> labels = new List<string>();
            foreach (JsonObject node in nodes)
            {
                if (!string.Equals(JsonObject.ReadString(node, "device", null), device, StringComparison.Ordinal)) continue;
                string label = JsonObject.ReadString(node, "interface", null);
                if (!string.IsNullOrEmpty(label) && !labels.Contains(label)) labels.Add(label);
            }
            return labels.Count == 0 ? null : string.Join(" · ", labels.ToArray());
        }

        /// <summary>
        /// The device class the rail groups by. Derived from the type identifier
        /// because the AML has no role for the device kinds we care about.
        /// </summary>
        private static string RoleOf(string typeIdentifier)
        {
            string id = typeIdentifier ?? string.Empty;
            if (System.Text.RegularExpressions.Regex.IsMatch(id, @"System:Device\.S7")) return "controller";
            if (id.IndexOf("ET200", StringComparison.Ordinal) >= 0) return "io";
            if (System.Text.RegularExpressions.Regex.IsMatch(id, "Sinamics|SV660|UNIDRIVE|InnoDrive|110A2")) return "drive";
            if (id.IndexOf("Scalance", StringComparison.OrdinalIgnoreCase) >= 0) return "network";
            if (id.StartsWith("GSD:", StringComparison.Ordinal)) return "thirdParty";
            return "other";
        }
    }
}
