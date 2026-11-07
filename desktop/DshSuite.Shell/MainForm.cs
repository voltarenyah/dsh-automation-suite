using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DshSuite.Shell;

internal sealed class MainForm : Form
{
    private readonly string _appDir;
    private readonly string _dshHome;
    private readonly string _profile;
    private readonly Log _log;
    private readonly DshHost _host;
    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill };
    private readonly Label _status = new()
    {
        Dock = DockStyle.Top,
        Height = 30,
        TextAlign = ContentAlignment.MiddleLeft,
        Padding = new Padding(10, 0, 10, 0),
        Text = "Starting...",
    };
    private readonly NotifyIcon _tray;
    private bool _started;
    private bool _exiting;
    private bool _balloonShown;

    public MainForm(string appDir, string dshHome, string profile, Log log)
    {
        _appDir = appDir;
        _dshHome = dshHome;
        _profile = profile;
        _log = log;
        _host = new DshHost(log);

        Text = "DSH Automation Suite";
        Width = 1440;
        Height = 900;
        MinimumSize = new Size(900, 600);
        StartPosition = FormStartPosition.CenterScreen;
        Controls.Add(_webView);
        Controls.Add(_status);

        var menu = new ContextMenuStrip();
        menu.Items.Add("Open", null, (_, _) => RestoreWindow());
        menu.Items.Add("Doctor", null, async (_, _) => await ShowDoctorAsync());
        menu.Items.Add("Open logs", null, (_, _) => OpenLogs());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => ExitApp());

        _tray = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "DSH Automation Suite",
            Visible = true,
            ContextMenuStrip = menu,
        };
        _tray.DoubleClick += (_, _) => RestoreWindow();

        FormClosing += OnFormClosing;
    }

    protected override async void OnShown(EventArgs e)
    {
        base.OnShown(e);
        if (_started) return;
        _started = true;
        try
        {
            SetStatus("Preparing profile...");
            await Task.Run(() => AppPaths.EnsureProfile(_appDir, _dshHome, _profile, _log, SetStatus));

            SetStatus("Starting DSH...");
            var url = await _host.StartAsync(_dshHome, _profile, TimeSpan.FromSeconds(120), CancellationToken.None);

            SetStatus("Loading Web UI...");
            await InitializeWebViewAsync(url);
        }
        catch (Exception error)
        {
            _log.Write("shell", $"startup failed: {error}");
            _host.Stop();
            SetStatus("Startup failed: " + error.Message);
            MessageBox.Show(this, error.Message, "DSH Automation Suite", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private async Task InitializeWebViewAsync(string url)
    {
        var userData = Path.Combine(_dshHome, "webview2");
        Directory.CreateDirectory(userData);
        var environment = await CoreWebView2Environment.CreateAsync(null, userData);
        await _webView.EnsureCoreWebView2Async(environment);

        var core = _webView.CoreWebView2;
        core.Settings.AreDevToolsEnabled = true;
        core.Settings.IsStatusBarEnabled = false;
        core.NewWindowRequested += (_, args) =>
        {
            args.Handled = true;
            OpenExternal(args.Uri);
        };
        core.NavigationCompleted += (_, args) =>
        {
            SetStatus(args.IsSuccess ? "Ready" : $"Navigation failed: {args.WebErrorStatus}");
        };

        _webView.Source = new Uri(url);
    }

    private void SetStatus(string text)
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action(() => _status.Text = text));
            return;
        }
        _status.Text = text;
    }

    private async Task ShowDoctorAsync()
    {
        try
        {
            var doctor = Path.Combine(_appDir, "doctor.ps1");
            if (!File.Exists(doctor))
            {
                MessageBox.Show(this, "doctor.ps1 is not installed next to the app layer.", "Doctor",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            SetStatus("Running doctor...");
            var output = await Task.Run(() =>
            {
                var startInfo = new ProcessStartInfo("powershell")
                {
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                };
                startInfo.ArgumentList.Add("-NoProfile");
                startInfo.ArgumentList.Add("-File");
                startInfo.ArgumentList.Add(doctor);
                startInfo.ArgumentList.Add("-DshHome");
                startInfo.ArgumentList.Add(_dshHome);
                startInfo.ArgumentList.Add("-Profile");
                startInfo.ArgumentList.Add(_profile);
                using var process = Process.Start(startInfo)
                    ?? throw new InvalidOperationException("could not start pwsh");
                var stdout = process.StandardOutput.ReadToEnd();
                var stderr = process.StandardError.ReadToEnd();
                process.WaitForExit();
                return stdout + stderr;
            });

            SetStatus("Ready");
            using var dialog = new Form
            {
                Text = "DSH Automation Suite — Doctor",
                Width = 900,
                Height = 600,
                StartPosition = FormStartPosition.CenterParent,
            };
            dialog.Controls.Add(new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Both,
                Dock = DockStyle.Fill,
                Font = new Font("Consolas", 9f),
                Text = output,
            });
            dialog.ShowDialog(this);
        }
        catch (Exception error)
        {
            _log.Write("doctor", error.ToString());
            MessageBox.Show(this, error.Message, "Doctor", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void OpenLogs()
    {
        try
        {
            Process.Start(new ProcessStartInfo("explorer.exe", $"\"{_log.DirectoryPath}\"")
            {
                UseShellExecute = true,
            });
        }
        catch (Exception error)
        {
            _log.Write("shell", $"open logs failed: {error.Message}");
        }
    }

    private static void OpenExternal(string uri)
    {
        try
        {
            Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true });
        }
        catch
        {
            // The default browser is the user's choice; failure is not fatal.
        }
    }

    private void RestoreWindow()
    {
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
    }

    private void ExitApp()
    {
        _exiting = true;
        _host.Stop();
        _tray.Visible = false;
        Close();
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (_exiting || e.CloseReason == CloseReason.WindowsShutDown)
        {
            _exiting = true;
            _host.Stop();
            _tray.Visible = false;
            return;
        }

        e.Cancel = true;
        Hide();
        if (!_balloonShown)
        {
            _balloonShown = true;
            _tray.ShowBalloonTip(1500, "DSH Automation Suite", "Still running in the tray. Use Exit to stop DSH.", ToolTipIcon.Info);
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _host.Dispose();
            _tray.Visible = false;
            _tray.Dispose();
            _webView.Dispose();
            _status.Dispose();
        }
        base.Dispose(disposing);
    }
}
