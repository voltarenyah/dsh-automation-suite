namespace DshSuite.Shell;

internal sealed record DshLaunch(string Exe, string CliPath, string WorkingDirectory);

internal static class DshLocator
{
    public static DshLaunch Resolve()
    {
        var candidates = new List<string?>
        {
            Environment.GetEnvironmentVariable("DSH_EXE"),
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs", "DeepSeek Harness", "resources", "runtime", "cli", "bin", "dsh.cmd"),
        };

        var dsh = candidates.FirstOrDefault(candidate => !string.IsNullOrWhiteSpace(candidate) && File.Exists(candidate));
        if (dsh is null)
        {
            throw new InvalidOperationException(
                "dsh.cmd was not found. Install DeepSeek Harness or set DSH_EXE.");
        }

        var appRoot = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(dsh)!, "..", "..", "..", ".."));
        var exe = Path.Combine(appRoot, "DeepSeek Harness.exe");
        var cli = Path.Combine(
            appRoot, "resources", "app.asar", "dsh", "node_modules",
            "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js");

        if (!File.Exists(exe))
        {
            throw new InvalidOperationException($"cannot find the DSH executable below {appRoot}");
        }

        return new DshLaunch(exe, cli, appRoot);
    }
}
