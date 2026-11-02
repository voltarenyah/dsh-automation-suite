using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml.Linq;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>
    /// Read-only views over one CAx/AML hardware export: the component identity
    /// (<c>HardwareInventory</c>) and the configured values (<c>HardwareConfiguration</c>).
    ///
    /// Both operations read a **file**, not a project: they need no open project, no
    /// TIA Portal session and no Openness assembly, so they work after the project has
    /// been closed and can be repeated cheaply. The split between them follows the
    /// attribute taxonomy in <c>docs/HARDWARE-TOOL-TAXONOMY.md</c>:
    ///
    ///   inventory     — what the ordered hardware *is*: TypeIdentifier/MLFB, TypeName,
    ///                   firmware, slot, built-in flag, role class, group path.
    ///   configuration — what engineering *assigned*: I/O addresses and channel widths,
    ///                   PLC tags, IP/subnet/PROFINET names, IO systems, cabling and
    ///                   signal mapping, F addresses.
    ///
    /// Classification never uses <c>RefBaseClassPath</c> (empty on every element in a
    /// V17 export). It uses <c>SupportedRoleClass/@RefRoleClassPath</c> — Device,
    /// DeviceItem, CommunicationPort, CommunicationInterface, Node — with attribute
    /// fallbacks for the elements that carry no role.
    /// </summary>
    internal sealed partial class OpennessOperations
    {
        /// <summary>Sections <c>HardwareConfiguration</c> can return.</summary>
        private static readonly string[] HardwareSectionNames =
        {
            "addresses", "channels", "tags", "network", "links", "signals", "f",
        };

        // ------------------------------------------------------ HardwareInventory

        private JsonObject HardwareInventory(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            AmlDocument aml = AmlDocument.Open(p.String("aml_path", null), true);
            string onlyDevice = p.String("device", null);
            bool includeComments = p.Bool("include_comments", true);
            bool includeCounts = p.Bool("include_counts", true);

            List<AmlDevice> devices = aml.Devices();
            if (!string.IsNullOrWhiteSpace(onlyDevice))
            {
                devices = devices.Where(d => string.Equals(d.Element.Attribute("Name")?.Value, onlyDevice,
                    StringComparison.Ordinal)).ToList();
                if (devices.Count == 0)
                {
                    throw new ControllerException("device_not_found",
                        "No device named " + Text.Quote(onlyDevice) + " exists in the AML. It holds: "
                            + string.Join(", ", aml.Devices().Select(d => d.Element.Attribute("Name")?.Value)),
                        JsonObject.Of("aml", aml.Path, "available", aml.Devices().Select(d => d.Element.Attribute("Name")?.Value).ToList()));
                }
            }

            List<JsonObject> devicePayload = new List<JsonObject>();
            int rackTotal = 0, moduleTotal = 0;
            Dictionary<string, int> channelTotals = EmptyChannelCounts();
            foreach (AmlDevice device in devices)
            {
                JsonObject entry = device.Describe(includeComments);
                List<AmlRack> racks = device.Racks();
                rackTotal += racks.Count;
                List<JsonObject> rackPayload = new List<JsonObject>();
                foreach (AmlRack rack in racks)
                {
                    JsonObject rackJson = rack.Describe(includeComments, includeCounts);
                    moduleTotal += rack.Modules.Count;
                    foreach (AmlModule module in rack.Modules)
                    {
                        foreach (KeyValuePair<string, int> pair in module.ChannelCounts())
                        {
                            channelTotals[pair.Key] = channelTotals.ContainsKey(pair.Key) ? channelTotals[pair.Key] + pair.Value : pair.Value;
                        }
                    }
                    rackPayload.Add(rackJson);
                }
                devicePayload.Add(entry.Add("racks", rackPayload));
            }

            JsonObject data = aml.Header();
            data.Add("devices", devicePayload);
            if (includeCounts)
            {
                JsonObject counts = new JsonObject();
                counts.Add("devices", devicePayload.Count);
                counts.Add("racks", rackTotal);
                counts.Add("modules", moduleTotal);
                counts.Add("channels", ToJson(channelTotals));
                data.Add("counts", counts);
            }
            log.Info("Read the hardware inventory of " + (devicePayload.Count == 1 ? "1 device" : devicePayload.Count + " devices")
                + " from " + Text.Quote(aml.Path) + ".");
            return data;
        }

        // -------------------------------------------------- HardwareConfiguration

        private JsonObject HardwareConfiguration(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            AmlDocument aml = AmlDocument.Open(p.String("aml_path", null), true);
            List<string> sections = p.EnumList("sections", HardwareSectionNames);
            if (sections.Count == 0) sections.AddRange(HardwareSectionNames);
            string onlyDevice = p.String("device", null);

            List<AmlDevice> devices = aml.Devices();
            if (!string.IsNullOrWhiteSpace(onlyDevice))
            {
                devices = devices.Where(d => string.Equals(d.Element.Attribute("Name")?.Value, onlyDevice,
                    StringComparison.Ordinal)).ToList();
                if (devices.Count == 0)
                {
                    throw new ControllerException("device_not_found",
                        "No device named " + Text.Quote(onlyDevice) + " exists in the AML.",
                        JsonObject.Of("aml", aml.Path, "available", aml.Devices().Select(d => d.Element.Attribute("Name")?.Value).ToList()));
                }
            }

            JsonObject data = aml.Header();
            data.Add("sections", sections);

            if (sections.Contains("addresses"))
            {
                List<JsonObject> rows = new List<JsonObject>();
                foreach (AmlDevice device in devices)
                    foreach (AmlRack rack in device.Racks())
                        foreach (AmlModule module in rack.Modules)
                            foreach (JsonObject address in module.Addresses())
                            {
                                address.Add("device", device.Name);
                                address.Add("rack", rack.Name);
                                address.Add("slot", module.Slot);
                                address.Add("module", module.Name);
                                rows.Add(address);
                            }
                data.Add("addresses", rows);
            }

            if (sections.Contains("channels"))
            {
                List<JsonObject> rows = new List<JsonObject>();
                foreach (AmlDevice device in devices)
                    foreach (AmlRack rack in device.Racks())
                        foreach (AmlModule module in rack.Modules)
                        {
                            List<JsonObject> channels = module.Channels();
                            if (channels.Count == 0) continue;
                            JsonObject row = new JsonObject();
                            row.Add("device", device.Name);
                            row.Add("rack", rack.Name);
                            row.Add("slot", module.Slot);
                            row.Add("module", module.Name);
                            row.Add("channels", channels);
                            rows.Add(row);
                        }
                data.Add("channels", rows);
            }

            if (sections.Contains("tags"))
            {
                List<JsonObject> rows = new List<JsonObject>();
                foreach (AmlDevice device in devices)
                    foreach (XElement iface in device.Element.Descendants("ExternalInterface"))
                    {
                        if (!Aml.ClassOf(iface).EndsWith("/Tag", StringComparison.Ordinal)) continue;
                        JsonObject row = new JsonObject();
                        row.Add("device", device.Name);
                        row.Add("name", Aml.Attr(iface, "Name") ?? iface.Attribute("Name")?.Value);
                        row.AddIfPresent("dataType", Aml.Attr(iface, "DataType"));
                        row.AddIfPresent("ioType", Aml.Attr(iface, "IoType"));
                        row.AddIfPresent("logicalAddress", Aml.Attr(iface, "LogicalAddress"));
                        row.AddIfPresent("comment", Aml.Attr(iface, "Comment"));
                        rows.Add(row);
                    }
                data.Add("tags", rows);
            }

            if (sections.Contains("network"))
            {
                data.Add("network", aml.Network(devices));
            }

            if (sections.Contains("links") || sections.Contains("signals"))
            {
                AmlLinks links = aml.ResolveLinks();
                if (sections.Contains("links"))
                    data.Add("links", JsonList(links.Connections.Where(row => RowMentions(row, onlyDevice))));
                if (sections.Contains("signals"))
                    data.Add("signals", JsonList(links.Signals.Where(row => RowMentions(row, onlyDevice))));
            }

            if (sections.Contains("f"))
            {
                List<JsonObject> rows = new List<JsonObject>();
                foreach (AmlDevice device in devices)
                    foreach (AmlRack rack in device.Racks())
                        foreach (AmlModule module in rack.Modules)
                        {
                            JsonObject row = module.FAddresses();
                            if (row == null) continue;
                            row.Add("device", device.Name);
                            row.Add("slot", module.Slot);
                            rows.Add(row);
                        }
                data.Add("fAddresses", rows);
            }

            log.Info("Read the configured hardware data (" + string.Join(", ", sections.ToArray()) + ") from "
                + Text.Quote(aml.Path) + ".");
            return data;
        }

        // ------------------------------------------------------------- helpers

        /// <summary>
        /// True when a link/signal row touches <paramref name="device"/>: the filter has
        /// to look inside the nested sides, because those rows are built from two objects
        /// and carry no top-level `device`.
        /// </summary>
        private static bool RowMentions(JsonObject row, string device)
        {
            if (string.IsNullOrWhiteSpace(device)) return true;
            if (string.Equals(JsonObject.ReadString(row, "device", null), device, StringComparison.Ordinal)) return true;
            foreach (string key in new[] { "sideA", "sideB", "channel", "tag" })
            {
                JsonObject nested = row[key] as JsonObject;
                if (nested != null && string.Equals(JsonObject.ReadString(nested, "device", null), device, StringComparison.Ordinal)) return true;
            }
            return false;
        }
        private static Dictionary<string, int> EmptyChannelCounts()        {
            Dictionary<string, int> counts = new Dictionary<string, int>(StringComparer.Ordinal);
            counts["di"] = 0;
            counts["do"] = 0;
            counts["ai"] = 0;
            counts["ao"] = 0;
            counts["total"] = 0;
            return counts;
        }

        private static JsonObject ToJson(Dictionary<string, int> counts)
        {
            JsonObject json = new JsonObject();
            foreach (KeyValuePair<string, int> pair in counts) json.Add(pair.Key, pair.Value);
            return json;
        }

        private static List<JsonObject> JsonList(IEnumerable<JsonObject> items)
        {
            return new List<JsonObject>(items);
        }
    }

    // ---------------------------------------------------------------- the reader

    /// <summary>
    /// One loaded CAx/AML document. Deliberately thin: it resolves the tree into the
    /// three shapes the operations need (devices/racks/modules, network, links), and
    /// keeps no state between calls.
    /// </summary>
    internal sealed class AmlDocument
    {
        public string Path { get; private set; }
        public XDocument Xml { get; private set; }
        public XElement Project { get; private set; }

        private readonly Dictionary<string, XElement> _byId = new Dictionary<string, XElement>(StringComparer.Ordinal);

        /// <summary>
        /// Loads and validates an export. The default path is the workspace export
        /// location, so a caller that just ran the export needs no argument.
        /// </summary>
        public static AmlDocument Open(string requested, bool required)
        {
            string path = Resolve(requested);
            if (!File.Exists(path))
            {
                if (!required) return null;
                throw new ControllerException("hardware_aml_not_found",
                    "No hardware configuration export exists at " + Text.Quote(path)
                        + ". Run ExportHardwareConfig (tool export_hardware_config) first.",
                    JsonObject.Of("aml", path));
            }

            XDocument xml;
            try
            {
                xml = XDocument.Load(path, LoadOptions.None);
            }
            catch (Exception ex)
            {
                throw new ControllerException("invalid_aml",
                    "The file at " + Text.Quote(path) + " is not readable XML: " + ex.Message,
                    JsonObject.Of("aml", path));
            }

            if (xml.Root == null || xml.Root.Name.LocalName != "CAEXFile")
            {
                throw new ControllerException("invalid_aml",
                    "The file at " + Text.Quote(path) + " is not a CAEX/AML document (root element "
                        + Text.Quote(xml.Root == null ? "(none)" : xml.Root.Name.LocalName) + ", expected CAEXFile).",
                    JsonObject.Of("aml", path));
            }

            XElement hierarchy = xml.Root.Elements("InstanceHierarchy").FirstOrDefault();
            XElement project = hierarchy == null ? null : hierarchy.Elements("InternalElement").FirstOrDefault();
            if (project == null)
            {
                throw new ControllerException("invalid_aml",
                    "The CAEX file at " + Text.Quote(path) + " has no InstanceHierarchy/InternalElement, so it holds no hardware.",
                    JsonObject.Of("aml", path));
            }

            AmlDocument document = new AmlDocument();
            document.Path = path;
            document.Xml = xml;
            document.Project = project;
            foreach (XElement element in xml.Descendants("InternalElement"))
            {
                string id = element.Attribute("ID")?.Value;
                if (!string.IsNullOrEmpty(id)) document._byId[id] = element;
            }
            return document;
        }

        private static string Resolve(string requested)
        {
            if (!string.IsNullOrWhiteSpace(requested)) return System.IO.Path.GetFullPath(requested.Trim().Trim('"'));
            string cwd = Directory.GetCurrentDirectory();
            return System.IO.Path.Combine(cwd, "hardware", "globalHardware.aml");
        }

        /// <summary>The header block every operation returns: where the data came from and how fresh it is.</summary>
        public JsonObject Header()
        {
            FileInfo info = new FileInfo(Path);
            JsonObject header = new JsonObject();
            JsonObject aml = new JsonObject();
            aml.Add("path", Path);
            aml.Add("bytes", info.Length);
            aml.Add("sha256", Hashing.Sha256OfFile(Path));
            aml.Add("schemaVersion", Xml.Root.Attribute("SchemaVersion")?.Value);
            aml.Add("project", Project.Attribute("Name")?.Value);
            header.Add("aml", aml);
            return header;
        }

        // -------------------------------------------------------------- devices

        /// <summary>Every device in the tree, with the user-group path that contains it.</summary>
        public List<AmlDevice> Devices()
        {
            List<AmlDevice> devices = new List<AmlDevice>();
            Walk(Project, new List<string>(), devices);
            return devices;
        }

        private void Walk(XElement parent, List<string> groups, List<AmlDevice> devices)
        {
            foreach (XElement child in parent.Elements("InternalElement"))
            {
                string role = Aml.Role(child);
                if (string.Equals(role, "Device", StringComparison.Ordinal))
                {
                    devices.Add(new AmlDevice(child, groups.ToList()));
                    continue;
                }
                // Subnets are siblings of devices, not groups: they carry a subnet endpoint
                // and their only attribute is Type=Ethernet.
                if (child.Elements("ExternalInterface").Any(i => Aml.InterfaceName(i) == "LogicalEndPoint_Subnet")) continue;

                groups.Add(child.Attribute("Name")?.Value);
                Walk(child, groups, devices);
                groups.RemoveAt(groups.Count - 1);
            }
        }

        public IEnumerable<XElement> Subnets()
        {
            return Project.Elements("InternalElement").Where(e =>
                !string.Equals(Aml.Role(e), "Device", StringComparison.Ordinal)
                && e.Elements("ExternalInterface").Any(i => Aml.InterfaceName(i) == "LogicalEndPoint_Subnet"));
        }

        // -------------------------------------------------------------- network

        public JsonObject Network(List<AmlDevice> devices)
        {
            List<JsonObject> subnets = new List<JsonObject>();
            foreach (XElement subnet in Subnets())
            {
                JsonObject row = new JsonObject();
                row.Add("name", subnet.Attribute("Name")?.Value);
                row.AddIfPresent("type", Aml.Attr(subnet, "Type"));
                subnets.Add(row);
            }

            List<JsonObject> nodes = new List<JsonObject>();
            List<JsonObject> ioSystems = new List<JsonObject>();
            foreach (AmlDevice device in devices)
            {
                // The network interface is the element that *directly* holds the node
                // ("Interface PROFINET_1", Label X1) — not the rack above it and not the
                // node below it, so pick the element whose child carries NetworkAddress.
                foreach (XElement element in device.Element.Descendants("InternalElement").ToList())
                {
                    List<XElement> children = element.Elements("InternalElement").ToList();

                    XElement node = children.FirstOrDefault(c => Aml.Attr(c, "NetworkAddress") != null);
                    if (node != null)
                    {
                        JsonObject row = new JsonObject();
                        row.Add("device", device.Name);
                        row.AddIfPresent("interface", Aml.Attr(element, "Label") ?? element.Attribute("Name")?.Value);
                        row.AddIfPresent("interfaceName", element.Attribute("Name")?.Value);
                        row.AddIfPresent("port", Aml.Attr(node, "Name"));
                        row.AddIfPresent("ip", Aml.Attr(node, "NetworkAddress"));
                        row.AddIfPresent("subnetMask", Aml.Attr(node, "SubnetMask"));
                        row.AddIfPresent("profinetName", Aml.Attr(node, "ProfinetDeviceName"));
                        row.AddIfPresent("ipProtocolSelection", Aml.Attr(node, "IpProtocolSelection"));
                        row.AddIfPresent("routerAddress", Aml.Attr(node, "RouterAddress"));
                        nodes.Add(row);
                    }

                    XElement ioSystem = children.FirstOrDefault(c =>
                        (c.Attribute("Name")?.Value ?? string.Empty).IndexOf("IO-System", StringComparison.OrdinalIgnoreCase) >= 0);
                    if (ioSystem != null)
                    {
                        JsonObject row = new JsonObject();
                        row.Add("device", device.Name);
                        row.AddIfPresent("name", ioSystem.Attribute("Name")?.Value);
                        row.AddIfPresent("number", Aml.Attr(ioSystem, "Number"));
                        row.AddIfPresent("interface", Aml.Attr(element, "Label") ?? element.Attribute("Name")?.Value);
                        ioSystems.Add(row);
                    }
                }
            }

            JsonObject network = new JsonObject();
            network.Add("subnets", subnets);
            network.Add("nodes", nodes);
            network.Add("ioSystems", ioSystems);
            return network;
        }

        // ---------------------------------------------------------------- links

        /// <summary>
        /// The &lt;InternalLink&gt; set, resolved from interface IDs to the objects they
        /// join. Four kinds occur in a V17 export: port-to-port cabling, node-to-subnet,
        /// interface-to-IO-system and channel-to-tag signal mapping.
        /// </summary>
        public AmlLinks ResolveLinks()
        {
            AmlLinks result = new AmlLinks();
            foreach (XElement link in Xml.Descendants("InternalLink"))
            {
                string a = link.Attribute("RefPartnerSideA")?.Value;
                string b = link.Attribute("RefPartnerSideB")?.Value;
                if (string.IsNullOrEmpty(a) || string.IsNullOrEmpty(b)) continue;

                AmlSide sideA = ResolveSide(a);
                AmlSide sideB = ResolveSide(b);
                if (sideA == null || sideB == null) continue;

                if (Aml.IsPort(sideA) && Aml.IsPort(sideB))
                {
                    result.Connections.Add(PortLink(link, sideA, sideB, "port-port"));
                }
                else if (IsSubnetPair(sideA, sideB))
                {
                    result.Connections.Add(PortLink(link, sideA, sideB, "node-subnet"));
                }
                else if (IsIoSystemPair(sideA, sideB))
                {
                    result.Connections.Add(PortLink(link, sideA, sideB, "interface-iosystem"));
                }
                else if (Aml.IsChannel(sideA) && Aml.IsTag(sideB))
                {
                    result.Signals.Add(Signal(link, sideA, sideB));
                }
                else if (Aml.IsChannel(sideB) && Aml.IsTag(sideA))
                {
                    result.Signals.Add(Signal(link, sideB, sideA));
                }
            }
            return result;
        }

        private static bool IsSubnetPair(AmlSide a, AmlSide b)
        {
            return (a.Name == "LogicalEndPoint_Node" && b.Name == "LogicalEndPoint_Subnet")
                || (b.Name == "LogicalEndPoint_Node" && a.Name == "LogicalEndPoint_Subnet");
        }

        private static bool IsIoSystemPair(AmlSide a, AmlSide b)
        {
            return (a.Name == "LogicalEndPoint_Interface" && b.Name == "LogicalEndPoint_IoSystem")
                || (b.Name == "LogicalEndPoint_Interface" && a.Name == "LogicalEndPoint_IoSystem");
        }

        private JsonObject PortLink(XElement link, AmlSide a, AmlSide b, string kind)
        {
            JsonObject row = new JsonObject();
            row.AddIfPresent("name", link.Attribute("Name")?.Value);
            row.Add("kind", kind);
            row.Add("sideA", DescribeSide(a));
            row.Add("sideB", DescribeSide(b));
            return row;
        }

        private JsonObject Signal(XElement link, AmlSide channel, AmlSide tag)
        {
            JsonObject row = new JsonObject();
            row.AddIfPresent("name", link.Attribute("Name")?.Value);
            JsonObject channelRow = new JsonObject();
            channelRow.AddIfPresent("device", DeviceNameOf(channel.Element));
            channelRow.AddIfPresent("module", channel.Element.Attribute("Name")?.Value);
            channelRow.AddIfPresent("slot", Aml.Attr(channel.Element, "PositionNumber"));
            channelRow.Add("channel", channel.Name);
            row.Add("channel", channelRow);
            JsonObject tagRow = new JsonObject();
            tagRow.AddIfPresent("device", DeviceNameOf(tag.Element));
            tagRow.Add("name", tag.Name);
            tagRow.AddIfPresent("logicalAddress", Aml.Attr(tag.Interface, "LogicalAddress"));
            tagRow.AddIfPresent("dataType", Aml.Attr(tag.Interface, "DataType"));
            row.Add("tag", tagRow);
            return row;
        }

        private JsonObject DescribeSide(AmlSide side)
        {
            JsonObject row = new JsonObject();
            row.AddIfPresent("device", DeviceNameOf(side.Element));
            row.AddIfPresent("element", side.Element.Attribute("Name")?.Value);
            row.Add("interface", side.Name);
            string label = Aml.Attr(side.Element, "Label");
            if (label != null && side.Interface != null && side.Name == "CommunicationPortInterface") row.Add("label", label);
            if (side.Interface != null) row.AddIfPresent("interfaceClass", Aml.ClassOf(side.Interface));
            return row;
        }

        private AmlSide ResolveSide(string reference)
        {
            int colon = reference.IndexOf(':');
            if (colon <= 0) return null;
            string id = reference.Substring(0, colon);
            string name = reference.Substring(colon + 1);
            XElement element;
            if (!_byId.TryGetValue(id, out element)) return null;
            XElement iface = element.Elements("ExternalInterface")
                .FirstOrDefault(i => (i.Attribute("Name")?.Value ?? string.Empty) == name);
            return new AmlSide { Element = element, Name = name, Interface = iface };
        }

        /// <summary>The device an element belongs to, found by walking the parent chain.</summary>
        public string DeviceNameOf(XElement element)
        {
            XElement current = element;
            while (current != null)
            {
                if (string.Equals(Aml.Role(current), "Device", StringComparison.Ordinal)
                    || ReferenceEquals(current, Project))
                {
                    return current.Attribute("Name")?.Value;
                }
                current = current.Parent;
            }
            return null;
        }
    }

    /// <summary>One resolved side of an &lt;InternalLink&gt;.</summary>
    internal sealed class AmlSide
    {
        public XElement Element { get; set; }
        public string Name { get; set; }
        public XElement Interface { get; set; }
    }

    /// <summary>Resolved link sets, split by what they describe.</summary>
    internal sealed class AmlLinks
    {
        public readonly List<JsonObject> Connections = new List<JsonObject>();
        public readonly List<JsonObject> Signals = new List<JsonObject>();
    }

    /// <summary>A device: an InternalElement with role <c>Device</c>, plus its group path.</summary>
    internal sealed class AmlDevice
    {
        public XElement Element { get; private set; }
        public List<string> Groups { get; private set; }

        public AmlDevice(XElement element, List<string> groups)
        {
            Element = element;
            Groups = groups;
        }

        public string Name { get { return Element.Attribute("Name")?.Value; } }

        public JsonObject Describe(bool includeComments)
        {
            JsonObject row = new JsonObject();
            row.Add("name", Name);
            row.AddIfPresent("roleClass", Aml.Role(Element));
            row.AddIfPresent("groupPath", Groups.Count == 0 ? null : string.Join("/", Groups.ToArray()));
            string typeIdentifier = Aml.Attr(Element, "TypeIdentifier");
            row.AddIfPresent("typeIdentifier", typeIdentifier);
            row.AddIfPresent("orderNumber", Aml.OrderNumberOf(typeIdentifier));
            row.AddIfPresent("typeName", Aml.Attr(Element, "TypeName"));
            row.AddIfPresent("firmwareVersion", Aml.Attr(Element, "FirmwareVersion"));
            row.AddIfPresent("plantDesignation", Aml.Attr(Element, "PlantDesignation IEC"));
            row.AddIfPresent("locationIdentifier", Aml.Attr(Element, "LocationIdentifier IEC"));
            if (includeComments) row.AddIfPresent("comment", Aml.Attr(Element, "Comment"));
            return row;
        }

        /// <summary>Racks of this device. A device without a rack exposes its items directly.</summary>
        public List<AmlRack> Racks()
        {
            List<AmlRack> racks = new List<AmlRack>();
            List<XElement> children = Element.Elements("InternalElement").ToList();
            List<XElement> rackElements = children
                .Where(c => string.Equals(Aml.Attr(c, "TypeName"), "Rack", StringComparison.Ordinal))
                .ToList();
            if (rackElements.Count == 0)
            {
                // No explicit rack: present the device itself as a single flat rack so the
                // module list is never empty for device kinds that omit one.
                racks.Add(new AmlRack(this, Element, children));
                return racks;
            }
            foreach (XElement rack in rackElements) racks.Add(new AmlRack(this, rack, null));
            return racks;
        }
    }

    /// <summary>A rack inside a device.</summary>
    internal sealed class AmlRack
    {
        private readonly AmlDevice _device;
        private readonly List<XElement> _flat;

        public XElement Element { get; private set; }
        public List<AmlModule> Modules { get; private set; }

        public AmlRack(AmlDevice device, XElement element, List<XElement> flatModules)
        {
            _device = device;
            Element = element;
            _flat = flatModules;
            Modules = new List<AmlModule>();
            IEnumerable<XElement> modules = flatModules ?? element.Elements("InternalElement");
            foreach (XElement module in modules) Modules.Add(new AmlModule(device, module));
        }

        public string Name { get { return Element.Attribute("Name")?.Value; } }

        public JsonObject Describe(bool includeComments, bool includeCounts)
        {
            JsonObject row = new JsonObject();
            row.Add("name", Name);
            row.AddIfPresent("typeIdentifier", Aml.Attr(Element, "TypeIdentifier"));
            row.AddIfPresent("slot", Aml.Attr(Element, "PositionNumber"));
            List<JsonObject> modules = new List<JsonObject>();
            foreach (AmlModule module in Modules) modules.Add(module.Describe(includeComments, includeCounts));
            row.Add("modules", modules);
            return row;
        }
    }

    /// <summary>One pluggable module (or the head module) inside a rack.</summary>
    internal sealed class AmlModule
    {
        private readonly AmlDevice _device;

        public XElement Element { get; private set; }

        public AmlModule(AmlDevice device, XElement element)
        {
            _device = device;
            Element = element;
        }

        public string Name { get { return Element.Attribute("Name")?.Value; } }
        public string Slot { get { return Aml.Attr(Element, "PositionNumber"); } }

        public JsonObject Describe(bool includeComments, bool includeCounts)
        {
            JsonObject row = new JsonObject();
            row.AddIfPresent("slot", Slot);
            row.Add("name", Name);
            row.AddIfPresent("roleClass", Aml.Role(Element));
            string typeIdentifier = Aml.Attr(Element, "TypeIdentifier");
            row.AddIfPresent("typeIdentifier", typeIdentifier);
            row.AddIfPresent("orderNumber", Aml.OrderNumberOf(typeIdentifier));
            row.AddIfPresent("typeName", Aml.Attr(Element, "TypeName"));
            row.AddIfPresent("deviceItemType", Aml.Attr(Element, "DeviceItemType"));
            row.AddIfPresent("builtIn", Aml.Attr(Element, "BuiltIn"));
            row.AddIfPresent("firmwareVersion", Aml.Attr(Element, "FirmwareVersion"));
            if (includeComments) row.AddIfPresent("comment", Aml.Attr(Element, "Comment"));
            if (includeCounts)
            {
                Dictionary<string, int> counts = ChannelCounts();
                JsonObject json = new JsonObject();
                foreach (KeyValuePair<string, int> pair in counts) json.Add(pair.Key, pair.Value);
                row.Add("channels", json);
            }
            return row;
        }

        /// <summary>Channel counts by direction, derived from the &lt;Channel&gt; interfaces.</summary>
        public Dictionary<string, int> ChannelCounts()
        {
            Dictionary<string, int> counts = new Dictionary<string, int>(StringComparer.Ordinal);
            counts["di"] = 0; counts["do"] = 0; counts["ai"] = 0; counts["ao"] = 0; counts["total"] = 0;
            foreach (XElement channel in ChannelInterfaces())
            {
                string type = Aml.Attr(channel, "Type") ?? string.Empty;
                string ioType = Aml.Attr(channel, "IoType") ?? string.Empty;
                bool analog = type.IndexOf("Analog", StringComparison.OrdinalIgnoreCase) >= 0;
                bool output = ioType.IndexOf("Output", StringComparison.OrdinalIgnoreCase) >= 0;
                string key = analog ? (output ? "ao" : "ai") : (output ? "do" : "di");
                counts[key]++;
                counts["total"]++;
            }
            return counts;
        }

        public List<JsonObject> Channels()
        {
            List<JsonObject> rows = new List<JsonObject>();
            foreach (XElement channel in ChannelInterfaces())
            {
                JsonObject row = new JsonObject();
                row.Add("name", channel.Attribute("Name")?.Value);
                row.AddIfPresent("type", Aml.Attr(channel, "Type"));
                row.AddIfPresent("ioType", Aml.Attr(channel, "IoType"));
                row.AddIfPresent("number", Aml.Attr(channel, "Number"));
                row.AddIfPresent("width", Aml.Attr(channel, "Length"));
                rows.Add(row);
            }
            return rows;
        }

        /// <summary>
        /// The I/O address groups of this module. The AML nests them as
        /// Attribute[@Name='Address'] → Attribute[@Name='1'|'2'] → StartAddress/Length/IoType,
        /// so they are not element attributes and need their own walk.
        /// </summary>
        public List<JsonObject> Addresses()
        {
            List<JsonObject> rows = new List<JsonObject>();
            foreach (XElement address in Element.Descendants("Attribute")
                .Where(a => string.Equals(a.Attribute("Name")?.Value, "Address", StringComparison.Ordinal)))
            {
                foreach (XElement group in address.Elements("Attribute"))
                {
                    string start = Aml.Attr(group, "StartAddress");
                    string length = Aml.Attr(group, "Length");
                    if (start == null && length == null) continue;
                    JsonObject row = new JsonObject();
                    row.AddIfPresent("group", group.Attribute("Name")?.Value);
                    row.AddIfPresent("ioType", Aml.Attr(group, "IoType"));
                    row.AddIfPresent("startAddress", start);
                    row.AddIfPresent("length", length);
                    rows.Add(row);
                }
            }
            return rows;
        }

        public JsonObject FAddresses()
        {
            string source = Aml.Attr(Element, "Failsafe_FSourceAddress");
            string destination = Aml.Attr(Element, "Failsafe_FDestinationAddress");
            if (source == null && destination == null) return null;
            JsonObject row = new JsonObject();
            row.AddIfPresent("module", Name);
            row.AddIfPresent("fSourceAddress", source);
            row.AddIfPresent("fDestinationAddress", destination);
            row.AddIfPresent("fLowerBound", Aml.Attr(Element, "Failsafe_LowerBoundForFDestinationAddresses"));
            row.AddIfPresent("fUpperBound", Aml.Attr(Element, "Failsafe_UpperBoundForFDestinationAddresses"));
            return row;
        }

        private IEnumerable<XElement> ChannelInterfaces()
        {
            return Element.Descendants("ExternalInterface")
                .Where(i => Aml.ClassOf(i).EndsWith("/Channel", StringComparison.Ordinal));
        }
    }

    /// <summary>Attribute, role and class helpers shared by the readers above.</summary>
    internal static class Aml
    {
        /// <summary>Reads a child &lt;Attribute Name="…"&gt;&lt;Value&gt;…&lt;/Value&gt;&lt;/Attribute&gt;.</summary>
        public static string Attr(XElement element, string name)
        {
            if (element == null) return null;
            XElement attribute = element.Elements("Attribute")
                .FirstOrDefault(a => string.Equals(a.Attribute("Name")?.Value, name, StringComparison.Ordinal));
            if (attribute == null) return null;
            XElement value = attribute.Element("Value");
            if (value == null) return null;
            string text = value.Value.Trim();
            return text.Length == 0 ? null : text;
        }

        /// <summary>The last segment of SupportedRoleClass/RefRoleClassPath, or null.</summary>
        public static string Role(XElement element)
        {
            if (element == null) return null;
            XElement role = element.Elements("SupportedRoleClass").FirstOrDefault();
            string path = role?.Attribute("RefRoleClassPath")?.Value;
            if (string.IsNullOrEmpty(path)) return null;
            int slash = path.LastIndexOf('/');
            return slash >= 0 ? path.Substring(slash + 1) : path;
        }

        public static string ClassOf(XElement iface)
        {
            return iface?.Attribute("RefBaseClassPath")?.Value ?? string.Empty;
        }

        public static string InterfaceName(XElement iface)
        {
            return string.Equals(ClassOf(iface), "CommunicationInterfaceClassLib/LogicalEndPoint", StringComparison.Ordinal)
                ? iface.Attribute("Name")?.Value
                : iface.Attribute("Name")?.Value;
        }

        public static bool IsPort(AmlSide side) { return side.Name == "CommunicationPortInterface"; }
        public static bool IsChannel(AmlSide side) { return side.Name.StartsWith("Channel_", StringComparison.Ordinal); }
        public static bool IsTag(AmlSide side) { return ClassOf(side.Interface).EndsWith("/Tag", StringComparison.Ordinal); }

        /// <summary>The MLFB of an <c>OrderNumber:</c> identifier, or null for GSD/System types.</summary>
        public static string OrderNumberOf(string typeIdentifier)
        {
            if (string.IsNullOrEmpty(typeIdentifier)) return null;
            const string prefix = "OrderNumber:";
            if (!typeIdentifier.StartsWith(prefix, StringComparison.Ordinal)) return null;
            return typeIdentifier.Substring(prefix.Length).Trim();
        }
    }
}
