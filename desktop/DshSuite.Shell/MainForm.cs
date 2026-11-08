using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DshSuite.Shell;

/// <summary>
/// Frameless host window. The window chrome (Application/Edit menus and the
/// minimize/maximize/close controls) is rendered inside the DSH Web UI by
/// <c>TitleBarScript.js</c>, mirroring the official DeepSeek Harness desktop
/// window. The client fills the whole window (no native frame strip); Windows
/// still owns the sizing loop and the DWM shadow.
/// </summary>
internal sealed class MainForm : Form
{
    private const string TitleBarResource = "DshSuite.Shell.TitleBarScript.js";

    private readonly string _appDir;
    private readonly string _dshHome;
    private readonly string _profile;
    private readonly Log _log;
    private readonly DshHost _host;
    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill };
    private readonly Label _loading = new()
    {
        Dock = DockStyle.Fill,
        TextAlign = ContentAlignment.MiddleCenter,
        BackColor = Color.FromArgb(27, 27, 28),
        ForeColor = Color.FromArgb(214, 217, 222),
        Font = new Font("Segoe UI", 12f, FontStyle.Regular, GraphicsUnit.Point),
        Text = "Starting DSH Automation Suite…",
    };
    private readonly NotifyIcon _tray;
    private bool _started;
    private bool _exiting;
    private bool _balloonShown;
    private bool _webViewReady;

    public MainForm(string appDir, string dshHome, string profile, Log log)
    {
        _appDir = appDir;
        _dshHome = dshHome;
        _profile = profile;
        _log = log;
        _host = new DshHost(log);

        Text = "DSH Automation Suite";
        FormBorderStyle = FormBorderStyle.None;
        BackColor = Color.FromArgb(27, 27, 28);
        Width = 1440;
        Height = 900;
        MinimumSize = new Size(900, 600);
        StartPosition = FormStartPosition.CenterScreen;
        DoubleBuffered = true;

        Controls.Add(_webView);
        Controls.Add(_loading);
        _loading.BringToFront();

        var appIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
        Icon = (Icon)appIcon.Clone();

        var menu = new ContextMenuStrip();
        menu.Items.Add("Open", null, (_, _) => RestoreWindow());
        menu.Items.Add("Doctor", null, async (_, _) => await ShowDoctorAsync());
        menu.Items.Add("Open logs", null, (_, _) => OpenLogs());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => ExitApp());

        _tray = new NotifyIcon
        {
            Icon = appIcon,
            Text = "DSH Automation Suite",
            Visible = true,
            ContextMenuStrip = menu,
        };
        _tray.DoubleClick += (_, _) => RestoreWindow();

        FormClosing += OnFormClosing;
        Activated += (_, _) => PostState();
        Deactivate += (_, _) => PostState();
        Resize += (_, _) => PostState();
    }

    /// <summary>
    /// Keep WS_THICKFRAME (native sizing loop, snap, minimise animation) and
    /// the minimise/maximise/system style bits while dropping the caption: a
    /// borderless form by itself is a WS_POPUP window that cannot be resized.
    /// </summary>
    protected override CreateParams CreateParams
    {
        get
        {
            var parameters = base.CreateParams;
            parameters.Style |= NativeMethods.WsThickFrame
                | NativeMethods.WsMinimizeBox
                | NativeMethods.WsMaximizeBox
                | NativeMethods.WsSysMenu;
            return parameters;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        NativeMethods.ApplyFramelessChrome(this);
    }

    /// <summary>
    /// Make the client area cover the whole window. Without this Windows
    /// reserves the 8 px sizing frame at the top (painted in the frame colour,
    /// black in dark mode), which shows up as a line above the title strip.
    /// Resizing is initiated from the web content instead (see the "resize"
    /// message handler), so dropping the native non-client frame is safe.
    /// </summary>
    protected override void WndProc(ref Message message)
    {
        const int WmNcCalcSize = 0x0083;
        if (message.Msg == WmNcCalcSize && message.WParam != IntPtr.Zero)
        {
            if (NativeMethods.IsMaximized(Handle))
            {
                // The maximized window rectangle overhangs the monitor by the
                // (invisible) frame. Pin the client to the work area so the
                // title strip starts at the visible top edge instead of being
                // pushed off-screen.
                var parameters = Marshal.PtrToStructure<NcCalcSizeParams>(message.LParam);
                parameters.Rgrc0 = NativeMethods.GetWorkArea(Handle);
                Marshal.StructureToPtr(parameters, message.LParam, false);
            }
            // For a normal window Windows proposes the full window rectangle as
            // the client; leaving it untouched gives us an edge-to-edge client.
            message.Result = IntPtr.Zero;
            return;
        }
        base.WndProc(ref message);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NcCalcSizeParams
    {
        public NativeMethods.Rect Rgrc0;
        public NativeMethods.Rect Rgrc1;
        public NativeMethods.Rect Rgrc2;
        public IntPtr LpPos;
    }

    protected override void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        FitToWorkArea();
    }

    /// <summary>
    /// Open at a desktop-sized window instead of a fixed pixel size: with high
    /// DPI the old 1440x900 window was only ~740 CSS px wide and the DSH layout
    /// auto-hid the sidebar. Filling most of the work area keeps the shell in
    /// the same shape as the official DeepSeek Harness window.
    /// </summary>
    private void FitToWorkArea()
    {
        try
        {
            var area = Screen.FromHandle(Handle).WorkingArea;
            var width = Math.Min(area.Width, Math.Max(MinimumSize.Width, (int)(area.Width * 0.9)));
            var height = Math.Min(area.Height, Math.Max(MinimumSize.Height, (int)(area.Height * 0.9)));
            Bounds = new Rectangle(
                area.Left + (area.Width - width) / 2,
                area.Top + (area.Height - height) / 2,
                width,
                height);
            _log.Write("shell", $"window bounds {Bounds}; work area {area}");
        }
        catch (Exception error)
        {
            _log.Write("shell", $"could not fit the window to the work area: {error.Message}");
        }
    }

    protected override async void OnShown(EventArgs e)
    {
        base.OnShown(e);
        if (_started) return;
        _started = true;
        try
        {
            SetLoading("Preparing profile…");
            await Task.Run(() => AppPaths.EnsureProfile(_appDir, _dshHome, _profile, _log, SetLoading));

            SetLoading("Starting DSH…");
            var url = await _host.StartAsync(_dshHome, _profile, TimeSpan.FromSeconds(120), CancellationToken.None);

            SetLoading("Loading Web UI…");
            await InitializeWebViewAsync(url);
        }
        catch (Exception error)
        {
            _log.Write("shell", $"startup failed: {error}");
            _host.Stop();
            ShowLoadError("Startup failed: " + error.Message);
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
        // Lets WebView2 treat `-webkit-app-region: drag` elements (the 40 px
        // strip the DSH desktop layout renders) as the window title bar:
        // dragging, double-click maximise/restore and the system menu.
        core.Settings.IsNonClientRegionSupportEnabled = true;

        await core.AddScriptToExecuteOnDocumentCreatedAsync(LoadTitleBarScript());

        core.WebMessageReceived += OnWebMessageReceived;
        core.NewWindowRequested += (_, args) =>
        {
            args.Handled = true;
            OpenExternal(args.Uri);
        };
        core.NavigationCompleted += (_, args) =>
        {
            if (args.IsSuccess)
            {
                _webViewReady = true;
                HideLoading();
                PostState();
            }
            else
            {
                ShowLoadError($"Navigation failed: {args.WebErrorStatus}");
            }
        };

        _webView.Source = new Uri(url);
    }

    private static string LoadTitleBarScript()
    {
        using var stream = typeof(MainForm).Assembly.GetManifestResourceStream(TitleBarResource)
            ?? throw new InvalidOperationException($"missing embedded resource {TitleBarResource}");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string payload;
        try
        {
            payload = e.TryGetWebMessageAsString();
        }
        catch
        {
            return;
        }

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(payload);
        }
        catch
        {
            return;
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("type", out var typeElement))
            {
                return;
            }

            switch (typeElement.GetString())
            {
                case "hello":
                    PostState();
                    break;
                case "window":
                    HandleWindowCommand(root);
                    break;
                case "app":
                    HandleAppCommand(root);
                    break;
                case "paste-request":
                    PostClipboard();
                    break;
                case "resize":
                    HandleResizeCommand(root);
                    break;
                case "theme":
                    NativeMethods.SetDarkFrame(
                        this,
                        root.TryGetProperty("dark", out var dark) && dark.ValueKind == JsonValueKind.True);
                    break;
            }
        }
    }

    private void HandleWindowCommand(JsonElement message)
    {
        var action = message.TryGetProperty("action", out var value) ? value.GetString() : null;
        switch (action)
        {
            case "minimize":
                WindowState = FormWindowState.Minimized;
                break;
            case "toggle-maximize":
                WindowState = WindowState == FormWindowState.Maximized
                    ? FormWindowState.Normal
                    : FormWindowState.Maximized;
                break;
            case "close":
                Close();
                break;
        }
    }

    /// <summary>
    /// The client area now covers the native sizing frame, so the edges are
    /// web content. The injected script detects a press on an edge and asks the
    /// host to start the regular Win32 sizing loop from that hit-test code.
    /// </summary>
    private void HandleResizeCommand(JsonElement message)
    {
        var edge = message.TryGetProperty("edge", out var value) ? value.GetString() : null;
        var hit = edge switch
        {
            "left" => NativeMethods.HtLeft,
            "right" => NativeMethods.HtRight,
            "top" => NativeMethods.HtTop,
            "top-left" => NativeMethods.HtTopLeft,
            "top-right" => NativeMethods.HtTopRight,
            "bottom" => NativeMethods.HtBottom,
            "bottom-left" => NativeMethods.HtBottomLeft,
            "bottom-right" => NativeMethods.HtBottomRight,
            _ => 0,
        };
        if (hit == 0) return;

        NativeMethods.ReleaseCapture();
        NativeMethods.SendMessage(Handle, NativeMethods.WmNcLButtonDown, (IntPtr)hit, IntPtr.Zero);
    }

    private void HandleAppCommand(JsonElement message)
    {
        var action = message.TryGetProperty("action", out var value) ? value.GetString() : null;
        switch (action)
        {
            case "about":
                ShowAbout();
                break;
            case "logs":
                OpenLogs();
                break;
            case "doctor":
                _ = ShowDoctorAsync();
                break;
            case "exit":
                ExitApp();
                break;
        }
    }

    private void PostState()
    {
        if (!IsHandleCreated) return;
        if (InvokeRequired)
        {
            BeginInvoke(new Action(PostState));
            return;
        }
        if (!_webViewReady || _webView.CoreWebView2 is null) return;

        var payload = JsonSerializer.Serialize(new
        {
            type = "state",
            maximized = WindowState == FormWindowState.Maximized,
            active = ActiveForm == this,
        });
        try
        {
            _webView.CoreWebView2.PostWebMessageAsJson(payload);
        }
        catch
        {
            // The web view can disappear while the window is closing.
        }
    }

    private void PostClipboard()
    {
        string text;
        try
        {
            text = Clipboard.ContainsText() ? Clipboard.GetText() : string.Empty;
        }
        catch (Exception error)
        {
            _log.Write("shell", $"clipboard read failed: {error.Message}");
            text = string.Empty;
        }

        var payload = JsonSerializer.Serialize(new { type = "clipboard", text });
        try
        {
            _webView.CoreWebView2?.PostWebMessageAsJson(payload);
        }
        catch
        {
            // Ignore a web view that is being torn down.
        }
    }

    private void ShowAbout()
    {
        var zh = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "zh";
        var version = ReadAppLayerVersion();
        var text = zh
            ? $"DSH Automation Suite\n版本 {version}\n\nDeepSeek Harness 插件发行版（非官方）。\n使用 DeepSeek Harness 桌面运行时。"
            : $"DSH Automation Suite\nVersion {version}\n\nAn unofficial DeepSeek Harness plugin distribution.\nRuns on the DeepSeek Harness desktop runtime.";
        MessageBox.Show(this, text, "DSH Automation Suite", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private string ReadAppLayerVersion()
    {
        try
        {
            var manifest = Path.Combine(_appDir, "app-manifest.json");
            using var document = JsonDocument.Parse(File.ReadAllText(manifest));
            return document.RootElement.TryGetProperty("appLayerVersion", out var version)
                ? version.GetString() ?? "unknown"
                : "unknown";
        }
        catch
        {
            return "unknown";
        }
    }

    private void SetLoading(string text)
    {
        if (IsDisposed) return;
        if (InvokeRequired)
        {
            BeginInvoke(new Action(() => SetLoading(text)));
            return;
        }
        _loading.Text = text;
    }

    private void HideLoading()
    {
        if (IsDisposed) return;
        if (InvokeRequired)
        {
            BeginInvoke(new Action(HideLoading));
            return;
        }
        _loading.Visible = false;
        _webView.Focus();
    }

    private void ShowLoadError(string text)
    {
        if (IsDisposed) return;
        if (InvokeRequired)
        {
            BeginInvoke(new Action(() => ShowLoadError(text)));
            return;
        }
        _loading.Text = text;
        _loading.Visible = true;
        _loading.BringToFront();
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

            using var dialog = new Form
            {
                Text = "DSH Automation Suite — Doctor",
                Width = 900,
                Height = 600,
                StartPosition = FormStartPosition.CenterParent,
                Icon = Icon,
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
            _loading.Dispose();
        }
        base.Dispose(disposing);
    }
}
