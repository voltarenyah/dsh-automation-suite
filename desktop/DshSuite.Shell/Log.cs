using System.Text;
using System.Text.RegularExpressions;

namespace DshSuite.Shell;

/// <summary>Rotating-free, append-only shell log. Tokens are redacted before writing.</summary>
internal sealed class Log
{
    private static readonly Regex TokenPattern = new(@"token=[^&\s]+", RegexOptions.Compiled);
    private readonly object _gate = new();

    public Log(string directory)
    {
        DirectoryPath = directory;
        Directory.CreateDirectory(directory);
        FilePath = Path.Combine(directory, $"shell-{DateTime.Now:yyyyMMdd}.log");
    }

    public string DirectoryPath { get; }

    public string FilePath { get; }

    public void Write(string source, string? line)
    {
        if (line is null) return;
        var safe = Redact(line);
        var text = $"{DateTime.Now:O} [{source}] {safe}{Environment.NewLine}";
        lock (_gate)
        {
            try
            {
                File.AppendAllText(FilePath, text, Encoding.UTF8);
            }
            catch
            {
                // Logging must never take down the shell.
            }
        }
    }

    public static string Redact(string text) => TokenPattern.Replace(text, "token=<redacted>");
}
