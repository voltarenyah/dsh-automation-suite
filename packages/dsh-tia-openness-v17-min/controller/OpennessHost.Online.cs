using System;
using System.Collections.Generic;
using System.Globalization;
using Siemens.Engineering;
using Siemens.Engineering.HW;
using Siemens.Engineering.HW.Features;
using Siemens.Engineering.Online;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>
    /// Device/network helpers for the online + download surface.
    ///
    /// The matrix chapter "Functions for accessing the data of a PLC device"
    /// splits online, download and upload, but all three resolve their target the
    /// same way: a <c>DeviceItem</c> that returns an <c>OnlineProvider</c> (or a
    /// <c>DownloadProvider</c>), then a <c>ConnectionConfiguration</c> whose
    /// Modes → PcInterfaces → TargetInterfaces chain names the connection the TIA
    /// Portal UI would use. Everything here is discovery only — nothing connects.
    /// </summary>
    internal sealed partial class OpennessHost
    {
        internal const string ConnectionModeName = "PN/IE";

        /// <summary>One configured (offline) node of a device's network interface.</summary>
        internal sealed class OfflineNodeInfo
        {
            public string Device;
            public string DeviceItem;
            public string Node;
            public string NodeId;
            public string NetType;
            public string InterfaceType;
            public string Address;
            public string SubnetMask;
            public string PnDeviceName;
            public string UseRouter;
            public string RouterAddress;
            public string IpProtocol;
            public string Subnet;
        }

        /// <summary>All devices of the open project, user groups included.</summary>
        public List<Device> CollectDevices()
        {
            EnsureProjectOpen("CollectDevices");
            List<Device> found = new List<Device>();
            foreach (Device device in _project.Devices) found.Add(device);
            DeviceSystemGroup ungrouped = _project.UngroupedDevicesGroup;
            if (ungrouped != null)
            {
                foreach (Device device in ungrouped.Devices) found.Add(device);
            }
            foreach (DeviceUserGroup group in _project.DeviceGroups) CollectDevices(group, found);
            return found;
        }

        private static void CollectDevices(DeviceUserGroup group, List<Device> found)
        {
            foreach (Device device in group.Devices) found.Add(device);
            foreach (DeviceUserGroup child in group.Groups) CollectDevices(child, found);
        }

        /// <summary>Devices whose name matches exactly; the error lists what exists.</summary>
        public Device FindDevice(string name)
        {
            List<Device> devices = CollectDevices();
            if (string.IsNullOrEmpty(name)) return null;
            foreach (Device device in devices)
            {
                if (string.Equals(device.Name, name, StringComparison.OrdinalIgnoreCase)) return device;
            }
            List<string> names = new List<string>();
            foreach (Device device in devices) names.Add(device.Name);
            throw new ControllerException(
                "device_not_found",
                "No device named " + Text.Quote(name) + " in the open project.",
                JsonObject.Of("requested", name, "available", names));
        }

        /// <summary>Every device item of a device, depth first.</summary>
        public static List<DeviceItem> FlattenDeviceItems(Device device)
        {
            List<DeviceItem> items = new List<DeviceItem>();
            foreach (DeviceItem item in device.DeviceItems) Flatten(item, items);
            return items;
        }

        private static void Flatten(DeviceItem item, List<DeviceItem> items)
        {
            items.Add(item);
            foreach (DeviceItem child in item.DeviceItems) Flatten(child, items);
        }

        /// <summary>The CPU device item, or null when the device has none.</summary>
        public static DeviceItem FindCpuItem(Device device)
        {
            foreach (DeviceItem item in FlattenDeviceItems(device))
            {
                if (item.Classification == DeviceItemClassifications.CPU) return item;
            }
            return null;
        }

        /// <summary>
        /// The device item that carries the online service. The manual puts the
        /// provider on the CPU; devices without one simply have no online surface.
        /// </summary>
        public static OnlineProvider FindOnlineProvider(DeviceItem item)
        {
            try
            {
                return item.GetService<OnlineProvider>();
            }
            catch (Exception)
            {
                // Older/odd device items throw instead of returning null.
                return null;
            }
        }

        /// <summary>
        /// The service that downloads to a device. Null when the device item is not
        /// a downloadable target (the manual: an F-activated PLC is not supported).
        /// </summary>
        public static Siemens.Engineering.Download.DownloadProvider FindDownloadProvider(DeviceItem item)
        {
            try
            {
                return item.GetService<Siemens.Engineering.Download.DownloadProvider>();
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// Reads the offline (configured) address data of one device: every
        /// network interface's nodes with Address / SubnetMask / router settings
        /// and the subnet the node is assigned to.
        /// </summary>
        public List<OfflineNodeInfo> DescribeOfflineNodes(Device device)
        {
            List<OfflineNodeInfo> nodes = new List<OfflineNodeInfo>();
            foreach (DeviceItem item in FlattenDeviceItems(device))
            {
                NetworkInterface networkInterface;
                try
                {
                    networkInterface = item.GetService<NetworkInterface>();
                }
                catch (Exception)
                {
                    networkInterface = null;
                }
                if (networkInterface == null) continue;

                foreach (Node node in networkInterface.Nodes)
                {
                    OfflineNodeInfo info = new OfflineNodeInfo
                    {
                        Device = device.Name,
                        DeviceItem = item.Name,
                        Node = node.Name,
                        NodeId = ReadOrNull(() => node.NodeId),
                        NetType = ReadOrNull(() => node.NodeType.ToString()),
                        InterfaceType = ReadOrNull(() => networkInterface.InterfaceType.ToString()),
                        Address = SafeAttribute(node, "Address"),
                        SubnetMask = SafeAttribute(node, "SubnetMask"),
                        PnDeviceName = SafeAttribute(node, "PnDeviceName"),
                        UseRouter = SafeAttribute(node, "UseRouter"),
                        RouterAddress = SafeAttribute(node, "RouterAddress"),
                        IpProtocol = SafeAttribute(node, "IpProtocolSelection"),
                        Subnet = ReadOrNull(() => node.ConnectedSubnet == null ? null : node.ConnectedSubnet.Name),
                    };
                    nodes.Add(info);
                }
            }
            return nodes;
        }

        /// <summary>
        /// A node attribute is a dynamic attribute: it exists only for the node
        /// types that have it, and reading a missing one throws.
        /// </summary>
        private static string SafeAttribute(Node node, string name)
        {
            try
            {
                object value = node.GetAttribute(name);
                return value == null ? null : Convert.ToString(value, CultureInfo.InvariantCulture);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static string ReadOrNull(Func<string> read)
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
    }
}
