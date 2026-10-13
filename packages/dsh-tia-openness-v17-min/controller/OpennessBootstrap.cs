using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using Microsoft.Win32;
using Siemens.Collaboration.Net;
using Siemens.Collaboration.Net.TiaPortal.Openness.Core;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>
    /// Bootstraps Siemens' own Openness assembly resolver.
    ///
    /// Siemens ships the resolution logic as the NuGet package
    /// <c>Siemens.Collaboration.Net.TiaPortal.Openness.Resolver</c>. It checks the
    /// TIA Portal registry entries, running TIA Portal processes and the
    /// <c>TiaPortalLocation</c> variable, collects every Siemens.Engineering
    /// assembly it finds and resolves the one matching the version this controller
    /// was built against. This class wires that resolver into the controller and
    /// keeps the plugin's own diagnostics intact:
    ///
    ///  * initialization is <b>lazy</b> — it happens right before the first
    ///    operation, never at process start, so the controller can still start,
    ///    print its ready banner and answer with a structured reason on a machine
    ///    without a usable Openness installation (and <c>--self-test</c> keeps
    ///    asserting that no Openness assembly is loaded);
    ///  * <see cref="AssemblyResolver.InstallFallback"/> is registered afterwards
    ///    as a last resort, so a resolution failure degrades to the controller's
    ///    own directory probing instead of a <c>FileNotFoundException</c>.
    /// </summary>
    internal static class OpennessBootstrap
    {
        /// <summary>
        /// TIA Portal major version this controller is bound to. Passed to the
        /// resolver so it cannot silently pick a different installed version.
        /// </summary>
        public const int TiaPortalMajorVersion = 17;

        /// <summary>Environment variable the official resolver reads.</summary>
        public const string TiaPortalLocationVariable = "TiaPortalLocation";

        private static readonly object Gate = new object();
        private static bool _initialized;
        private static bool _failureReported;
        private static IDisposable<OpennessMarkerExtensions.OpennessResolverInfo> _session;
        private static JsonObject _description;

        /// <summary>Diagnostics of the last (successful or failed) initialization.</summary>
        public static JsonObject Description
        {
            get
            {
                if (_description != null) return _description;
                JsonObject pending = new JsonObject();
                pending.Add("initialized", false);
                pending.Add("state", "not_initialized");
                return pending;
            }
        }

        /// <summary>
        /// Initializes the official resolver exactly once. Must run before any
        /// Siemens.Engineering type is touched.
        /// </summary>
        public static void EnsureInitialized(string opennessDirOverride, DiagnosticLog log)
        {
            lock (Gate)
            {
                if (_initialized) return;

                JsonObject description = new JsonObject();
                description.Add("resolver", "Siemens.Collaboration.Net.TiaPortal.Openness.Resolver");
                description.Add("resolverVersion", ResolverVersion());
                description.Add("tiaMajorVersion", TiaPortalMajorVersion);

                try
                {
                    // The fallback probe is registered first, so it exists even if
                    // Siemens' resolver fails to initialize. AssemblyResolve handlers
                    // run last-registered-first, so Siemens' resolver — registered
                    // below — still answers every lookup before this one.
                    AssemblyResolver.InstallFallback(
                        string.IsNullOrWhiteSpace(opennessDirOverride) ? AssemblyResolver.DefaultOpennessDir : opennessDirOverride,
                        log);

                    // The controller's own --openness-dir wins over auto discovery by
                    // being translated into the variable the official resolver reads.
                    if (!string.IsNullOrWhiteSpace(opennessDirOverride))
                    {
                        string root = AssemblyResolver.PortalRootOf(opennessDirOverride) ?? opennessDirOverride;
                        Environment.SetEnvironmentVariable(TiaPortalLocationVariable, root);
                        description.Add("tiaPortalLocationFrom", "controller --openness-dir");
                        description.Add(TiaPortalLocationVariable, root);
                        log.Info("Using " + TiaPortalLocationVariable + " = " + root + " (from --openness-dir).");
                    }
                    else
                    {
                        string existing = Environment.GetEnvironmentVariable(TiaPortalLocationVariable);
                        if (!string.IsNullOrWhiteSpace(existing))
                        {
                            description.Add("tiaPortalLocationFrom", "environment");
                            description.Add(TiaPortalLocationVariable, existing);
                        }
                        else
                        {
                            description.Add("tiaPortalLocationFrom", "auto-discovery");
                        }
                    }

                    IOpennessMarker marker = Api.Global.Openness();
                    // Named argument on purpose: the overload whose first Int32 is a
                    // TIA Portal *process id* would be selected otherwise.
                    _session = marker.Initialize(tiaMajorVersion: TiaPortalMajorVersion);

                    string resolved = _session != null && _session.Value != null && _session.Value.SiemensEngineeringFileInfo != null
                        ? _session.Value.SiemensEngineeringFileInfo.FullName
                        : null;
                    description.Add("initialized", true);
                    description.Add("state", "initialized");
                    description.AddIfPresent("resolvedAssembly", resolved);
                    if (resolved != null) log.Info("Siemens' resolver selected " + resolved + ".");

                    _description = description;
                    _initialized = true;
                }
                catch (Exception ex)
                {
                    // Deliberately non-fatal. The fallback probe is already
                    // registered, so a resolver that cannot initialize degrades to
                    // the controller's own probing instead of blocking every
                    // operation. The failure stays visible in the diagnostics, and
                    // the next operation retries (a TIA Portal installation started
                    // meanwhile heals the session).
                    description.Add("initialized", false);
                    description.Add("state", "failed");
                    description.AddIfPresent("error", ex.GetType().Name + ": " + ex.Message);
                    description.AddIfPresent("hint", HintFor(ex));
                    _description = description;
                    if (!_failureReported)
                    {
                        _failureReported = true;
                        log.Warning("Siemens' Openness assembly resolver could not be initialized ("
                            + ex.GetType().Name + ": " + ex.Message
                            + "); the controller falls back to its own assembly probe.");
                    }
                }
            }
        }

        /// <summary>Releases the resolver session; called while shutting down.</summary>
        public static void Shutdown(DiagnosticLog log)
        {
            lock (Gate)
            {
                if (_session == null) return;
                try
                {
                    _session.Dispose();
                }
                catch (Exception ex)
                {
                    log.Warning("Disposing the Siemens assembly resolver session failed: " + ex.Message);
                }
                _session = null;
                _initialized = false;
            }
        }

        /// <summary>
        /// The resolver's own version, reported in the ready banner so a support
        /// case can tell which resolution logic produced a decision.
        /// </summary>
        public static string ResolverVersion()
        {
            try
            {
                Assembly assembly = typeof(OpennessMarkerExtensions).Assembly;
                return Convert.ToString(assembly.GetName().Version);
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>Actionable hint for the well-known resolver failures.</summary>
        private static string HintFor(Exception ex)
        {
            if (ex is FileNotFoundException || ex is FileLoadException || ex is BadImageFormatException
                || ex is TypeLoadException
                || (ex.Message ?? string.Empty).IndexOf("Siemens.Engineering", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "No Siemens.Engineering assembly for TIA Portal V" + TiaPortalMajorVersion
                    + " could be located. Install that version, or set TiaPortalLocation / pass --openness-dir, and make "
                    + "sure this process is 64-bit.";
            }
            if (ex is ArgumentException)
            {
                return "The resolver rejected its arguments. The TIA Portal version must be passed as the named argument "
                    + "'tiaMajorVersion'; the positional Int32 overload attaches to a running TIA Portal process instead.";
            }
            return null;
        }

        /// <summary>
        /// Diagnostics for the ready banner. Reads the same registry value the
        /// official reference package reads, so what the banner reports is what the
        /// build and the resolver will use.
        /// </summary>
        public static JsonObject Probe(string opennessDirectory, IList<string> fallbackDirectories)
        {
            JsonObject result = new JsonObject();
            result.Add("tiaMajorVersion", TiaPortalMajorVersion);
            result.Add("resolver", "Siemens.Collaboration.Net.TiaPortal.Openness.Resolver");
            result.AddIfPresent("resolverVersion", ResolverVersion());

            string fromRegistry = ReadEngineeringPathFromRegistry();
            string resolvedPath = fromRegistry;
            string resolvedFrom = fromRegistry != null ? "registry" : null;

            string location = Environment.GetEnvironmentVariable(TiaPortalLocationVariable);
            if (resolvedPath == null && !string.IsNullOrWhiteSpace(location))
            {
                string candidate = Path.Combine(location, @"PublicAPI\V" + TiaPortalMajorVersion, "Siemens.Engineering.dll");
                if (File.Exists(candidate))
                {
                    resolvedPath = candidate;
                    resolvedFrom = "TiaPortalLocation";
                }
            }
            if (resolvedPath == null && !string.IsNullOrWhiteSpace(opennessDirectory))
            {
                string candidate = Path.Combine(opennessDirectory, "Siemens.Engineering.dll");
                if (File.Exists(candidate))
                {
                    resolvedPath = candidate;
                    resolvedFrom = "configured";
                }
            }

            result.Add("opennessDir", opennessDirectory);
            result.AddIfPresent("resolvedFrom", resolvedFrom);
            result.AddIfPresent("assemblyPath", resolvedPath);
            result.Add("candidateDirectories", fallbackDirectories);

            if (resolvedPath == null || !File.Exists(resolvedPath))
            {
                result.Add("available", false);
                result.Add("reason", "not_found");
                result.Add("message", "No Siemens.Engineering.dll was found for TIA Portal V" + TiaPortalMajorVersion
                    + ". Install that TIA Portal version, or set TiaPortalLocation / pass --openness-dir.");
                return result;
            }

            try
            {
                FileVersionInfo fileVersion = FileVersionInfo.GetVersionInfo(resolvedPath);
                result.AddIfPresent("fileVersion", fileVersion.FileVersion);
            }
            catch (Exception)
            {
                // Version metadata is optional diagnostics.
            }

            try
            {
                AssemblyName name = AssemblyName.GetAssemblyName(resolvedPath);
                result.AddIfPresent("assemblyVersion", Convert.ToString(name.Version));
                result.AddIfPresent("processorArchitecture", Convert.ToString(name.ProcessorArchitecture));
            }
            catch (BadImageFormatException)
            {
                result.Add("available", false);
                result.Add("reason", "bad_image");
                result.Add("message", "Siemens.Engineering.dll is not a loadable 64-bit .NET assembly; the controller must run as x64.");
                return result;
            }
            catch (Exception ex)
            {
                result.Add("available", false);
                result.Add("reason", "unreadable");
                result.Add("message", "Siemens.Engineering.dll could not be identified: " + ex.Message);
                return result;
            }

            result.Add("available", true);
            return result;
        }

        /// <summary>
        /// Reads the registry value the official Siemens reference package uses:
        /// <c>HKLM\SOFTWARE\Siemens\Automation\Openness\17.0\PublicAPI\17.0.0.0</c> →
        /// value <c>Siemens.Engineering</c>. Returns null when it is absent.
        /// </summary>
        private static string ReadEngineeringPathFromRegistry()
        {
            string relative = string.Format(
                @"SOFTWARE\Siemens\Automation\Openness\{0}.0\PublicAPI\{0}.0.0.0",
                TiaPortalMajorVersion);

            foreach (RegistryView view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
            {
                try
                {
                    using (RegistryKey baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
                    {
                        using (RegistryKey key = baseKey.OpenSubKey(relative))
                        {
                            if (key == null) continue;
                            string value = Convert.ToString(key.GetValue("Siemens.Engineering"));
                            if (!string.IsNullOrWhiteSpace(value) && File.Exists(value)) return value;
                        }
                    }
                }
                catch (Exception)
                {
                    // A locked-down registry just means "not found this way".
                }
            }
            return null;
        }
    }
}
