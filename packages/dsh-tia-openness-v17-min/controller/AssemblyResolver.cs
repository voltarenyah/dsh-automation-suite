using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>
    /// Locates and loads the TIA Portal V17 Openness assemblies.
    ///
    /// Ordering matters: Openness must be resolved by the process the moment the
    /// first Openness type is touched, and the assemblies always live in the TIA
    /// Portal installation directory — not next to this controller. The handler
    /// below is therefore installed as the first statement of <c>Main</c>, before
    /// any code path that could JIT a method whose body references
    /// <c>Siemens.Engineering</c>.
    /// </summary>
    internal static class AssemblyResolver
    {
        /// <summary>Openness location of a default single-version TIA Portal V17 installation.</summary>
        public const string DefaultOpennessDir = @"C:\Program Files\Siemens\Automation\Portal V17\PublicAPI\V17";

        private const string OpennessAssemblyName = "Siemens.Engineering";

        private static readonly object Gate = new object();
        private static bool _installed;
        private static string[] _probeDirectories = new string[0];
        private static string _opennessPath;
        private static string _opennessDir;

        /// <summary>True once <see cref="Install"/> has registered the resolve handler.</summary>
        public static bool IsInstalled { get { return _installed; } }

        /// <summary>The Openness directory the controller was configured with.</summary>
        public static string OpennessDirectory { get { return _opennessDir; } }

        /// <summary>The resolved absolute path of Siemens.Engineering.dll, if it exists.</summary>
        public static string OpennessAssemblyPath { get { return _opennessPath; } }

        /// <summary>Reads the configured Openness directory, honouring the documented environment override.</summary>
        public static string ConfiguredOpennessDir(string commandLineValue)
        {
            if (!string.IsNullOrWhiteSpace(commandLineValue)) return Path.GetFullPath(commandLineValue.Trim());

            string fromEnvironment = Environment.GetEnvironmentVariable("TIA_OPENNESS_V17_DIR");
            if (!string.IsNullOrWhiteSpace(fromEnvironment)) return Path.GetFullPath(fromEnvironment.Trim());

            return DefaultOpennessDir;
        }

        /// <summary>
        /// Registers this controller's own assembly probe as the <b>last resort</b>.
        ///
        /// Siemens' resolver (see <see cref="OpennessBootstrap"/>) is the primary
        /// mechanism and is registered first, so it wins every lookup. This handler
        /// only runs when nothing else could resolve an assembly, which turns a
        /// hard <c>FileNotFoundException</c> into a normal structured failure.
        /// Idempotent; the first caller owns the configured directory.
        /// </summary>
        public static void InstallFallback(string opennessDirectory, DiagnosticLog log)
        {
            lock (Gate)
            {
                if (_installed) return;

                _opennessDir = Path.GetFullPath(opennessDirectory);
                _opennessPath = Path.Combine(_opennessDir, OpennessAssemblyName + ".dll");
                _probeDirectories = BuildProbeDirectories(_opennessDir);

                AppDomain.CurrentDomain.AssemblyResolve += OnAssemblyResolve;
                _installed = true;

                if (log != null)
                {
                    log.Info("Registered the fallback assembly probe over " + _probeDirectories.Length
                        + " director(ies); Siemens' resolver stays the primary mechanism.");
                }
            }
        }

        /// <summary>Directories the fallback probe consults, for diagnostics.</summary>
        public static IList<string> CandidateDirectories
        {
            get
            {
                string directory = _opennessDir ?? DefaultOpennessDir;
                if (_probeDirectories != null && _probeDirectories.Length > 0) return _probeDirectories;
                return BuildProbeDirectories(directory);
            }
        }

        /// <summary>
        /// Builds the probe order: the configured API folder first, then the
        /// deployment folders of the same installation that hold the Openness
        /// runtime, then this executable's own folder (for testing with a
        /// side-by-side copy), then the base directory.
        /// </summary>
        private static string[] BuildProbeDirectories(string opennessDirectory)
        {
            List<string> directories = new List<string>();
            AddDirectory(directories, opennessDirectory);

            string portalRoot = PortalRootOf(opennessDirectory);
            if (portalRoot != null)
            {
                AddDirectory(directories, Path.Combine(portalRoot, @"Bin\PublicAPI\V17"));
                AddDirectory(directories, Path.Combine(portalRoot, @"Bin\PublicAPI"));
                AddDirectory(directories, Path.Combine(portalRoot, "Bin"));
            }

            AddDirectory(directories, AppDomain.CurrentDomain.BaseDirectory);
            return directories.ToArray();
        }

        /// <summary>
        /// Derives the TIA Portal installation root from an Openness folder such
        /// as <c>...\Portal V17\PublicAPI\V17</c>. Returns null when the folder has
        /// an unexpected shape.
        /// </summary>
        public static string PortalRootOf(string opennessDirectory)
        {
            try
            {
                DirectoryInfo api = new DirectoryInfo(opennessDirectory);
                DirectoryInfo publicApi = api.Parent;
                if (publicApi == null) return null;
                DirectoryInfo root = publicApi.Parent;
                if (root == null) return null;
                if (!string.Equals(publicApi.Name, "PublicAPI", StringComparison.OrdinalIgnoreCase)) return null;
                return root.FullName;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static void AddDirectory(List<string> directories, string directory)
        {
            if (string.IsNullOrWhiteSpace(directory)) return;
            string full;
            try
            {
                full = Path.GetFullPath(directory);
            }
            catch (Exception)
            {
                return;
            }
            if (!Directory.Exists(full)) return;
            foreach (string existing in directories)
            {
                if (string.Equals(existing, full, StringComparison.OrdinalIgnoreCase)) return;
            }
            directories.Add(full);
        }

        private static Assembly OnAssemblyResolve(object sender, ResolveEventArgs args)
        {
            AssemblyName requested;
            try
            {
                requested = new AssemblyName(args.Name);
            }
            catch (Exception)
            {
                return null;
            }

            string simpleName = requested.Name;
            if (string.IsNullOrEmpty(simpleName)) return null;
            if (simpleName.EndsWith(".resources", StringComparison.OrdinalIgnoreCase)) return null;

            string[] directories = _probeDirectories;
            for (int i = 0; i < directories.Length; i++)
            {
                Assembly loaded = TryLoadFrom(directories[i], simpleName + ".dll");
                if (loaded != null) return loaded;
            }

            // Versioned companions ship under decorated file names
            // (Siemens.Engineering.Meta.Cax.17.0.0.0.dll); match them by prefix.
            for (int i = 0; i < directories.Length; i++)
            {
                string prefix = simpleName + ".";
                string[] candidates;
                try
                {
                    candidates = Directory.GetFiles(directories[i], prefix + "*.dll");
                }
                catch (Exception)
                {
                    continue;
                }
                for (int c = 0; c < candidates.Length; c++)
                {
                    Assembly loaded = TryLoadFrom(Path.GetDirectoryName(candidates[c]), Path.GetFileName(candidates[c]));
                    if (loaded != null)
                    {
                        AssemblyName loadedName = loaded.GetName();
                        if (string.Equals(loadedName.Name, simpleName, StringComparison.OrdinalIgnoreCase)) return loaded;
                    }
                }
            }

            return null;
        }

        private static Assembly TryLoadFrom(string directory, string fileName)
        {
            if (string.IsNullOrEmpty(directory) || string.IsNullOrEmpty(fileName)) return null;
            string candidate = Path.Combine(directory, fileName);
            if (!File.Exists(candidate)) return null;
            try
            {
                return Assembly.LoadFrom(candidate);
            }
            catch (Exception)
            {
                return null;
            }
        }

    }
}
