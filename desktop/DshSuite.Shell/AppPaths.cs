using System.Text.Json;

namespace DshSuite.Shell;

/// <summary>Resolves the installed app directory, DSH_HOME, profile name, and copies the app-layer profile.</summary>
internal static class AppPaths
{
    public static string ResolveAppDir(string? argument)
    {
        // An explicit app dir wins.
        foreach (var explicitDir in new[] { argument, Environment.GetEnvironmentVariable("DSH_SUITE_APP_DIR") })
        {
            if (!string.IsNullOrWhiteSpace(explicitDir) && IsAppDir(Path.GetFullPath(explicitDir)))
            {
                return Path.GetFullPath(explicitDir);
            }
        }

        // Search the executable's ancestors and the current directory's
        // ancestors. This makes the build-output exe (desktop/.../bin/...)
        // find dist/desktop/<ver>/app, and the installed shell find
        // <root>/app/<ver> via current.txt or the newest manifest.
        var roots = new List<string>();
        void AddRoot(string? path)
        {
            if (string.IsNullOrWhiteSpace(path)) return;
            try
            {
                var full = Path.GetFullPath(path);
                if (Directory.Exists(full)) roots.Add(full);
            }
            catch
            {
                // Ignore malformed paths.
            }
        }

        foreach (var start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            var directory = new DirectoryInfo(start);
            for (var i = 0; i < 10 && directory is not null; i++)
            {
                AddRoot(directory.FullName);
                directory = directory.Parent;
            }
        }

        foreach (var root in roots.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var found = FindAppUnderRoot(root);
            if (found is not null) return found;
        }

        throw new InvalidOperationException(
            "cannot find the desktop app layer (profile/package.json + app-manifest.json). " +
            "Pass --app-dir <dir> or set DSH_SUITE_APP_DIR. " +
            $"Searched from {AppContext.BaseDirectory} and {Environment.CurrentDirectory}.");
    }

    private static string? FindAppUnderRoot(string root)
    {
        if (IsAppDir(root)) return root;

        var installed = FindInstalledApp(root);
        if (installed is not null) return installed;

        var name = Path.GetFileName(root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        if (name.Equals("desktop", StringComparison.OrdinalIgnoreCase) ||
            name.Equals("desktop-build", StringComparison.OrdinalIgnoreCase))
        {
            var versioned = FindVersionedApp(root);
            if (versioned is not null) return versioned;
        }

        // Repo checkout: <repo>/dist/desktop/<ver>/app or <repo>/dist/desktop-build/<ver>/app.
        foreach (var tree in new[] { "desktop", "desktop-build" })
        {
            var versioned = FindVersionedApp(Path.Combine(root, "dist", tree));
            if (versioned is not null) return versioned;
        }

        // Ancestor is <repo>/dist: scan its desktop* children.
        var dist = Path.Combine(root, "dist");
        if (Directory.Exists(dist))
        {
            foreach (var child in Directory.GetDirectories(dist))
            {
                var childName = Path.GetFileName(child);
                if (!childName.StartsWith("desktop", StringComparison.OrdinalIgnoreCase)) continue;
                var versioned = FindVersionedApp(child);
                if (versioned is not null) return versioned;
            }
        }

        return null;
    }

    private static string? FindVersionedApp(string root)
    {
        if (!Directory.Exists(root)) return null;

        var candidates = new List<(Version Version, string AppDir)>();
        foreach (var versionDir in Directory.GetDirectories(root))
        {
            var appDir = Path.Combine(versionDir, "app");
            if (!IsAppDir(appDir)) continue;
            var version = ReadAppVersion(Path.Combine(appDir, "app-manifest.json"), versionDir);
            if (version is not null) candidates.Add((version, appDir));
        }

        return candidates.OrderByDescending(candidate => candidate.Version).FirstOrDefault().AppDir;
    }

    private static string? FindInstalledApp(string root)
    {
        var current = Path.Combine(root, "current.txt");
        if (File.Exists(current))
        {
            var version = File.ReadAllText(current).Trim().TrimStart('v', 'V');
            var candidate = Path.Combine(root, "app", version);
            if (IsAppDir(candidate)) return candidate;
        }

        var apps = Path.Combine(root, "app");
        if (!Directory.Exists(apps)) return null;

        var candidates = new List<(Version Version, string Directory)>();
        foreach (var directory in Directory.GetDirectories(apps))
        {
            if (!IsAppDir(directory)) continue;
            var version = ReadAppVersion(Path.Combine(directory, "app-manifest.json"), directory);
            if (version is not null) candidates.Add((version, directory));
        }

        return candidates.OrderByDescending(candidate => candidate.Version).FirstOrDefault().Directory;
    }

    private static Version? ReadAppVersion(string manifestPath, string fallbackDirectory)
    {
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(manifestPath));
            var text = document.RootElement.TryGetProperty("appLayerVersion", out var version)
                ? version.GetString()
                : null;
            if (text is not null && Version.TryParse(text, out var parsed)) return parsed;
        }
        catch
        {
            // Fall through to the directory name.
        }

