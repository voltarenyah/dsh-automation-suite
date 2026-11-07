using System.Diagnostics;
using System.Text.RegularExpressions;

namespace DshSuite.Shell;

/// <summary>Starts the DSH Web host and extracts its token URL. Owns the process tree.</summary>
internal sealed class DshHost : IDisposable
{
    private static readonly Regex UrlPattern = new(
        @"dsh web: (http://127\.0\.0\.1:(\d+)/\?token=\S+)",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private readonly Log _log;
    private readonly Queue<string> _stderrTail = new();
    private Process? _process;
    private JobObject? _job;
    private string? _url;

    public DshHost(Log log) => _log = log;

    public string? Url => _url;

    public bool IsRunning => _process is { HasExited: false };

    public async Task<string> StartAsync(string dshHome, string profile, TimeSpan timeout, CancellationToken cancellationToken)
    {
        if (IsRunning) return _url ?? throw new InvalidOperationException("DSH is already running without a URL");

        var launch = DshLocator.Resolve();
        var startInfo = new ProcessStartInfo
        {
            FileName = launch.Exe,
            WorkingDirectory = launch.WorkingDirectory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        startInfo.ArgumentList.Add("--expose-internals");
        startInfo.ArgumentList.Add(launch.CliPath);
        startInfo.ArgumentList.Add("--profile");
        startInfo.ArgumentList.Add(profile);
        startInfo.ArgumentList.Add("--port");
        startInfo.ArgumentList.Add("0");
        startInfo.ArgumentList.Add("--no-open");
        startInfo.Environment["ELECTRON_RUN_AS_NODE"] = "1";
        startInfo.Environment["DSH_HOME"] = dshHome;

        var completion = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, args) => OnLine(args.Data, completion, "stdout");
        process.ErrorDataReceived += (_, args) => OnLine(args.Data, completion, "stderr");
        process.Exited += (_, _) =>
        {
            if (!completion.Task.IsCompleted)
            {
                completion.TrySetException(new InvalidOperationException(
                    $"DSH exited before printing its URL (code={process.ExitCode}). {Tail()}"));
            }
        };

        _log.Write("dsh", $"starting {launch.Exe} --profile {profile} (DSH_HOME={dshHome})");
        process.Start();
        _process = process;

        try
        {
            _job = new JobObject();
            if (!_job.Assign(process))
            {
                _log.Write("dsh", "could not assign DSH to a job object; falling back to Kill(entireProcessTree)");
            }
        }
        catch (Exception error)
        {
            _log.Write("dsh", $"job object unavailable: {error.Message}");
            _job?.Dispose();
            _job = null;
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(timeout);
        var timeoutTask = Task.Delay(Timeout.InfiniteTimeSpan, timeoutSource.Token);
        var completed = await Task.WhenAny(completion.Task, timeoutTask).ConfigureAwait(false);
        if (completed != completion.Task)
        {
            Stop();
            cancellationToken.ThrowIfCancellationRequested();
            throw new TimeoutException($"DSH did not print its URL within {timeout.TotalSeconds:0} s. {Tail()}");
        }

        _url = await completion.Task.ConfigureAwait(false);
        _log.Write("dsh", $"ready at {Log.Redact(_url)}");
        return _url;
    }

    public void Stop()
    {
        var process = _process;
        _process = null;
        _url = null;

        if (process is not null)
        {
            try
            {
                if (!process.HasExited)
                {
                    _log.Write("dsh", "stopping process tree");
                    process.Kill(entireProcessTree: true);
                    process.WaitForExit(5000);
                }
            }
            catch (Exception error)
            {
                _log.Write("dsh", $"stop failed: {error.Message}");
            }
            finally
            {
                process.Dispose();
            }
        }

        _job?.Dispose();
        _job = null;
    }

    public void Dispose() => Stop();

    private void OnLine(string? line, TaskCompletionSource<string> completion, string source)
    {
        if (line is null) return;
        _log.Write(source, line);

        if (source == "stderr")
        {
            lock (_stderrTail)
            {
                _stderrTail.Enqueue(Log.Redact(line));
                while (_stderrTail.Count > 20) _stderrTail.Dequeue();
            }
        }

        var match = UrlPattern.Match(line);
        if (match.Success)
        {
            _url = match.Groups[1].Value;
            completion.TrySetResult(_url);
        }
    }

    private string Tail()
    {
        lock (_stderrTail)
        {
            return string.Join(" | ", _stderrTail);
        }
    }
}
