using System.Text.Json;

namespace DshSuite.Shell;

/// <summary>Resolves the installed app directory, DSH_HOME, profile name, and copies the app-layer profile.</summary>
internal static class AppPaths
{
    public static string ResolveAppDir(string? argument)
    {
        var candidates = new List<string?>
        {
            argument,
            Environment.GetEnvironmentVariable("DSH_SUITE_APP_DIR"),
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..")),
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..")),
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..")),
        };

        foreach (var candidate in candidates)
        {
            if (string.IsNullOrWhiteSpace(candidate)) continue;
            var full = Path.GetFullPath(candidate);
            if (IsAppDir(full)) return full;
        }

        // Installed layout: <root>\shell\DshSuite.Shell.exe and
        // <root>\app\<version>\{profile,app-manifest.json}. Prefer current.txt,
        // then the newest app-manifest version.
        var root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, ".."));
        var installed = FindInstalledApp(root);
        if (installed is not null) return installed;

        throw new InvalidOperationException(
            "cannot find the desktop app layer (profile/package.json + app-manifest.json). " +
            "Pass --app-dir <dir> or set DSH_SUITE_APP_DIR.");
    }

    private static bool IsAppDir(string directory) =>
        File.Exists(Path.Combine(directory, "profile", "package.json")) &&
        File.Exists(Path.Combine(directory, "app-manifest.json"));

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
            var manifest = Path.Combine(directory, "app-manifest.json");
            try
            {
                using var document = JsonDocument.Parse(File.ReadAllText(manifest));
                var text = document.RootElement.TryGetProperty("appLayerVersion", out var version)
                    ? version.GetString()
                    : null;
                if (text is not null && Version.TryParse(text, out var parsed))
                {
                    candidates.Add((parsed, directory));
                }
            }
            catch
            {
                // A broken manifest is ignored; another version may be usable.
            }
        }

        return candidates.OrderByDescending(candidate => candidate.Version).FirstOrDefault().Directory;
    }

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
