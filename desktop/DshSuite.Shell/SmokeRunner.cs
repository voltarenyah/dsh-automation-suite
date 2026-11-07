using System.Diagnostics;
using System.Drawing;
using System.Text.Json;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DshSuite.Shell;

/// <summary>
/// Headless-ish smoke test: start DSH, load the token URL in a hidden WebView2,
/// wait for NavigationCompleted, write smoke-result.json, then stop DSH and exit.
/// Used by the build script and CI; it never shows a window to the user.
/// </summary>
internal static class SmokeRunner
{
    public static int Run(string appDir, string dshHome, string profile, Log log)
    {
        using var form = new SmokeForm(appDir, dshHome, profile, log);
        Application.Run(form);
        return form.ExitCode;
    }

    private sealed class SmokeForm : Form
    {
        private readonly string _appDir;
        private readonly string _dshHome;
        private readonly string _profile;
        private readonly Log _log;
        private readonly DshHost _host;
        private readonly WebView2 _webView = new() { Dock = DockStyle.Fill };

        public SmokeForm(string appDir, string dshHome, string profile, Log log)
        {
            _appDir = appDir;
            _dshHome = dshHome;
            _profile = profile;
            _log = log;
            _host = new DshHost(log);

            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(-10000, -10000);
            Size = new Size(1000, 700);
            Opacity = 0;
            Controls.Add(_webView);
            Shown += async (_, _) => await RunAsync();
        }

        public int ExitCode { get; private set; } = 1;

        private async Task RunAsync()
        {
            var watch = Stopwatch.StartNew();
            var resultPath = Path.Combine(_dshHome, "smoke-result.json");
            try
            {
                AppPaths.EnsureProfile(_appDir, _dshHome, _profile, _log);
                var url = await _host.StartAsync(_dshHome, _profile, TimeSpan.FromSeconds(120), CancellationToken.None);

                var userData = Path.Combine(_dshHome, "webview2");
                Directory.CreateDirectory(userData);
                var environment = await CoreWebView2Environment.CreateAsync(null, userData);
                await _webView.EnsureCoreWebView2Async(environment);

                var navigation = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                _webView.CoreWebView2.NavigationCompleted += (_, args) => navigation.TrySetResult(args.IsSuccess);
                _webView.Source = new Uri(url);

                var completed = await Task.WhenAny(navigation.Task, Task.Delay(TimeSpan.FromSeconds(45)));
                if (completed != navigation.Task)
                {
                    throw new TimeoutException("WebView2 did not finish navigating to the DSH UI within 45 s");
                }
                var success = await navigation.Task;
                WriteResult(resultPath, new
                {
                    ok = success,
                    url = Log.Redact(url),
                    elapsedMs = watch.ElapsedMilliseconds,
                    navigation = success ? "completed" : "failed",
                });
                ExitCode = success ? 0 : 1;
            }
            catch (Exception error)
            {
                _log.Write("smoke", error.ToString());
                WriteResult(resultPath, new
                {
                    ok = false,
                    error = error.Message,
                    elapsedMs = watch.ElapsedMilliseconds,
                });
                ExitCode = 1;
            }
            finally
            {
                _host.Stop();
                Close();
            }
        }

        private void WriteResult(string path, object value)
        {
            try
            {
                File.WriteAllText(path, JsonSerializer.Serialize(value, new JsonSerializerOptions { WriteIndented = true }));
            }
            catch (Exception error)
            {
                _log.Write("smoke", $"could not write {path}: {error.Message}");
            }
        }
    }
}
