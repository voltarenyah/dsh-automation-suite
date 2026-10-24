using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;
using System.Web.Script.Serialization;
using Siemens.Simatic.Simulation.Runtime;

namespace PlcsimAdvanced.Controller
{
    internal sealed class ControllerException : Exception
    {
        public ControllerException(string code, string message) : base(message)
        {
            Code = code;
        }

        public string Code { get; private set; }
    }

    internal sealed class PlcsimRuntime
    {
        private readonly Dictionary<string, IInstance> _instances =
            new Dictionary<string, IInstance>(StringComparer.OrdinalIgnoreCase);

        private readonly string _storageRoot;

        public PlcsimRuntime(string storageRoot)
        {
            _storageRoot = storageRoot;
        }

        public static object Probe()
        {
            var result = new Dictionary<string, object>();
            try
            {
                result["available"] = SimulationRuntimeManager.IsRuntimeManagerAvailable;
                result["runtimeVersion"] = SimulationRuntimeManager.Version;
                result["apiVersion"] = typeof(SimulationRuntimeManager).Assembly.GetName().Version.ToString();
            }
            catch (Exception ex)
            {
                result["available"] = false;
                result["error"] = ex.GetType().Name + ": " + ex.Message;
            }
            return result;
        }

        public object Status()
        {
            var data = new Dictionary<string, object>();
            data["available"] = SimulationRuntimeManager.IsRuntimeManagerAvailable;
            try
            {
                data["runtimeVersion"] = SimulationRuntimeManager.Version;
                data["apiVersion"] = typeof(SimulationRuntimeManager).Assembly.GetName().Version.ToString();
            }
            catch (Exception ex)
            {
                data["available"] = false;
                data["error"] = ex.Message;
            }

            var list = new List<object>();
            foreach (var pair in _instances)
            {
                list.Add(Describe(pair.Value));
            }
            data["instances"] = list;
            data["networkMode"] = "Softbus";
            return data;
        }

        public object Instance(IDictionary<string, object> p)
        {
            string action = Text(p, "action") ?? "list";
            if (action == "list") return Status();

            string name = RequireName(p);
            if (action == "create")
            {
                if (_instances.ContainsKey(name))
                {
                    throw new ControllerException("instance_exists", "A PLCSIM instance named '" + name + "' already exists.");
                }
                IInstance instance = SimulationRuntimeManager.RegisterInstance(name);
                instance.StoragePath = Path.Combine(_storageRoot, SafeName(name));
                _instances[name] = instance;
                return Describe(instance);
            }

            IInstance existing = RequireInstance(name);
            if (action == "power_on")
            {
                existing.PowerOn(20000);
                return Describe(existing);
            }
            if (action == "power_off")
            {
                existing.PowerOff(20000);
                return Describe(existing);
            }
            if (action == "remove")
            {
                try { existing.PowerOff(20000); } catch (Exception) { }
                try { existing.UnregisterInstance(); } catch (Exception) { }
                _instances.Remove(name);
                return new Dictionary<string, object> { { "name", name }, { "removed", true } };
            }
            throw new ControllerException("invalid_action", "Unknown instance action '" + action + "'.");
        }

        public object Run(IDictionary<string, object> p)
        {
            string action = Text(p, "action") ?? "state";
            IInstance instance = RequireInstance(RequireName(p));
            if (action == "state") return Describe(instance);
            if (action == "run") instance.Run(10000);
            else if (action == "stop") instance.Stop(10000);
            else if (action == "reset") instance.MemoryReset(60000);
            else throw new ControllerException("invalid_action", "Unknown run action '" + action + "'.");
            return Describe(instance);
        }

        public object Tags(IDictionary<string, object> p)
        {
            string action = Text(p, "action") ?? "list";
            IInstance instance = RequireInstance(RequireName(p));
            RefreshTags(instance);

            STagInfo[] tags = instance.TagInfos;
            if (action == "list")
            {
                int max = Int(p, "max", 200);
                var rows = new List<object>();
                int count = 0;
                foreach (STagInfo tag in tags)
                {
                    count++;
                    if (rows.Count >= max) continue;
                    rows.Add(new Dictionary<string, object>
                    {
                        { "name", tag.Name },
                        { "type", tag.DataType.ToString() },
                        { "area", tag.Area.ToString() }
                    });
                }
                return new Dictionary<string, object>
                {
                    { "count", count },
                    { "returned", rows.Count },
                    { "truncated", count > rows.Count },
                    { "tags", rows }
                };
            }

