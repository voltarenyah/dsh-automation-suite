using System.Threading;
using System.Windows.Forms;

namespace DshSuite.Shell;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        Options options;
        try
        {
            options = Options.Parse(args);
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "DSH Automation Suite", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 2;
        }

        var log = new Log(Path.Combine(options.DshHome, "logs"));
        try
        {
            var appDir = AppPaths.ResolveAppDir(options.AppDir);
            if (options.SmokeTest)
            {
                return SmokeRunner.Run(appDir, options.DshHome, options.Profile, log);
            }

            using var mutex = new Mutex(true, @"Local\DshAutomationSuite", out var created);
            if (!created)
            {
                MessageBox.Show(
                    "DSH Automation Suite is already running. Use the tray icon to open the existing window.",
                    "DSH Automation Suite",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
                return 0;
            }

            log.Write("shell", $"starting appDir={appDir} dshHome={options.DshHome} profile={options.Profile}");
            Application.Run(new MainForm(appDir, options.DshHome, options.Profile, log));
            return 0;
        }
        catch (Exception error)
        {
            log.Write("shell", $"fatal: {error}");
            MessageBox.Show(error.Message, "DSH Automation Suite", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private sealed class Options
    {
        public string? AppDir { get; private init; }
        public string DshHome { get; private init; } = string.Empty;
        public string Profile { get; private init; } = string.Empty;
        public bool SmokeTest { get; private init; }

        public static Options Parse(string[] args)
        {
            string? appDir = null;
            string? dshHome = null;
            string? profile = null;
            var smoke = false;

            for (var i = 0; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--app-dir":
                        appDir = RequireValue(args, ref i);
                        break;
                    case "--dsh-home":
                        dshHome = RequireValue(args, ref i);
                        break;
                    case "--profile":
                        profile = RequireValue(args, ref i);
                        break;
                    case "--smoke-test":
                        smoke = true;
                        break;
                    default:
                        throw new ArgumentException($"unknown argument: {args[i]}");
                }
            }

            return new Options
            {
                AppDir = appDir,
                DshHome = AppPaths.ResolveDshHome(dshHome),
                Profile = AppPaths.ResolveProfile(profile),
                SmokeTest = smoke,
            };
        }

        private static string RequireValue(string[] args, ref int index)
        {
            if (index + 1 >= args.Length) throw new ArgumentException($"{args[index]} needs a value");
            return args[++index];
        }
    }
}
