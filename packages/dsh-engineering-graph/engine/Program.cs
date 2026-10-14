// Entry point for the dsh-engineering-graph engine.
//
// The engine does not expose any operation yet: the stdio JSON protocol that the
// TypeScript half will drive is a later step, and until it exists this plugin
// deliberately registers no tool (see docs/decisions.md D16/D17).
//
// What does exist is `--self-test`, which exercises the paths that a successful
// compilation cannot vouch for: loading the native SQLite provider, writing the
// property graph, reading it back, and — when an export root is given — crawling
// a real export tree through the vendored parser.
namespace EngineeringGraph.Engine;

internal static class Program
{
    private static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] is "--version" or "-v")
        {
            Console.WriteLine(BuildInfo.Name);
            return 0;
        }

        if (args.Length > 0 && args[0] == "--self-test")
        {
            return SelfTest.Run(args.Length > 1 ? args[1] : null);
        }

        Console.WriteLine($"{BuildInfo.Name}: no operation protocol yet (a later step).");
        Console.WriteLine("Run with --self-test [exportRoot] to exercise the vendored engine.");
        return 0;
    }
}

internal static class BuildInfo
{
    /// <summary>The engine's identity; also the executable's base name.</summary>
    internal const string Name = "EngineeringGraph.Engine";
}