            string tagName = Text(p, "tag");
            if (string.IsNullOrEmpty(tagName))
            {
                throw new ControllerException("invalid_params", "The tags operation needs 'tag' for read/write.");
            }
            int tagIndex = FindIndex(tags, tagName);
            if (tagIndex < 0)
            {
                throw new ControllerException("tag_not_found", "No tag named '" + tagName + "' in the instance tag list.");
            }
            STagInfo info = tags[tagIndex];

            if (action == "read")
            {
                object value = ReadValue(instance, info);
                return new Dictionary<string, object>
                {
                    { "tag", info.Name },
                    { "type", info.DataType.ToString() },
                    { "area", info.Area.ToString() },
                    { "value", value }
                };
            }
            if (action == "write")
            {
                object raw = p.ContainsKey("value") ? p["value"] : null;
                if (raw == null) throw new ControllerException("invalid_params", "The tags write action needs 'value'.");
                WriteValue(instance, info, raw);
                return new Dictionary<string, object>
                {
                    { "tag", info.Name },
                    { "type", info.DataType.ToString() },
                    { "value", raw },
                    { "written", true }
                };
            }
            throw new ControllerException("invalid_action", "Unknown tags action '" + action + "'.");
        }

        public void Dispose()
        {
            foreach (var pair in _instances)
            {
                try { pair.Value.PowerOff(20000); } catch (Exception) { }
                try { pair.Value.UnregisterInstance(); } catch (Exception) { }
            }
            _instances.Clear();
            try { SimulationRuntimeManager.Shutdown(); } catch (Exception) { }
        }

        private IInstance RequireInstance(string name)
        {
            IInstance instance;
            if (!_instances.TryGetValue(name, out instance))
            {
                throw new ControllerException("instance_not_found", "No PLCSIM instance named '" + name + "' in this controller.");
            }
            return instance;
        }

        private static void RefreshTags(IInstance instance)
        {
            try
            {
                instance.UpdateTagList();
            }
            catch (SimulationRuntimeException)
            {
                // A fresh download or a renamed block leaves the list stale once;
                // a full refresh is the documented recovery.
                instance.UpdateTagList(ETagListDetails.IOMCTDB, false);
            }
        }

        private static int FindIndex(STagInfo[] tags, string name)
        {
            for (int i = 0; i < tags.Length; i++)
            {
                if (string.Equals(tags[i].Name, name, StringComparison.Ordinal)) return i;
            }
            return -1;
        }

        private static object ReadValue(IInstance instance, STagInfo tag)
        {
            string type = tag.DataType.ToString();
            switch (type)
            {
                case "Bool": return instance.ReadBool(tag.Name);
                case "Byte":
                case "USInt": return instance.ReadUInt8(tag.Name);
                case "SInt": return instance.ReadInt8(tag.Name);
                case "Word":
                case "UInt": return instance.ReadUInt16(tag.Name);
                case "Int": return instance.ReadInt16(tag.Name);
                case "DWord":
                case "UDInt": return instance.ReadUInt32(tag.Name);
                case "DInt": return instance.ReadInt32(tag.Name);
                case "LInt": return instance.ReadInt64(tag.Name);
                case "ULInt": return instance.ReadUInt64(tag.Name);
                case "Real": return instance.ReadFloat(tag.Name);
                case "LReal": return instance.ReadDouble(tag.Name);
                default:
                    throw new ControllerException("unsupported_type", "Tag '" + tag.Name + "' has type " + type
                        + ", which this MVP does not read yet.");
            }
        }