        var name = Path.GetFileName(fallbackDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        return Version.TryParse(name, out var fallback) ? fallback : null;
    }

    private static bool IsAppDir(string directory) =>
        File.Exists(Path.Combine(directory, "profile", "package.json")) &&
        File.Exists(Path.Combine(directory, "app-manifest.json"));

    public static string ResolveDshHome(string? argument)
    {
        var value = argument
            ?? Environment.GetEnvironmentVariable("DSH_HOME")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "dsh-automation-suite-home");
        return Path.GetFullPath(value);
    }

    public static string ResolveProfile(string? argument)
    {
        return argument
            ?? Environment.GetEnvironmentVariable("DSH_SUITE_PROFILE")
            ?? "dsh-automation-suite";
    }

    /// <summary>
    /// Copy the app-layer profile to <c>&lt;DSH_HOME&gt;/profiles/&lt;profile&gt;</c> on first run.
    /// An existing profile is reused as-is; the installer owns upgrades and merging.
    /// </summary>
    public static void EnsureProfile(string appDir, string dshHome, string profile, Log log, Action<string>? status = null)
    {
        var source = Path.Combine(appDir, "profile");
        var target = Path.Combine(dshHome, "profiles", profile);

        if (Directory.Exists(target))
        {
            var info = new DirectoryInfo(target);
            if ((info.Attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidOperationException($"refusing to use a junction/symlink profile: {target}");
            }
            if (File.Exists(Path.Combine(target, "package.json")))
            {
                log.Write("profile", $"using existing profile {target}");
                status?.Invoke("Using existing profile");
                return;
            }
            throw new InvalidOperationException(
                $"profile directory exists but has no package.json: {target}. " +
                "Move it away or choose another --profile.");
        }

        status?.Invoke("Copying app layer profile (first run)...");
        log.Write("profile", $"copying {source} -> {target}");
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        CopyDirectory(source, target);

        try
        {
            var manifestPath = Path.Combine(appDir, "app-manifest.json");
            if (File.Exists(manifestPath))
            {
                using var document = JsonDocument.Parse(File.ReadAllText(manifestPath));
                var marker = new
                {
                    appLayerVersion = document.RootElement.TryGetProperty("appLayerVersion", out var v) ? v.GetString() : null,
                    sourceCommit = document.RootElement.TryGetProperty("sourceCommit", out var c) ? c.GetString() : null,
                    installedAt = DateTimeOffset.UtcNow.ToString("O"),
                };
                File.WriteAllText(
                    Path.Combine(target, ".app-layer.json"),
                    JsonSerializer.Serialize(marker, new JsonSerializerOptions { WriteIndented = true }));
            }
        }
        catch (Exception error)
        {
            log.Write("profile", $"could not write .app-layer.json: {error.Message}");
        }
    }

    private static void CopyDirectory(string source, string target)
    {
        Directory.CreateDirectory(target);
        foreach (var file in Directory.GetFiles(source))
        {
            File.Copy(file, Path.Combine(target, Path.GetFileName(file)), overwrite: true);
        }
        foreach (var directory in Directory.GetDirectories(source))
        {
            CopyDirectory(directory, Path.Combine(target, Path.GetFileName(directory)));
        }
    }
}
