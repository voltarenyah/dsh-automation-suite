using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Security;
using System.Threading;
using Siemens.Engineering;
using Siemens.Engineering.Connection;
using Siemens.Engineering.Download;
using Siemens.Engineering.Download.Configurations;
using Siemens.Engineering.HW;
using Siemens.Engineering.Online;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>
    /// The online half of "Functions for accessing the data of a PLC device":
    /// target discovery, the controller-held online session, and its lifecycle.
    ///
    /// The split is deliberate. Discovery is read-only and cannot disturb a
    /// running plant, so it is one operation; connecting is stateful — the
    /// Openness provider must outlive the request that created it — so the
    /// controller keeps exactly one session and reports it through
    /// <c>OnlineStatus</c>. Downloads build on the same session state and are
    /// handled separately.
    /// </summary>
    internal sealed partial class OpennessOperations
    {
        /// <summary>The one online session the controller keeps at a time.</summary>
        private sealed class OnlineSession
        {
            public string Device;
            public string DeviceItem;
            public string Mode;
            public string PcInterface;
            public int PcInterfaceNumber;
            public string TargetInterface;
            public string Address;
            public string Kind;
            public string Owner;
            public DateTime ConnectedAt;
            public OnlineProvider Provider;
        }

        private sealed class PcSubnetInfo
        {
            public string Name;
            public List<JsonObject> Addresses;
            public List<JsonObject> Gateways;
        }

        private sealed class PcInterfaceInfo
        {
            public string Device;
            public string Mode;
            public string Name;
            public string Kind;
            public int Number;
            public List<string> TargetInterfaces;
            public List<PcSubnetInfo> Subnets;

            public JsonObject ToJson()
            {
                JsonObject entry = new JsonObject();
                entry.Add("device", Device);
                entry.Add("mode", Mode);
                entry.Add("pcInterface", Name);
                entry.Add("pcInterfaceNumber", Number);
                entry.Add("kind", Kind);
                entry.Add("targetInterfaces", TargetInterfaces);
                List<JsonObject> subnets = new List<JsonObject>();
                foreach (PcSubnetInfo subnet in Subnets)
                {
                    JsonObject item = new JsonObject();
                    item.Add("name", subnet.Name);
                    item.Add("addresses", subnet.Addresses);
                    item.Add("gateways", subnet.Gateways);
                    subnets.Add(item);
                }
                entry.Add("subnets", subnets);
                return entry;
            }
        }

        private sealed class ResolvedOnlineTarget
        {
            public string Device;
            public string DeviceItem;
            public OnlineProvider Provider;
            public ConnectionConfiguration Configuration;
            public string Mode;
            public ConfigurationPcInterface PcInterface;
            public string TargetInterface;
            public string Address;
            public IConfiguration Target;
            public ConfigurationTargetInterface Slot;
            public ConfigurationAddress AddressConfig;
            public string Kind;
        }

        private OnlineSession _onlineSession;

        // ------------------------------------------------------- OnlineTargets

        /// <summary>
        /// Read-only discovery: which devices can be reached, which PC interfaces
        /// the local machine offers (the PLCSIM virtual adapter shows up here as
        /// well), which subnet each device is configured in, and which PC
        /// interface/subnet pair could reach it.
        /// </summary>
        private JsonObject OnlineTargets(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string deviceFilter = p.String("device_name", null);
            bool includeNodes = p.Bool("include_offline_nodes", true);
            int maxItems = p.Int("max_items", DefaultMaxItems);
            if (maxItems <= 0) maxItems = DefaultMaxItems;

            List<Device> devices = _host.CollectDevices();
            if (!string.IsNullOrEmpty(deviceFilter))
            {
                List<Device> selected = new List<Device>();
                foreach (Device device in devices)
                {
                    if (string.Equals(device.Name, deviceFilter, StringComparison.OrdinalIgnoreCase)) selected.Add(device);
                }
                if (selected.Count == 0)
                {
                    throw new ControllerException(
                        "device_not_found",
                        "No device named " + Text.Quote(deviceFilter) + " in the open project.",
                        JsonObject.Of("requested", deviceFilter, "available", DeviceNames(devices)));
                }
                devices = selected;
            }

            List<JsonObject> devicePayloads = new List<JsonObject>();
            List<OpennessHost.OfflineNodeInfo> nodeInfos = new List<OpennessHost.OfflineNodeInfo>();
            List<PcInterfaceInfo> interfaces = new List<PcInterfaceInfo>();

            foreach (Device device in devices)
            {
                JsonObject deviceEntry = new JsonObject();
                deviceEntry.Add("device", device.Name);
                DeviceItem cpu = OpennessHost.FindCpuItem(device);
                deviceEntry.AddIfPresent("cpuItem", cpu == null ? null : cpu.Name);
                OnlineProvider provider = cpu == null ? null : OpennessHost.FindOnlineProvider(cpu);
                deviceEntry.Add("onlineProvider", provider != null);

                if (includeNodes)
                {
                    List<OpennessHost.OfflineNodeInfo> nodes = _host.DescribeOfflineNodes(device);
                    deviceEntry.Add("nodeCount", nodes.Count);
                    if (nodes.Count > maxItems) deviceEntry.Add("truncated", true);
                    nodeInfos.AddRange(nodes);
                }
                devicePayloads.Add(deviceEntry);

                if (provider != null) interfaces.AddRange(DescribeInterfaces(device.Name, provider));
            }

            List<JsonObject> unmatched = new List<JsonObject>();
            List<JsonObject> subnets = GroupNodesBySubnet(nodeInfos, interfaces, unmatched);

            List<JsonObject> interfacePayloads = new List<JsonObject>();
            foreach (PcInterfaceInfo info in interfaces) interfacePayloads.Add(info.ToJson());

            JsonObject data = new JsonObject();
            data.Add("deviceCount", devicePayloads.Count);
            data.Add("devices", devicePayloads);
            data.Add("interfaces", interfacePayloads);
            data.Add("subnets", subnets);
            data.Add("unmatchedNodes", unmatched);
            data.Add("mode", OpennessHost.ConnectionModeName);
            data.Add("connected", _onlineSession != null);
            data.Add("hint",
                "Pick subnets[].reachableBy[] and pass its mode / pcInterface / pcInterfaceNumber / targetInterfaces[0] "
                + "(or pcAddresses[0] as address=) to online_connect. kind \"virtual\" marks the PLCSIM adapter; "
                + "anything else is a real network interface.");
            return data;
        }

        /// <summary>The connection modes / PC interfaces / target slots of one device.</summary>
        private static List<PcInterfaceInfo> DescribeInterfaces(string deviceName, OnlineProvider provider)
        {
            List<PcInterfaceInfo> result = new List<PcInterfaceInfo>();
            ConnectionConfiguration configuration;
            try
            {
                configuration = provider.Configuration;
            }
            catch (Exception)
            {
                return result;
            }
            if (configuration == null) return result;

            foreach (ConfigurationMode mode in configuration.Modes)
            {
                foreach (ConfigurationPcInterface pcInterface in mode.PcInterfaces)
                {
                    PcInterfaceInfo entry = new PcInterfaceInfo
                    {
                        Device = deviceName,
                        Mode = mode.Name,
                        Name = pcInterface.Name,
                        Kind = ClassifyInterface(pcInterface.Name),
                        Number = pcInterface.Number,
                        TargetInterfaces = new List<string>(),
                        Subnets = new List<PcSubnetInfo>(),
                    };
                    foreach (ConfigurationTargetInterface target in pcInterface.TargetInterfaces) entry.TargetInterfaces.Add(target.Name);
                    foreach (ConfigurationSubnet subnet in pcInterface.Subnets)
                    {
                        PcSubnetInfo subnetInfo = new PcSubnetInfo
                        {
                            Name = subnet.Name,
                            Addresses = new List<JsonObject>(),
                            Gateways = new List<JsonObject>(),
                        };
                        foreach (ConfigurationAddress address in subnet.Addresses)
                        {
                            subnetInfo.Addresses.Add(JsonObject.Of("name", address.Name, "address", address.Address));
                        }
                        foreach (ConfigurationGateway gateway in subnet.Gateways)
                        {
                            List<string> gatewayAddresses = new List<string>();
                            foreach (ConfigurationAddress gatewayAddress in gateway.Addresses) gatewayAddresses.Add(gatewayAddress.Address);
                            subnetInfo.Gateways.Add(JsonObject.Of("name", gateway.Name, "addresses", gatewayAddresses));
                        }
                        entry.Subnets.Add(subnetInfo);
                    }
                    result.Add(entry);
                }
            }
            return result;
        }

        /// <summary>
        /// Groups the offline nodes by project subnet and attaches the PC
        /// interfaces that can reach that subnet (TIA Portal uses the same subnet
        /// name on both sides of the connection).
        /// </summary>
        private static List<JsonObject> GroupNodesBySubnet(List<OpennessHost.OfflineNodeInfo> nodes,
            List<PcInterfaceInfo> interfaces, List<JsonObject> unmatched)
        {
            List<string> order = new List<string>();
            Dictionary<string, List<OpennessHost.OfflineNodeInfo>> bySubnet =
                new Dictionary<string, List<OpennessHost.OfflineNodeInfo>>(StringComparer.OrdinalIgnoreCase);

            foreach (OpennessHost.OfflineNodeInfo node in nodes)
            {
                if (string.IsNullOrEmpty(node.Subnet))
                {
                    unmatched.Add(DescribeNode(node));
                    continue;
                }
                if (!bySubnet.ContainsKey(node.Subnet))
                {
                    bySubnet[node.Subnet] = new List<OpennessHost.OfflineNodeInfo>();
                    order.Add(node.Subnet);
                }
                bySubnet[node.Subnet].Add(node);
            }

            List<JsonObject> result = new List<JsonObject>();
            foreach (string subnetName in order)
            {
                JsonObject entry = new JsonObject();
                entry.Add("name", subnetName);

                List<JsonObject> members = new List<JsonObject>();
                foreach (OpennessHost.OfflineNodeInfo node in bySubnet[subnetName])
                {
                    members.Add(JsonObject.Of(
                        "device", node.Device,
                        "deviceItem", node.DeviceItem,
                        "node", node.Node,
                        "address", node.Address,
                        "subnetMask", node.SubnetMask,
                        "pnDeviceName", node.PnDeviceName));
                }
                entry.Add("nodes", members);

                List<JsonObject> reachable = new List<JsonObject>();
                foreach (PcInterfaceInfo info in interfaces)
                {
                    foreach (PcSubnetInfo subnet in info.Subnets)
                    {
                        if (!string.Equals(subnet.Name, subnetName, StringComparison.OrdinalIgnoreCase)) continue;
                        List<string> pcAddresses = new List<string>();
                        foreach (JsonObject address in subnet.Addresses) pcAddresses.Add(JsonObject.ReadString(address, "address", null));
                        reachable.Add(JsonObject.Of(
                            "mode", info.Mode,
                            "pcInterface", info.Name,
                            "pcInterfaceNumber", info.Number,
                            "kind", info.Kind,
                            "targetInterfaces", info.TargetInterfaces,
                            "pcAddresses", pcAddresses));
                        break;
                    }
                }
                entry.Add("reachableBy", reachable);
                result.Add(entry);
            }
            return result;
        }

        private static JsonObject DescribeNode(OpennessHost.OfflineNodeInfo node)
        {
            return JsonObject.Of(
                "device", node.Device,
                "deviceItem", node.DeviceItem,
                "node", node.Node,
                "address", node.Address,
                "subnetMask", node.SubnetMask,
                "pnDeviceName", node.PnDeviceName,
                "netType", node.NetType,
                "interfaceType", node.InterfaceType);
        }

        // ------------------------------------------------------- OnlineConnect

        /// <summary>
        /// Applies the connection configuration and goes online. The session is
        /// kept until <c>OnlineDisconnect</c> (or controller shutdown), because
        /// every later download/compare call needs the same provider instance.
        /// </summary>
        private JsonObject OnlineConnect(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            bool replace = p.Bool("replace", false);
            if (_onlineSession != null)
            {
                if (!replace)
                {
                    throw new ControllerException(
                        "online_already_connected",
                        "The controller already holds an online session to " + Text.Quote(_onlineSession.Device)
                            + ". Disconnect first, or pass replace=true to drop it.",
                        DescribeOnlineSession());
                }
                Disconnect();
            }

            ResolvedOnlineTarget target = ResolveOnlineTarget(p);
            int timeoutMs = p.Int("timeout_ms", 60000);
            if (timeoutMs <= 0) timeoutMs = 60000;
            string owner = p.String("owner", null);

            bool applied = target.Slot != null
                ? target.Configuration.ApplyConfiguration(target.Slot)
                : target.Configuration.ApplyConfiguration(target.AddressConfig);
            if (!applied)
            {
                throw new ControllerException(
                    "online_configuration_not_applied",
                    "ApplyConfiguration returned false; the target interface cannot be used for this device.",
                    JsonObject.Of("mode", target.Mode, "pcInterface", target.PcInterface.Name,
                        "targetInterface", target.TargetInterface, "address", target.Address));
            }

            Stopwatch watch = Stopwatch.StartNew();
            OnlineState state = OnlineState.Offline;
            Exception failure = null;
            try
            {
                target.Provider.GoOnline();
            }
            catch (Exception ex)
            {
                failure = ex;
            }

            if (failure == null)
            {
                while (watch.ElapsedMilliseconds < timeoutMs)
                {
                    state = target.Provider.State;
                    if (state == OnlineState.Online || state == OnlineState.NotReachable
                        || state == OnlineState.Incompatible || state == OnlineState.Protected)
                    {
                        break;
                    }
                    Thread.Sleep(250);
                }
                state = target.Provider.State;
            }

            JsonObject result = new JsonObject();
            result.Add("device", target.Device);
            result.Add("deviceItem", target.DeviceItem);
            result.Add("mode", target.Mode);
            result.Add("pcInterface", target.PcInterface.Name);
            result.Add("pcInterfaceNumber", target.PcInterface.Number);
            result.Add("kind", target.Kind);
            result.AddIfPresent("targetInterface", target.TargetInterface);
            result.AddIfPresent("address", target.Address);
            result.Add("state", state.ToString());
            result.Add("ok", state == OnlineState.Online);
            result.Add("elapsedMs", watch.ElapsedMilliseconds);

            if (state == OnlineState.Online)
            {
                _onlineSession = new OnlineSession
                {
                    Device = target.Device,
                    DeviceItem = target.DeviceItem,
                    Mode = target.Mode,
                    PcInterface = target.PcInterface.Name,
                    PcInterfaceNumber = target.PcInterface.Number,
                    TargetInterface = target.TargetInterface,
                    Address = target.Address,
                    Kind = target.Kind,
                    Owner = owner,
                    ConnectedAt = DateTime.UtcNow,
                    Provider = target.Provider,
                };
                log.Info("online_connect: reached " + target.Device + " via " + target.PcInterface.Name
                    + " (" + target.Kind + ") in " + watch.ElapsedMilliseconds + " ms");
                return result;
            }

            // A failed GoOnline leaves TIA Portal in a half-online state: every
            // later ApplyConfiguration then fails with "not permitted in online
            // mode". Release it here so the next attempt starts clean.
            try
            {
                target.Provider.GoOffline();
            }
            catch (Exception)
            {
                // Nothing to release.
            }

            result.Add("message", failure == null
                ? "The connection did not reach OnlineState.Online within " + timeoutMs + " ms."
                : failure.Message);
            return result;
        }

        // -------------------------------------------------------- OnlineStatus

        private JsonObject OnlineStatus(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            JsonObject data = new JsonObject();
            if (_onlineSession == null)
            {
                data.Add("connected", false);
                return data;
            }
            data.Add("connected", true);
            data.Add("session", DescribeOnlineSession());
            OnlineState state;
            try
            {
                state = _onlineSession.Provider.State;
            }
            catch (Exception)
            {
                state = OnlineState.Offline;
            }
            data.Add("state", state.ToString());
            data.Add("ok", state == OnlineState.Online);
            return data;
        }

        // ---------------------------------------------------- OnlineDisconnect

        private JsonObject OnlineDisconnect(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            JsonObject data = new JsonObject();
            bool force = p.Bool("force", false);
            string requestedDevice = p.String("device_name", null);
            if (_onlineSession == null)
            {
                if (!force)
                {
                    data.Add("connected", false);
                    data.Add("note", "There is no online session to disconnect.");
                    return data;
                }

                // The UI (or a previous controller) may hold the online state on
                // the adopted project; the download path cannot reconfigure while
                // TIA reports "online mode".
                string deviceName = string.IsNullOrEmpty(requestedDevice)
                    ? throw new ControllerException(
                        "invalid_params",
                        "'device_name' is required when force=true and the controller holds no session.")
                    : requestedDevice;
                Device targetDevice = _host.FindDevice(deviceName);
                DeviceItem cpu = OpennessHost.FindCpuItem(targetDevice);
                OnlineProvider provider = cpu == null ? null : OpennessHost.FindOnlineProvider(cpu);
                if (provider == null)
                {
                    throw new ControllerException(
                        "online_unavailable",
                        "The CPU of " + Text.Quote(deviceName) + " returned no OnlineProvider.",
                        JsonObject.Of("device", deviceName));
                }
                OnlineState forcedState;
                try
                {
                    provider.GoOffline();
                    forcedState = provider.State;
                }
                catch (Exception ex)
                {
                    throw OpennessHost.OpennessFailure("online_disconnect_failed",
                        "TIA refused to go offline for " + Text.Quote(deviceName) + ": " + ex.Message, ex);
                }
                data.Add("connected", false);
                data.Add("device", targetDevice.Name);
                data.Add("state", forcedState.ToString());
                data.Add("forced", true);
                return data;
            }
            string device = _onlineSession.Device;
            OnlineState state = Disconnect();
            data.Add("connected", false);
            data.Add("device", device);
            data.Add("state", state.ToString());
            return data;
        }

        /// <summary>GoOffline and forget the session; never throws.</summary>
        private OnlineState Disconnect()
        {
            OnlineSession session = _onlineSession;
            _onlineSession = null;
            if (session == null || session.Provider == null) return OnlineState.Offline;
            try
            {
                session.Provider.GoOffline();
                return session.Provider.State;
            }
            catch (Exception)
            {
                return OnlineState.Offline;
            }
        }

        private JsonObject DescribeOnlineSession()
        {
            JsonObject session = new JsonObject();
            OnlineSession current = _onlineSession;
            if (current == null) return session;
            session.Add("device", current.Device);
            session.Add("deviceItem", current.DeviceItem);
            session.Add("mode", current.Mode);
            session.Add("pcInterface", current.PcInterface);
            session.Add("pcInterfaceNumber", current.PcInterfaceNumber);
            session.AddIfPresent("targetInterface", current.TargetInterface);
            session.AddIfPresent("address", current.Address);
            session.Add("kind", current.Kind);
            session.AddIfPresent("owner", current.Owner);
            session.Add("connectedAtUtc", current.ConnectedAt.ToString("o"));
            return session;
        }

        /// <summary>Called from Dispose: an online session must not outlive us.</summary>
        private void DisposeOnline()
        {
            Disconnect();
        }


        // ---------------------------------------------------- AdoptOpenProject

        /// <summary>
        /// Adopt the project the TIA Portal UI already has open. Needed for the
        /// first connection to a PLC: the self-signed-certificate prompt is a UI
        /// decision that Openness cannot answer, so the trusted session must come
        /// from the UI and be taken over here.
        /// </summary>
        private JsonObject AdoptOpenProject(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            JsonObject data = _host.AdoptOpenProject(progress);
            changes.Add("adopt", JsonObject.ReadString(data, "projectName", null), "adopted",
                "the project stays owned by the TIA Portal UI");
            log.Info("Adopted the project open in the TIA Portal UI.");
            return data;
        }
        // ---------------------------------------------------------------- Download

        /// <summary>
        /// Answering the two download callbacks. Every configuration TIA Portal
        /// asks about is recorded; the policy picks the safe answer (never lower
        /// protection, never reset modules, never overwrite system data) and only
        /// throws for a configuration type it has never seen, because an unhandled
        /// configuration aborts the download.
        /// </summary>
        private sealed class DownloadPolicy
        {
            public string Password;
            public string BlockBindingPassword;
            public int MaxEntries = 100;
            public List<JsonObject> Configurations = new List<JsonObject>();

            public void Record(string phase, DownloadConfiguration configuration)
            {
                if (Configurations.Count >= MaxEntries) return;
                Configurations.Add(JsonObject.Of(
                    "phase", phase,
                    "type", configuration.GetType().Name,
                    "message", configuration.Message));
            }

            public void PreDownload(DownloadConfiguration configuration)
            {
                Record("pre", configuration);

                DownloadPasswordConfiguration password = configuration as DownloadPasswordConfiguration;
                if (password != null)
                {
                    string value = configuration is BlockBindingPassword
                        ? (string.IsNullOrEmpty(BlockBindingPassword) ? Password : BlockBindingPassword)
                        : Password;
                    if (string.IsNullOrEmpty(value))
                    {
                        throw new NotSupportedException(
                            "The download asks for a password (" + configuration.GetType().Name + ") but none was provided.");
                    }
                    password.SetPassword(ToSecureString(value));
                    return;
                }

                StopModules stop = configuration as StopModules;
                if (stop != null) { stop.CurrentSelection = StopModulesSelections.StopAll; return; }
                StartModules start = configuration as StartModules;
                if (start != null) { start.CurrentSelection = StartModulesSelections.StartModule; return; }
                ConsistentBlocksDownload consistent = configuration as ConsistentBlocksDownload;
                if (consistent != null)
                {
                    consistent.CurrentSelection = ConsistentBlocksDownloadSelections.ConsistentDownload;
                    return;
                }
                AlarmTextLibrariesDownload alarmTexts = configuration as AlarmTextLibrariesDownload;
                if (alarmTexts != null)
                {
                    alarmTexts.CurrentSelection = AlarmTextLibrariesDownloadSelections.ConsistentDownload;
                    return;
                }
                AllBlocksDownload allBlocks = configuration as AllBlocksDownload;
                if (allBlocks != null)
                {
                    allBlocks.CurrentSelection = AllBlocksDownloadSelections.DownloadAllBlocks;
                    return;
                }

                DownloadCheckConfiguration check = configuration as DownloadCheckConfiguration;
                if (check != null)
                {
                    // Only the pre-download check is a user decision we want; every
                    // other checkbox (upgrade target, overwrite HMI data, ...) stays
                    // off so nothing destructive happens silently.
                    check.Checked = configuration is CheckBeforeDownload;
                    return;
                }

                // Selections with no safe policy: keep the default (NoAction) and
                // let the result say whether that blocked the download.
                if (configuration is DownloadSelectionConfiguration) return;

                throw new NotSupportedException(
                    "Unhandled download configuration " + configuration.GetType().Name
                    + ": " + configuration.Message);
            }

            public void PostDownload(DownloadConfiguration configuration)
            {
                Record("post", configuration);
                StartModules start = configuration as StartModules;
                if (start != null) start.CurrentSelection = StartModulesSelections.StartModule;
                WaitOnReboot wait = configuration as WaitOnReboot;
                if (wait != null) wait.CurrentSelection = WaitOnRebootSelections.NoAction;
            }

            private static SecureString ToSecureString(string value)
            {
                SecureString secure = new SecureString();
                foreach (char c in value) secure.AppendChar(c);
                secure.MakeReadOnly();
                return secure;
            }
        }

        private JsonObject Download(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            string deviceName = p.RequiredString("device_name");
            bool dryRun = p.Bool("dry_run", true);
            bool confirm = p.Bool("confirm", false);
            bool confirmRealDevice = p.Bool("confirm_real_device", false);
            string optionName = p.Enum("options", new[] { "software", "hardware", "both" }, "software");
            int maxMessages = p.Int("max_messages", DefaultMaxMessages);
            if (maxMessages <= 0) maxMessages = DefaultMaxMessages;
            string targetAddress = p.String("target_address", null);

            string explicitPcInterface = p.String("pc_interface", null);
            string explicitAddress = p.String("address", null);
            bool hasExplicitTarget = !string.IsNullOrEmpty(explicitPcInterface) || !string.IsNullOrEmpty(explicitAddress);

            Device device = _host.FindDevice(deviceName);
            DeviceItem cpu = OpennessHost.FindCpuItem(device);
            DownloadProvider provider = cpu == null ? null : OpennessHost.FindDownloadProvider(cpu);
            if (provider == null)
            {
                throw new ControllerException(
                    "download_unavailable",
                    "The CPU of " + Text.Quote(deviceName) + " returned no DownloadProvider; F-activated PLCs and "
                        + "non-CPU device items cannot be downloaded this way.",
                    JsonObject.Of("device", deviceName));
            }

            ConnectionConfiguration configuration = provider.Configuration;
            OnlineSession session = _onlineSession;
            ResolvedOnlineTarget target;
            string targetSource;

            if (session != null
                && string.Equals(session.Device, deviceName, StringComparison.OrdinalIgnoreCase)
                && !hasExplicitTarget)
            {
                target = ResolveSessionTarget(configuration, session);
                targetSource = "session";
            }
            else
            {
                if (session != null
                    && !string.Equals(session.Device, deviceName, StringComparison.OrdinalIgnoreCase)
                    && !hasExplicitTarget)
                {
                    throw new ControllerException(
                        "online_session_device_mismatch",
                        "The controller's online session belongs to " + Text.Quote(session.Device)
                            + ", not to " + Text.Quote(deviceName) + ".",
                        JsonObject.Of("requested", deviceName, "session", DescribeOnlineSession()));
                }
                if (!hasExplicitTarget)
                {
                    throw new ControllerException(
                        "download_target_required",
                        "A download without an online session needs an explicit target: pass pc_interface and "
                            + "target_interface (or address). A fresh PLCSIM instance cannot go online before its "
                            + "first download, so the download target is resolved from the DownloadProvider instead.",
                        JsonObject.Of("device", deviceName, "hint", "Use online_targets to list the PC interfaces; "
                            + "for a running Softbus instance the name is PLCSIM."));
                }
                target = ResolveTargetOnConfiguration(p, device, cpu, configuration, true);
                targetSource = "download_property";
            }

            bool realDevice = !string.Equals(target.Kind, "virtual", StringComparison.OrdinalIgnoreCase);
            JsonObject gates = new JsonObject();
            gates.Add("confirmed", confirm);
            gates.Add("realDevice", realDevice);
            gates.Add("realDeviceConfirmed", confirmRealDevice);

            JsonObject data = new JsonObject();
            data.Add("device", device.Name);
            data.Add("deviceItem", cpu.Name);
            data.Add("mode", target.Mode);
            data.Add("pcInterface", target.PcInterface.Name);
            data.Add("pcInterfaceNumber", target.PcInterface.Number);
            data.Add("kind", target.Kind);
            data.Add("targetSource", targetSource);
            data.AddIfPresent("targetInterface", target.TargetInterface);
            data.AddIfPresent("address", target.Address);
            data.Add("options", optionName);
            data.Add("dryRun", dryRun);
            data.Add("gates", gates);

            // The V17 DownloadProvider has a second overload that takes the
            // specific target IP. A PLCSIM instance is addressed by its own IP
            // (Softbus reports 192.168.0.1 even when no Windows adapter is used),
            // so the caller may pass it explicitly instead of relying on the
            // offline project address.
            ConfigurationAddress targetAddressConfig = null;
            if (!string.IsNullOrEmpty(targetAddress))
            {
                targetAddressConfig = target.PcInterface.Addresses.Find(targetAddress);
                if (targetAddressConfig == null)
                {
                    targetAddressConfig = target.PcInterface.Addresses.Create(targetAddress);
                }
                data.Add("targetAddress", targetAddress);
            }

            if (dryRun)
            {
                data.Add("state", "Planned");
                data.Add("ok", true);
                data.Add("hint",
                    "Nothing was sent to the device. Pass confirm=true (and confirm_real_device=true for a physical "
                    + "target) to actually download.");
                return data;
            }

            if (!confirm)
            {
                throw new ControllerException(
                    "confirmation_required",
                    "A real download to " + Text.Quote(deviceName) + " needs confirm=true; dry_run=true only resolves the target.",
                    JsonObject.Of("device", deviceName, "kind", target.Kind));
            }
            if (realDevice && !confirmRealDevice)
            {
                throw new ControllerException(
                    "real_device_confirmation_required",
                    Text.Quote(deviceName) + " is reached through a physical interface (" + target.PcInterface.Name
                        + "), so a download additionally needs confirm_real_device=true.",
                    JsonObject.Of("device", deviceName, "pcInterface", target.PcInterface.Name));
            }

            DownloadOptions options;
            if (string.Equals(optionName, "hardware", StringComparison.Ordinal)) options = DownloadOptions.Hardware;
            else if (string.Equals(optionName, "both", StringComparison.Ordinal)) options = DownloadOptions.Hardware | DownloadOptions.Software;
            else options = DownloadOptions.Software;

            DownloadPolicy policy = new DownloadPolicy
            {
                Password = p.String("password", null),
                BlockBindingPassword = p.String("block_binding_password", null),
            };

            // A session target was already applied by OnlineConnect. A download
            // target resolved from DownloadProvider.Configuration has not been
            // applied yet, and TIA silently falls back to its default interface if
            // it is not — which is exactly the fresh-PLCSIM case.
            if (string.Equals(targetSource, "download_property", StringComparison.Ordinal))
            {
                bool applied;
                try
                {
                    applied = target.Slot != null
                        ? target.Configuration.ApplyConfiguration(target.Slot)
                        : target.Configuration.ApplyConfiguration(target.AddressConfig);
                }
                catch (Exception ex)
                {
                    // "The operation is not permitted in online mode." A previous
                    // GoOnline that failed can leave TIA Portal in that state.
                    throw new ControllerException(
                        "online_mode_conflict",
                        "TIA Portal refused to apply the download target: " + ex.Message
                            + " Disconnect (online_disconnect) or reconnect before retrying.",
                        JsonObject.Of(
                            "device", deviceName,
                            "mode", target.Mode,
                            "pcInterface", target.PcInterface.Name,
                            "exceptionType", ex.GetType().FullName));
                }
                if (!applied)
                {
                    throw new ControllerException(
                        "download_target_mismatch",
                        "ApplyConfiguration returned false; the download target cannot be used for this device.",
                        JsonObject.Of(
                            "device", deviceName,
                            "mode", target.Mode,
                            "pcInterface", target.PcInterface.Name,
                            "targetInterface", target.TargetInterface,
                            "address", target.Address));
                }
            }

            progress.Report("download", "Downloading " + optionName + " to " + device.Name + " (" + target.Kind + ").");
            DateTime started = DateTime.UtcNow;
            DownloadResult result;
            try
            {
                result = targetAddressConfig != null
                    ? provider.Download(target.Slot, targetAddressConfig, policy.PreDownload, policy.PostDownload, options)
                    : provider.Download(target.Target, policy.PreDownload, policy.PostDownload, options);
            }
            catch (Exception ex)
            {
                throw new ControllerException(
                    "download_failed",
                    "Downloading to " + Text.Quote(deviceName) + " failed: " + ex.Message,
                    JsonObject.Of(
                        "configurations", policy.Configurations,
                        "exceptionType", ex.GetType().FullName,
                        "device", deviceName,
                        "kind", target.Kind));
            }
            long durationMs = (long)(DateTime.UtcNow - started).TotalMilliseconds;

            List<JsonObject> messages = new List<JsonObject>();
            int totalMessages = 0;
            foreach (DownloadResultMessage message in result.Messages)
            {
                FlattenDownloadMessage(message, 0, messages, ref totalMessages, maxMessages);
            }

            string state = Convert.ToString(result.State);
            bool ok = result.State != DownloadResultState.Error;

            data.Add("state", state);
            data.Add("ok", ok);
            data.Add("errorCount", result.ErrorCount);
            data.Add("warningCount", result.WarningCount);
            data.Add("messageCount", totalMessages);
            data.Add("messagesTruncated", totalMessages > messages.Count);
            data.Add("messages", messages);
            data.Add("configurations", policy.Configurations);
            data.Add("durationMs", durationMs);

            // A download usually drops the online connection; keep the session object
            // only while it still reports a live state. A direct download has no
            // session at all, which is a normal state rather than an ended one.
            if (session != null)
            {
                string sessionState = "Offline";
                try
                {
                    sessionState = Convert.ToString(session.Provider.State);
                }
                catch (Exception)
                {
                    sessionState = "Offline";
                }
                data.Add("sessionState", sessionState);
                if (string.Equals(sessionState, "Offline", StringComparison.Ordinal))
                {
                    _onlineSession = null;
                    data.Add("sessionEnded", true);
                }
            }
            else
            {
                data.Add("sessionState", "not_connected");
            }

            changes.Add("download", device.Name, ok ? "completed" : "failed",
                state + " · " + result.ErrorCount + " error(s), " + result.WarningCount + " warning(s)");
            if (ok) log.Info("Download finished in " + Text.Elapsed(durationMs) + " (" + state + ").");
            else log.Error("Download failed in " + Text.Elapsed(durationMs) + " (" + state + ").");
            return data;
        }

        private static void FlattenDownloadMessage(DownloadResultMessage message, int depth, List<JsonObject> messages,
            ref int total, int maxMessages)
        {
            total++;
            if (messages.Count < maxMessages)
            {
                messages.Add(JsonObject.Of(
                    "depth", depth,
                    "dateTime", message.DateTime.ToString("o"),
                    "state", Convert.ToString(message.State),
                    "message", message.Message));
            }
            foreach (DownloadResultMessage child in message.Messages)
            {
                FlattenDownloadMessage(child, depth + 1, messages, ref total, maxMessages);
            }
        }

        /// <summary>
        /// Re-resolves the session's target on the download provider's own
        /// configuration. It must be the same interface the session used: a fresh
        /// DownloadProvider instance silently falls back to the default interface.
        /// </summary>
        private ResolvedOnlineTarget ResolveSessionTarget(ConnectionConfiguration configuration, OnlineSession session)
        {
            ResolvedOnlineTarget target = new ResolvedOnlineTarget
            {
                Device = session.Device,
                DeviceItem = session.DeviceItem,
                Mode = session.Mode,
                Kind = session.Kind,
            };

            ConfigurationMode mode = configuration.Modes.Find(session.Mode);
            if (mode == null)
            {
                throw new ControllerException(
                    "download_target_mismatch",
                    "The download provider does not offer the connection mode " + Text.Quote(session.Mode) + ".",
                    JsonObject.Of("mode", session.Mode, "session", session.Device));
            }
            ConfigurationPcInterface pcInterface = mode.PcInterfaces.Find(session.PcInterface, session.PcInterfaceNumber);
            if (pcInterface == null)
            {
                throw new ControllerException(
                    "download_target_mismatch",
                    "The download provider does not offer PC interface " + Text.Quote(session.PcInterface)
                        + " #" + session.PcInterfaceNumber + ".",
                    JsonObject.Of("pcInterface", session.PcInterface, "session", session.Device));
            }
            target.PcInterface = pcInterface;

            if (!string.IsNullOrEmpty(session.TargetInterface))
            {
                ConfigurationTargetInterface slot = pcInterface.TargetInterfaces.Find(session.TargetInterface);
                if (slot == null)
                {
                    throw new ControllerException(
                        "download_target_mismatch",
                        "The download provider does not offer target interface " + Text.Quote(session.TargetInterface) + ".",
                        JsonObject.Of("targetInterface", session.TargetInterface, "session", session.Device));
                }
                target.TargetInterface = slot.Name;
                target.Slot = slot;
                target.Target = slot;
                return target;
            }

            if (!string.IsNullOrEmpty(session.Address))
            {
                ConfigurationAddress address = FindSubnetAddress(pcInterface, session.Address);
                if (address == null)
                {
                    throw new ControllerException(
                        "download_target_mismatch",
                        "The download provider does not carry address " + Text.Quote(session.Address) + ".",
                        JsonObject.Of("address", session.Address, "session", session.Device));
                }
                target.Address = address.Address;
                target.AddressConfig = address;
                target.Target = address;
                return target;
            }

            throw new ControllerException(
                "download_target_mismatch",
                "The online session does not record a usable target interface or address.",
                DescribeOnlineSession());
        }
        // ------------------------------------------------------------ resolution

        /// <summary>
        /// Resolves what to connect to. Three ways, in the order the matrix
        /// documents them: an explicit PC interface plus target slot, a PC-side
        /// address, or a PC address alone (the interface is then discovered).
        /// </summary>
        private ResolvedOnlineTarget ResolveOnlineTarget(JsonArgs p)
        {
            string deviceName = p.RequiredString("device_name");
            Device device = _host.FindDevice(deviceName);
            DeviceItem cpu = OpennessHost.FindCpuItem(device);
            if (cpu == null)
            {
                throw new ControllerException(
                    "online_unavailable",
                    "Device " + Text.Quote(deviceName) + " has no CPU device item, so it has no online service.",
                    JsonObject.Of("device", deviceName));
            }
            OnlineProvider provider = OpennessHost.FindOnlineProvider(cpu);
            if (provider == null)
            {
                throw new ControllerException(
                    "online_unavailable",
                    "The CPU of " + Text.Quote(deviceName) + " returned no OnlineProvider; only PLC CPUs are download/online-capable.",
                    JsonObject.Of("device", deviceName, "deviceItem", cpu.Name));
            }

            ResolvedOnlineTarget target = ResolveTargetOnConfiguration(p, device, cpu, provider.Configuration, false);
            target.Provider = provider;
            return target;
        }

        /// <summary>
        /// Resolves a Mode → PcInterface → TargetInterface/Address target on any
        /// connection configuration. Online and download each own a provider whose
        /// Configuration exposes the same chain; this keeps both callers on one
        /// implementation and one error vocabulary.
        ///
        /// <paramref name="forDownload"/> switches the failure codes from
        /// <c>online_*</c> to <c>download_target_mismatch</c> / <c>download_target_required</c>.
        /// </summary>
        private ResolvedOnlineTarget ResolveTargetOnConfiguration(
            JsonArgs p, Device device, DeviceItem cpu, ConnectionConfiguration configuration, bool forDownload)
        {
            string modeName = p.String("mode", OpennessHost.ConnectionModeName);
            ConfigurationMode mode = configuration.Modes.Find(modeName);
            if (mode == null)
            {
                ThrowTargetError(
                    forDownload,
                    "online_mode_not_found",
                    "Connection mode " + Text.Quote(modeName) + " is not offered by this device.",
                    JsonObject.Of("mode", modeName, "available", ModeNames(configuration)));
            }

            string pcInterfaceName = p.String("pc_interface", null);
            int pcInterfaceNumber = p.Int("pc_interface_number", 1);
            string targetInterfaceName = p.String("target_interface", null);
            string address = p.String("address", null);

            ResolvedOnlineTarget target = new ResolvedOnlineTarget
            {
                Device = device.Name,
                DeviceItem = cpu.Name,
                Configuration = configuration,
                Mode = mode.Name,
            };

            string expectKind = p.Enum("expect_kind", new[] { "virtual", "physical" }, null);

            if (!string.IsNullOrEmpty(pcInterfaceName))
            {
                ConfigurationPcInterface pcInterface = mode.PcInterfaces.Find(pcInterfaceName, pcInterfaceNumber);
                if (pcInterface == null)
                {
                    ThrowTargetError(
                        forDownload,
                        "online_interface_not_found",
                        "No PC interface " + Text.Quote(pcInterfaceName) + " #" + pcInterfaceNumber
                            + " in mode " + Text.Quote(mode.Name) + ".",
                        JsonObject.Of("pcInterface", pcInterfaceName, "number", pcInterfaceNumber,
                            "available", PcInterfaceNames(mode)));
                }
                target.PcInterface = pcInterface;
                target.Kind = ClassifyInterface(pcInterface.Name);
                RequireExpectedKind(expectKind, target.Kind, pcInterface.Name);
                if (!string.IsNullOrEmpty(targetInterfaceName))
                {
                    ConfigurationTargetInterface slot = pcInterface.TargetInterfaces.Find(targetInterfaceName);
                    if (slot == null)
                    {
                        ThrowTargetError(
                            forDownload,
                            "online_target_interface_not_found",
                            "PC interface " + Text.Quote(pcInterface.Name) + " has no target interface "
                                + Text.Quote(targetInterfaceName) + ".",
                            JsonObject.Of("targetInterface", targetInterfaceName,
                                "available", TargetInterfaceNames(pcInterface)));
                    }
                    target.TargetInterface = slot.Name;
                    target.Slot = slot;
                    target.Target = slot;
                }
                else if (!string.IsNullOrEmpty(address))
                {
                    target.Address = address;
                    ConfigurationAddress subnetAddress = FindSubnetAddress(pcInterface, address);
                    target.AddressConfig = subnetAddress;
                    target.Target = subnetAddress;
                    if (subnetAddress == null)
                    {
                        ThrowTargetError(
                            forDownload,
                            "online_address_not_found",
                            "PC interface " + Text.Quote(pcInterface.Name) + " has no address " + Text.Quote(address) + ".",
                            JsonObject.Of("address", address, "available", SubnetAddresses(pcInterface)));
                    }
                }
                else
                {
                    if (pcInterface.TargetInterfaces.Count == 0)
                    {
                        ThrowTargetRequired(
                            forDownload,
                            "PC interface " + Text.Quote(pcInterface.Name) + " offers no target interface; pass address= instead.",
                            JsonObject.Of("pcInterface", pcInterface.Name));
                    }
                    ConfigurationTargetInterface slot = pcInterface.TargetInterfaces[0];
                    target.TargetInterface = slot.Name;
                    target.Slot = slot;
                    target.Target = slot;
                }
                return target;
            }

            if (!string.IsNullOrEmpty(address))
            {
                foreach (ConfigurationMode candidateMode in configuration.Modes)
                {
                    foreach (ConfigurationPcInterface candidateInterface in candidateMode.PcInterfaces)
                    {
                        ConfigurationAddress found = FindSubnetAddress(candidateInterface, address);
                        if (found == null) continue;
                        target.Mode = candidateMode.Name;
                        target.PcInterface = candidateInterface;
                        target.Address = address;
                        target.AddressConfig = found;
                        target.Target = found;
                        target.Kind = ClassifyInterface(candidateInterface.Name);
                        RequireExpectedKind(expectKind, target.Kind, candidateInterface.Name);
                        return target;
                    }
                }
                ThrowTargetError(
                    forDownload,
                    "online_address_not_found",
                    "No PC interface of this device carries the address " + Text.Quote(address) + ".",
                    JsonObject.Of("address", address, "available", AllSubnetAddresses(configuration)));
            }

            if (forDownload)
            {
                throw new ControllerException(
                    "download_target_required",
                    "Pass pc_interface (+ target_interface or address), or address alone. Use online_targets to list what exists.",
                    JsonObject.Of("device", device.Name, "mode", mode.Name, "available", PcInterfaceNames(mode)));
            }
            throw new ControllerException(
                "online_target_required",
                "Pass pc_interface (+ target_interface or address), or address alone. Use online_targets to list what exists.",
                JsonObject.Of("device", device.Name, "mode", mode.Name, "available", PcInterfaceNames(mode)));
        }

        /// <summary>
        /// One target-resolution failure vocabulary for both callers: the online
        /// surface keeps its historical <c>online_*</c> codes, while a download
        /// that resolves its own target reports <c>download_target_mismatch</c>.
        /// </summary>
        private static void ThrowTargetError(bool forDownload, string onlineCode, string message, JsonObject details)
        {
            if (forDownload) throw new ControllerException("download_target_mismatch", message, details);
            throw new ControllerException(onlineCode, message, details);
        }

        private static void ThrowTargetRequired(bool forDownload, string message, JsonObject details)
        {
            if (forDownload) throw new ControllerException("download_target_required", message, details);
            throw new ControllerException("online_target_required", message, details);
        }

        /// <summary>The subnet address object on a PC interface, or null.</summary>
        private static ConfigurationAddress FindSubnetAddress(ConfigurationPcInterface pcInterface, string address)
        {
            foreach (ConfigurationSubnet subnet in pcInterface.Subnets)
            {
                foreach (ConfigurationAddress candidate in subnet.Addresses)
                {
                    if (string.Equals(candidate.Address, address, StringComparison.OrdinalIgnoreCase)) return candidate;
                }
            }
            return null;
        }

        /// <summary>
        /// The virtual/physical split is a name heuristic, so callers that must not
        /// touch a real plant can pin the expectation instead of trusting it.
        /// </summary>
        private static void RequireExpectedKind(string expectKind, string actualKind, string interfaceName)
        {
            if (string.IsNullOrEmpty(expectKind)) return;
            if (string.Equals(expectKind, actualKind, StringComparison.OrdinalIgnoreCase)) return;
            throw new ControllerException(
                "online_kind_mismatch",
                "The caller expected a " + expectKind + " target, but PC interface " + Text.Quote(interfaceName)
                    + " is classified as " + actualKind + ".",
                JsonObject.Of("expectKind", expectKind, "actualKind", actualKind, "pcInterface", interfaceName));
        }

        private static string ClassifyInterface(string name)
        {
            if (string.IsNullOrEmpty(name)) return "unknown";
            string lower = name.ToLowerInvariant();
            if (lower.Contains("plcsim") || lower.Contains("virtual")) return "virtual";
            return "physical";
        }

        private static List<string> DeviceNames(List<Device> devices)
        {
            List<string> names = new List<string>();
            foreach (Device device in devices) names.Add(device.Name);
            return names;
        }

        private static List<string> ModeNames(ConnectionConfiguration configuration)
        {
            List<string> names = new List<string>();
            foreach (ConfigurationMode mode in configuration.Modes) names.Add(mode.Name);
            return names;
        }

        private static List<string> PcInterfaceNames(ConfigurationMode mode)
        {
            List<string> names = new List<string>();
            foreach (ConfigurationPcInterface pcInterface in mode.PcInterfaces) names.Add(pcInterface.Name);
            return names;
        }

        private static List<string> TargetInterfaceNames(ConfigurationPcInterface pcInterface)
        {
            List<string> names = new List<string>();
            foreach (ConfigurationTargetInterface target in pcInterface.TargetInterfaces) names.Add(target.Name);
            return names;
        }

        private static List<string> SubnetAddresses(ConfigurationPcInterface pcInterface)
        {
            List<string> values = new List<string>();
            foreach (ConfigurationSubnet subnet in pcInterface.Subnets)
            {
                foreach (ConfigurationAddress address in subnet.Addresses) values.Add(address.Address);
            }
            return values;
        }

        private static List<JsonObject> AllSubnetAddresses(ConnectionConfiguration configuration)
        {
            List<JsonObject> values = new List<JsonObject>();
            foreach (ConfigurationMode mode in configuration.Modes)
            {
                foreach (ConfigurationPcInterface pcInterface in mode.PcInterfaces)
                {
                    foreach (string address in SubnetAddresses(pcInterface))
                    {
                        values.Add(JsonObject.Of("pcInterface", pcInterface.Name, "address", address));
                    }
                }
            }
            return values;
        }
    }
}