        private static void WriteValue(IInstance instance, STagInfo tag, object raw)
        {
            string type = tag.DataType.ToString();
            CultureInfo culture = CultureInfo.InvariantCulture;
            try
            {
                switch (type)
                {
                    case "Bool": instance.WriteBool(tag.Name, Convert.ToBoolean(raw, culture)); break;
                    case "Byte":
                    case "USInt": instance.WriteUInt8(tag.Name, Convert.ToByte(raw, culture)); break;
                    case "SInt": instance.WriteInt8(tag.Name, Convert.ToSByte(raw, culture)); break;
                    case "Word":
                    case "UInt": instance.WriteUInt16(tag.Name, Convert.ToUInt16(raw, culture)); break;
                    case "Int": instance.WriteInt16(tag.Name, Convert.ToInt16(raw, culture)); break;
                    case "DWord":
                    case "UDInt": instance.WriteUInt32(tag.Name, Convert.ToUInt32(raw, culture)); break;
                    case "DInt": instance.WriteInt32(tag.Name, Convert.ToInt32(raw, culture)); break;
                    case "LInt": instance.WriteInt64(tag.Name, Convert.ToInt64(raw, culture)); break;
                    case "ULInt": instance.WriteUInt64(tag.Name, Convert.ToUInt64(raw, culture)); break;
                    case "Real": instance.WriteFloat(tag.Name, Convert.ToSingle(raw, culture)); break;
                    case "LReal": instance.WriteDouble(tag.Name, Convert.ToDouble(raw, culture)); break;
                    default:
                        throw new ControllerException("unsupported_type", "Tag '" + tag.Name + "' has type " + type
                            + ", which this MVP does not write yet.");
                }
            }
            catch (ControllerException) { throw; }
            catch (Exception ex)
            {
                throw new ControllerException("write_failed", "Writing '" + tag.Name + "' failed: " + ex.Message);
            }
        }

        private static Dictionary<string, object> Describe(IInstance instance)
        {
            var row = new Dictionary<string, object>();
            row["name"] = instance.Name;
            row["id"] = instance.ID;
            row["state"] = instance.OperatingState.ToString();
            row["cpuType"] = instance.CPUType.ToString();
            row["comm"] = instance.CommunicationInterface.ToString();
            row["license"] = instance.LicenseStatus.ToString();
            try { row["storagePath"] = instance.StoragePath; } catch (Exception) { }
            return row;
        }

        private static string RequireName(IDictionary<string, object> p)
        {
            string name = Text(p, "name");
            if (string.IsNullOrEmpty(name))
            {
                throw new ControllerException("invalid_params", "This operation needs 'name'.");
            }
            return name;
        }

        private static string Text(IDictionary<string, object> p, string key)
        {
            object value;
            if (!p.TryGetValue(key, out value) || value == null) return null;
            return Convert.ToString(value, CultureInfo.InvariantCulture);
        }

        private static int Int(IDictionary<string, object> p, string key, int fallback)
        {
            object value;
            if (!p.TryGetValue(key, out value) || value == null) return fallback;
            try { return Convert.ToInt32(value, CultureInfo.InvariantCulture); }
            catch (Exception) { return fallback; }
        }

        private static string SafeName(string name)
        {
            var builder = new StringBuilder();
            foreach (char c in name)
            {
                builder.Append(char.IsLetterOrDigit(c) || c == '-' || c == '_' ? c : '_');
            }
            return builder.Length == 0 ? "instance" : builder.ToString();
        }
    }

    internal static class Program
    {
        private const int ProtocolVersion = 1;
        private const string ControllerVersion = "0.1.0";

        private static readonly string[] Operations = { "Status", "Instance", "Run", "Tags" };

        [STAThread]
        private static int Main(string[] args)
        {
            string apiDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonProgramFilesX86),
                "Siemens", "PLCSIMADV", "API", "4.0");
            string storageRoot = Path.Combine(Path.GetTempPath(), "dsh-plcsim");
            bool selfTest = false;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--api-dir" && i + 1 < args.Length) apiDir = args[++i];
                else if (args[i] == "--storage-root" && i + 1 < args.Length) storageRoot = args[++i];
                else if (args[i] == "--self-test") selfTest = true;
                else if (args[i] == "--version")
                {
                    Console.WriteLine(ControllerVersion);
                    return 0;
                }
            }

            InstallResolver(apiDir);
            var serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

            if (selfTest)
            {
                return SelfTest(serializer, apiDir);
            }

            var runtime = new PlcsimRuntime(storageRoot);
            var ready = new Dictionary<string, object>
            {
                { "type", "ready" },
                { "protocol", ProtocolVersion },
                { "controller", "PlcsimAdvanced.Controller" },
                { "version", ControllerVersion },
                { "apiDir", apiDir },
                { "api", PlcsimRuntime.Probe() }
            };
            Write(serializer, ready);

            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                var started = DateTime.UtcNow;
                string id = null;
                string operation = null;
                try
                {
                    var request = serializer.Deserialize<Dictionary<string, object>>(line);
                    id = request.ContainsKey("id") ? Convert.ToString(request["id"]) : null;
                    operation = request.ContainsKey("operation") ? Convert.ToString(request["operation"]) : null;
                    if (operation == null || Array.IndexOf(Operations, operation) < 0)
                    {
                        throw new ControllerException("unsupported_operation", "Unknown operation '" + operation + "'.");
                    }
                    var p = request.ContainsKey("params") && request["params"] != null
                        ? (IDictionary<string, object>)request["params"]
                        : new Dictionary<string, object>();

                    object data;
                    if (operation == "Status") data = runtime.Status();
                    else if (operation == "Instance") data = runtime.Instance(p);
                    else if (operation == "Run") data = runtime.Run(p);
                    else data = runtime.Tags(p);

                    Write(serializer, Result(id, operation, true, data, null, started));
                }
                catch (ControllerException ex)
                {
                    Write(serializer, Result(id, operation, false, null, new Dictionary<string, object>
                    {
                        { "code", ex.Code }, { "message", ex.Message }
                    }, started));
                }
                catch (Exception ex)
                {
                    Write(serializer, Result(id, operation, false, null, new Dictionary<string, object>
                    {
                        { "code", "plcsim_error" },
                        { "message", ex.GetType().Name + ": " + ex.Message }
                    }, started));
                }
            }

            runtime.Dispose();
            return 0;
        }

        private static int SelfTest(JavaScriptSerializer serializer, string apiDir)
        {
            var checks = new List<object>();
            Action<string, bool> check = (name, ok) => checks.Add(new Dictionary<string, object>
            {
                { "name", name }, { "ok", ok }
            });

            var roundtrip = serializer.Deserialize<Dictionary<string, object>>(
                serializer.Serialize(new Dictionary<string, object> { { "type", "operation" }, { "value", 42 } }));
            check("json_roundtrip", Convert.ToInt32(roundtrip["value"]) == 42);
            check("whitelist_exact", Operations.Length == 4 && Array.IndexOf(Operations, "Tags") == 3);
            check("unknown_operation_rejected", Array.IndexOf(Operations, "Download") < 0);
            var probe = PlcsimRuntime.Probe() as Dictionary<string, object>;
            check("api_probe_completed", probe != null && probe.ContainsKey("available"));

            var payload = new Dictionary<string, object>
            {
                { "type", "self_test" },
                { "controller", "PlcsimAdvanced.Controller" },
                { "controllerVersion", ControllerVersion },
                { "protocol", ProtocolVersion },
                { "apiDir", apiDir },
                { "checks", checks },
                { "ok", checks.TrueForAll(c => (bool)((Dictionary<string, object>)c)["ok"]) }
            };
            Write(serializer, payload);
            return 0;
        }

        private static Dictionary<string, object> Result(
            string id, string operation, bool ok, object data, object error, DateTime started)
        {
            var frame = new Dictionary<string, object>
            {
                { "type", "result" },
                { "protocol", ProtocolVersion },
                { "id", id },
                { "operation", operation },
                { "ok", ok },
                { "data", data },
                { "error", error },
                { "durationMs", (long)(DateTime.UtcNow - started).TotalMilliseconds }
            };
            return frame;
        }

        private static void Write(JavaScriptSerializer serializer, object frame)
        {
            Console.Out.WriteLine(serializer.Serialize(frame));
            Console.Out.Flush();
        }

        private static void InstallResolver(string apiDir)
        {
            AppDomain.CurrentDomain.AssemblyResolve += (sender, eventArgs) =>
            {
                var name = new AssemblyName(eventArgs.Name);
                if (string.Equals(name.Name, "Siemens.Simatic.Simulation.Runtime.Api.x64", StringComparison.OrdinalIgnoreCase))
                {
                    string path = Path.Combine(apiDir, name.Name + ".dll");
                    if (File.Exists(path)) return Assembly.LoadFrom(path);
                }
                return null;
            };
        }
    }
}
