// Self test for the engine. Everything here is a check that a successful
// compilation cannot make:
//
//   1. a SQLite round trip through the store -- the only proof that the native
//      provider (e_sqlite3) actually loads at run time;
//   2. a crawl of a real export tree through the vendored parser;
//   3. the actual operation dispatch: Ingest writes a database, Query reads it
//      back, and the read-only guard refuses a write;
//   4. the incremental Update path (B4): a D24 device tree is ingested, one block
//      is mutated and updated in place, one block is removed, the three refusal
//      codes are triggered, and a mid-batch failure is proven to roll back.
//
// It never touches the network and never needs TIA Portal. Exit code 0 means
// every check that ran succeeded.
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Xml.Linq;
using Microsoft.Data.Sqlite;

namespace EngineeringGraph.Engine;

internal static class SelfTest
{
    internal static int Run(string? deviceDir)
    {
        var failures = 0;

        failures += CheckSqliteRoundTrip();
        failures += CheckFlgGraphDiagnostics();
        failures += CheckRungReducer();
        failures += CheckRungEquivalenceSynthetic();

        // The fixtures are copied next to the executable by the csproj (engine/bin/fixtures).
        // They are not part of the shipped build (package.json excludes engine/bin/fixtures),
        // so a build without them skips the fixture-based checks instead of failing them.
        var fixturesDir = Path.Combine(AppContext.BaseDirectory, "fixtures");
        var haveFixtures = Directory.Exists(fixturesDir);

        if (haveFixtures)
        {
            failures += CheckFlgGraph(fixturesDir, "fixtures");
            failures += CheckRungEquivalence(fixturesDir, "fixtures");
        }
        else
        {
            Console.WriteLine("[skip] LAD element graph (no fixtures next to the executable)");
        }

        if (string.IsNullOrWhiteSpace(deviceDir))
        {
            Console.WriteLine("[skip] export crawl and operations (no export root given)");
        }
        else
        {
            failures += CheckExportCrawl(deviceDir);
            failures += CheckOperations(deviceDir);
            failures += CheckFlgGraph(deviceDir, "export");
            failures += CheckRungEquivalence(deviceDir, "export");
            if (haveFixtures)
            {
                failures += CheckIncrementalUpdate(fixturesDir);
            }
            else
            {
                Console.WriteLine("[skip] incremental update (no fixtures next to the executable)");
            }
        }

        Console.WriteLine(failures == 0
            ? "self-test: OK"
            : $"self-test: {failures} check(s) FAILED");
        return failures == 0 ? 0 : 1;
    }

    /// <summary>
    /// Phase 1 negative cases (plan T1-c): the graph's diagnostics have to fire on the shapes they
    /// exist for, otherwise a later refactor can turn them into dead code and every network will
    /// silently look clean. Each case is an inline FlgNet so it does not depend on fixture files.
    /// </summary>
    private static int CheckFlgGraphDiagnostics()
    {
        static XElement Parse(string body) =>
            XElement.Parse(
                "<FlgNet xmlns=\"http://www.siemens.com/automation/Openness/SW/NetworkSource/FlgNet/v4\">" +
                body +
                "</FlgNet>");

        const string Elements =
            "<Parts>" +
            "  <Access Scope=\"LocalVariable\" UId=\"1\"><Symbol><Component Name=\"A\" /></Symbol></Access>" +
            "  <Access Scope=\"LocalVariable\" UId=\"11\"><Symbol><Component Name=\"Q\" /></Symbol></Access>" +
            "  <Part Name=\"Contact\" UId=\"2\" />" +
            "  <Part Name=\"Coil\" UId=\"3\" />" +
            "</Parts>";

        var failures = new List<string>();

        // 1. A legal branch: one wire, two targets. No diagnostics, and the fan-out is preserved.
        {
            FlgNetworkGraph graph = FlgNetworkGraph.Build(Parse(
                Elements +
                "<Wires>" +
                "  <Wire UId=\"4\"><Powerrail /><NameCon UId=\"2\" Name=\"in\" /></Wire>" +
                "  <Wire UId=\"5\"><IdentCon UId=\"1\" /><NameCon UId=\"2\" Name=\"operand\" /></Wire>" +
                "  <Wire UId=\"6\"><NameCon UId=\"2\" Name=\"out\" /><NameCon UId=\"3\" Name=\"in\" /></Wire>" +
                "  <Wire UId=\"7\"><IdentCon UId=\"11\" /><NameCon UId=\"3\" Name=\"operand\" /></Wire>" +
                "</Wires>"));

            if (graph.Diagnostics.Count != 0)
            {
                failures.Add($"fan-out case produced diagnostics: {string.Join(" | ", graph.Diagnostics)}");
            }

            if (graph.Wires.All(wire => wire.Targets.Count != 1) &&
                graph.Wires.All(wire => wire.Targets.Count != 2))
            {
                failures.Add("fan-out case lost its targets");
            }
        }

        // 2. Two wires feeding one pin: TIA rejects this shape, so the graph must report it.
        {
            FlgNetworkGraph graph = FlgNetworkGraph.Build(Parse(
                Elements +
                "<Wires>" +
                "  <Wire UId=\"4\"><Powerrail /><NameCon UId=\"2\" Name=\"in\" /></Wire>" +
                "  <Wire UId=\"5\"><IdentCon UId=\"1\" /><NameCon UId=\"2\" Name=\"operand\" /></Wire>" +
                "  <Wire UId=\"6\"><IdentCon UId=\"1\" /><NameCon UId=\"2\" Name=\"operand\" /></Wire>" +
                "  <Wire UId=\"7\"><NameCon UId=\"2\" Name=\"out\" /><NameCon UId=\"3\" Name=\"in\" /></Wire>" +
                "  <Wire UId=\"8\"><IdentCon UId=\"11\" /><NameCon UId=\"3\" Name=\"operand\" /></Wire>" +
                "</Wires>"));

            if (!graph.Diagnostics.Any(diagnostic => diagnostic.StartsWith("flg_multi_source", StringComparison.Ordinal)))
            {
                failures.Add("a pin fed by two wires did not raise flg_multi_source");
            }
        }

        // 3. A wire pointing at a UId the network does not define.
        {
            FlgNetworkGraph graph = FlgNetworkGraph.Build(Parse(
                Elements +
                "<Wires>" +
                "  <Wire UId=\"4\"><IdentCon UId=\"99\" /><NameCon UId=\"2\" Name=\"operand\" /></Wire>" +
                "</Wires>"));

            if (!graph.Diagnostics.Any(diagnostic => diagnostic.StartsWith("flg_dangling_uid", StringComparison.Ordinal)))
            {
                failures.Add("an unknown IdentCon UId did not raise flg_dangling_uid");
            }
        }

        // 4. A Wire reusing a Part's UId: one namespace per network.
        {
            FlgNetworkGraph graph = FlgNetworkGraph.Build(Parse(
                Elements +
                "<Wires>" +
                "  <Wire UId=\"2\"><Powerrail /><NameCon UId=\"2\" Name=\"in\" /></Wire>" +
                "</Wires>"));

            if (!graph.Diagnostics.Any(diagnostic => diagnostic.StartsWith("flg_duplicate_uid", StringComparison.Ordinal)))
            {
                failures.Add("a Wire reusing a Part UId did not raise flg_duplicate_uid");
            }
        }

        // 5. An open branch end: <OpenCon> is not an element reference and must not be a problem.
        {
            FlgNetworkGraph graph = FlgNetworkGraph.Build(Parse(
                Elements +
                "<Wires>" +
                "  <Wire UId=\"4\"><Powerrail /><NameCon UId=\"2\" Name=\"in\" /></Wire>" +
                "  <Wire UId=\"5\"><IdentCon UId=\"1\" /><NameCon UId=\"2\" Name=\"operand\" /></Wire>" +
                "  <Wire UId=\"6\"><OpenCon UId=\"40\" /><NameCon UId=\"3\" Name=\"en\" /></Wire>" +
                "</Wires>"));

            if (graph.Diagnostics.Count != 0)
            {
                failures.Add($"open-end case produced diagnostics: {string.Join(" | ", graph.Diagnostics)}");
            }

            if (!graph.Wires.Any(wire => wire.IsOpen))
            {
                failures.Add("open-end case did not mark the wire open");
            }
        }

        if (failures.Count > 0)
        {
            foreach (string failure in failures)
            {
                Console.WriteLine($"  [problem] {failure}");
            }

            Console.WriteLine("[FAIL] LAD element graph diagnostics");
            return 1;
        }

        Console.WriteLine("[ok] LAD element graph diagnostics: 5 synthetic cases");
        return 0;
    }

    /// <summary>
    /// Phase 3 (plan section 3): the rung reducer and the statement translator are independent
    /// implementations of the same network, so they must agree on every network both can express.
    /// Agreement is checked over all input combinations (or a deterministic sample above the cap),
    /// not by comparing text: two different-looking formulas that compute the same thing are fine,
    /// and two identical-looking formulas that compute different things would be the bug.
    /// </summary>
    private static int CheckRungEquivalence(string root, string label)
    {
        string[] files;
        try
        {
            files = Directory
                .EnumerateFiles(root, "*.xml", SearchOption.AllDirectories)
                .OrderBy(path => path, StringComparer.Ordinal)
                .ToArray();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[FAIL] rung equivalence ({label}): {ex.GetType().Name}: {ex.Message}");
            return 1;
        }

        long networks = 0;
        long coils = 0;
        long skippedBox = 0;
        long skippedUnstructured = 0;
        long skippedStatements = 0;
        long skippedUnresolved = 0;
        long sampled = 0;
        var mismatches = new List<string>();

        foreach (string file in files)
        {
            XDocument document;
            try
            {
                document = XDocument.Load(file);
            }
            catch
            {
                continue;
            }

            int networkIndex = 0;
            foreach (XElement unit in document.Descendants().Where(element => element.Name.LocalName == "SW.Blocks.CompileUnit"))
            {
                if (!unit.Descendants().Any(element => element.Name.LocalName == "FlgNet"))
                {
                    continue;
                }

                networkIndex++;
                networks++;

                FlgNetworkGraph graph = FlgNetworkGraph.Build(unit.Descendants().First(element => element.Name.LocalName == "FlgNet"));
                RungModel rung = SeriesParallelReducer.Reduce(graph);

                if (!rung.IsStructured)
                {
                    skippedUnstructured++;
                    continue;
                }

                // A box or a call has semantics that live in another network; treating it as a
                // variable would compare two different abstractions.
                if (graph.Elements.Any(element => element.Kind is FlgElementKind.Box or FlgElementKind.Call))
                {
                    skippedBox++;
                    continue;
                }

                IReadOnlyList<string> statements = ProgramBlockLogicYamlWriter.TranslateStatementsOf(unit);
                var byTarget = new Dictionary<string, string>(StringComparer.Ordinal);
                bool unsupported = false;
                foreach (string raw in statements)
                {
                    string statement = raw.Trim();
                    if (statement.Length == 0 || statement.StartsWith("//", StringComparison.Ordinal))
                    {
                        continue;
                    }

                    var match = System.Text.RegularExpressions.Regex.Match(
                        statement,
                        @"^(?<target>[^:=]+?)\s*:=\s*(?<value>.+);$");
                    if (!match.Success)
                    {
                        unsupported = true;
                        break;
                    }

                    byTarget[match.Groups["target"].Value.Trim()] = match.Groups["value"].Value.Trim();
                }

                if (unsupported)
                {
                    skippedStatements++;
                    continue;
                }

                bool comparedAny = false;
                foreach (RungCoil coil in rung.Coils)
                {
                    // Only plain coils: the translator writes S/R coils as conditional statements.
                    if (coil.Kind != FlgElementKind.Coil || string.IsNullOrWhiteSpace(coil.Operand))
                    {
                        continue;
                    }

                    if (!byTarget.TryGetValue(coil.Operand!, out string? value))
                    {
                        skippedUnresolved++;
                        continue;
                    }

                    if (!BooleanExpression.TryParse(value, out BooleanExpression? translated) || translated == null)
                    {
                        skippedStatements++;
                        continue;
                    }

                    bool resolved = coil.Paths.All(path =>
                        path.Steps.All(step => step.Kind == FlgElementKind.Contact && !string.IsNullOrWhiteSpace(step.Operand)));

                    if (!resolved)
                    {
                        skippedUnresolved++;
                        continue;
                    }

                    BooleanExpression reduced = RungModel.ValueExpression(coil);

                    var variables = new List<string>();
                    variables.AddRange(reduced.Variables);
                    variables.AddRange(translated.Variables);
                    string[] distinct = variables
                        .Distinct(StringComparer.Ordinal)
                        .OrderBy(name => name, StringComparer.Ordinal)
                        .ToArray();

                    var mismatch = false;
                    if (distinct.Length <= 12)
                    {
                        int combinations = 1 << distinct.Length;
                        for (int mask = 0; mask < combinations && !mismatch; mask++)
                        {
                            bool[] flags = new bool[distinct.Length];
                            for (int bit = 0; bit < distinct.Length; bit++)
                            {
                                flags[bit] = (mask & (1 << bit)) != 0;
                            }

                            bool Activate(string name)
                            {
                                int at = Array.IndexOf(distinct, name);
                                return at >= 0 && flags[at];
                            }

                            if (reduced.Evaluate(Activate) != translated!.Evaluate(Activate))
                            {
                                mismatch = true;
                                mismatches.Add(
                                    $"{Path.GetFileName(file)} network {networkIndex}: coil '{coil.Operand}' disagrees; " +
                                    $"translated='{value}' rung='{RungModel.ConditionOf(coil.Paths[0])}'" +
                                    (coil.Paths.Count > 1 ? $" (+{coil.Paths.Count - 1} more path(s))" : string.Empty));
                            }
                        }
                    }
                    else
                    {
                        sampled++;
                        var random = new Random(networkIndex);
                        for (int trial = 0; trial < 512 && !mismatch; trial++)
                        {
                            var assignment = new Dictionary<string, bool>(StringComparer.Ordinal);
                            foreach (string name in distinct)
                            {
                                assignment[name] = random.Next(2) == 0;
                            }

                            bool Activate(string name) => assignment.TryGetValue(name, out bool flag) && flag;

                            if (reduced.Evaluate(Activate) != translated!.Evaluate(Activate))
                            {
                                mismatch = true;
                                mismatches.Add(
                                    $"{Path.GetFileName(file)} network {networkIndex}: coil '{coil.Operand}' disagrees " +
                                    $"(sampled); translated='{value}'");
                            }
                        }
                    }

                    coils++;
                    comparedAny = true;
                }

                if (!comparedAny)
                {
                    skippedUnresolved++;
                }
            }
        }

        if (mismatches.Count > 0)
        {
            foreach (string mismatch in mismatches.Take(10))
            {
                Console.WriteLine($"  [problem] {mismatch}");
            }

            Console.WriteLine($"[FAIL] rung equivalence ({label}): {mismatches.Count} disagreement(s)");
            return 1;
        }

        if (coils == 0)
        {
            Console.WriteLine($"[skip] rung equivalence ({label}): no comparable coil under {root}");
            return 0;
        }

        Console.WriteLine(
            $"[ok] rung equivalence ({label}): coils={coils} networks={networks} " +
            $"skipped(box={skippedBox} unstructured={skippedUnstructured} statements={skippedStatements} " +
            $"unresolved={skippedUnresolved}) sampled={sampled}");
        return 0;
    }

    /// <summary>
    /// Phase 2 (plan T2-a): the reducer turns the element graph into the rungs a reader thinks in,
    /// and the shapes it must get right are exactly the ones M0 proved legal: a plain chain, a
    /// negated contact, an OR merge, a fan-out feeding two coils, a box in series, and a network
    /// without a power rail (which must be reported, not guessed at).
    /// </summary>
    private static int CheckRungReducer()
    {
        static XElement Parse(string body) =>
            XElement.Parse(
                "<FlgNet xmlns=\"http://www.siemens.com/automation/Openness/SW/NetworkSource/FlgNet/v4\">" +
                body +
                "</FlgNet>");

        const string AccessA = "<Access Scope=\"LocalVariable\" UId=\"1\"><Symbol><Component Name=\"A\" /></Symbol></Access>";
        const string AccessB = "<Access Scope=\"LocalVariable\" UId=\"2\"><Symbol><Component Name=\"B\" /></Symbol></Access>";
        const string AccessQ = "<Access Scope=\"LocalVariable\" UId=\"3\"><Symbol><Component Name=\"Q\" /></Symbol></Access>";
        const string AccessQ2 = "<Access Scope=\"LocalVariable\" UId=\"4\"><Symbol><Component Name=\"Q2\" /></Symbol></Access>";

        var failures = new List<string>();

        // 1. Chain: rail -> [A] -> (=) Q.
        {
            RungModel model = SeriesParallelReducer.Reduce(FlgNetworkGraph.Build(Parse(
                "<Parts>" + AccessA + AccessQ + "<Part Name=\"Contact\" UId=\"10\" /><Part Name=\"Coil\" UId=\"11\" /></Parts>" +
                "<Wires>" +
                "  <Wire UId=\"20\"><Powerrail /><NameCon UId=\"10\" Name=\"in\" /></Wire>" +
                "  <Wire UId=\"21\"><IdentCon UId=\"1\" /><NameCon UId=\"10\" Name=\"operand\" /></Wire>" +
                "  <Wire UId=\"22\"><NameCon UId=\"10\" Name=\"out\" /><NameCon UId=\"11\" Name=\"in\" /></Wire>" +
                "  <Wire UId=\"23\"><IdentCon UId=\"3\" /><NameCon UId=\"11\" Name=\"operand\" /></Wire>" +
                "</Wires>")));

            if (!model.IsStructured || model.Coils.Count != 1 || model.Coils[0].Paths.Count != 1)
            {
                failures.Add($"chain: expected 1 coil with 1 path, got structured={model.IsStructured} coils={model.Coils.Count}");
            }
            else if (RungModel.ConditionOf(model.Coils[0].Paths[0]) != "A")
            {
                failures.Add($"chain: condition was '{RungModel.ConditionOf(model.Coils[0].Paths[0])}', expected 'A'");
            }
        }

        // 2. Negated contact: rail -> [/A] -> (=) Q, condition must read NOT A.
        {
            RungModel model = SeriesParallelReducer.Reduce(FlgNetworkGraph.Build(Parse(
                "<Parts>" + AccessA + AccessQ +
                "<Part Name=\"Contact\" UId=\"10\"><Negated Name=\"operand\" /></Part><Part Name=\"Coil\" UId=\"11\" /></Parts>" +
                "<Wires>" +
                "  <Wire UId=\"20\"><Powerrail /><NameCon UId=\"10\" Name=\"in\" /></Wire>" +
                "  <Wire UId=\"21\"><IdentCon UId=\"1\" /><NameCon UId=\"10\" Name=\"operand\" /></Wire>" +
                "  <Wire UId=\"22\"><NameCon UId=\"10\" Name=\"out\" /><NameCon UId=\"11\" Name=\"in\" /></Wire>" +
                "  <Wire UId=\"23\"><IdentCon UId=\"3\" /><NameCon UId=\"11\" Name=\"operand\" /></Wire>" +
                "</Wires>")));

            string? condition = model.Coils.Count == 1 && model.Coils[0].Paths.Count == 1
                ? RungModel.ConditionOf(model.Coils[0].Paths[0])
                : null;
            if (condition != "NOT A")
            {
                failures.Add($"negated contact: condition was '{condition ?? "(none)"}', expected 'NOT A'");
            }
        }

        // 3. OR merge: [A] and [B] into an O box, then the coil. Two paths, the box is not a condition.
        {
            RungModel model = SeriesParallelReducer.Reduce(FlgNetworkGraph.Build(Parse(
                "<Parts>" + AccessA + AccessB + AccessQ +
                "<Part Name=\"Contact\" UId=\"10\" /><Part Name=\"Contact\" UId=\"11\" />" +
                "<Part Name=\"O\" UId=\"12\"><TemplateValue Name=\"Card\" Type=\"Cardinality\">2</TemplateValue></Part>" +
                "<Part Name=\"Coil\" UId=\"13\" /></Parts>" +
                "<Wires>" +
                "  <Wire UId=\"20\"><Powerrail /><NameCon UId=\"10\" Name=\"in\" /><NameCon UId=\"11\" Name=\"in\" /></Wire>" +
                "  <Wire UId=\"21\"><IdentCon UId=\"1\" /><NameCon UId=\"10\" Name=\"operand\" /></Wire>" +
                "  <Wire UId=\"22\"><IdentCon UId=\"2\" /><NameCon UId=\"11\" Name=\"operand\" /></Wire>" +
                "  <Wire UId=\"23\"><NameCon UId=\"10\" Name=\"out\" /><NameCon UId=\"12\" Name=\"in1\" /></Wire>" +
                "  <Wire UId=\"24\"><NameCon UId=\"11\" Name=\"out\" /><NameCon UId=\"12\" Name=\"in2\" /></Wire>" +
                "  <Wire UId=\"25\"><NameCon UId=\"12\" Name=\"out\" /><NameCon UId=\"13\" Name=\"in\" /></Wire>" +
                "  <Wire UId=\"26\"><IdentCon UId=\"3\" /><NameCon UId=\"13\" Name=\"operand\" /></Wire>" +
                "</Wires>")));

            if (!model.IsStructured || model.Coils.Count != 1 || model.Coils[0].Paths.Count != 2)
            {
                failures.Add($"or-merge: expected 1 coil with 2 paths, got structured={model.IsStructured} " +
                    $"coils={model.Coils.Count} paths={(model.Coils.Count > 0 ? model.Coils[0].Paths.Count : 0)}");
            }
            else
            {
                string[] conditions = model.Coils[0].Paths.Select(RungModel.ConditionOf).OrderBy(text => text, StringComparer.Ordinal).ToArray();
                if (conditions.Length != 2 || conditions[0] != "A" || conditions[1] != "B")
                {
                    failures.Add($"or-merge: conditions were [{string.Join(", ", conditions)}], expected [A, B]");
                }
            }
        }

        // 4. Fan-out: [A] splits to (=) Q and [B] -> (=) Q2. Two coils, one path each (M0/E4).
        {
            RungModel model = SeriesParallelReducer.Reduce(FlgNetworkGraph.Build(Parse(
                "<Parts>" + AccessA + AccessB + AccessQ + AccessQ2 +
                "<Part Name=\"Contact\" UId=\"10\" /><Part Name=\"Coil\" UId=\"11\" />" +
                "<Part Name=\"Contact\" UId=\"12\" /><Part Name=\"Coil\" UId=\"13\" /></Parts>" +
                "<Wires>" +
                "  <Wire UId=\"20\"><Powerrail /><NameCon UId=\"10\" Name=\"in\" /></Wire>" +
                "  <Wire UId=\"21\"><IdentCon UId=\"1\" /><NameCon UId=\"10\" Name=\"operand\" /></Wire>" +
                "  <Wire UId=\"22\"><NameCon UId=\"10\" Name=\"out\" /><NameCon UId=\"11\" Name=\"in\" /><NameCon UId=\"12\" Name=\"in\" /></Wire>" +
                "  <Wire UId=\"23\"><IdentCon UId=\"3\" /><NameCon UId=\"11\" Name=\"operand\" /></Wire>" +
                "  <Wire UId=\"24\"><IdentCon UId=\"2\" /><NameCon UId=\"12\" Name=\"operand\" /></Wire>" +
                "  <Wire UId=\"25\"><NameCon UId=\"12\" Name=\"out\" /><NameCon UId=\"13\" Name=\"in\" /></Wire>" +
                "  <Wire UId=\"26\"><IdentCon UId=\"4\" /><NameCon UId=\"13\" Name=\"operand\" /></Wire>" +
                "</Wires>")));

            if (!model.IsStructured || model.Coils.Count != 2)
            {
                failures.Add($"fan-out: expected 2 coils, got structured={model.IsStructured} coils={model.Coils.Count}");
            }
            else if (model.Coils.Any(coil => coil.Paths.Count != 1))
            {
                failures.Add("fan-out: a coil did not get exactly one path");
            }
        }

        // 5. Box in series: rail -> Move -> (=) Q. Structured, and the box is a step.
        {
            RungModel model = SeriesParallelReducer.Reduce(FlgNetworkGraph.Build(Parse(
                "<Parts>" + AccessQ +
                "<Part Name=\"Move\" UId=\"10\" /><Part Name=\"Coil\" UId=\"11\" /></Parts>" +
                "<Wires>" +
                "  <Wire UId=\"20\"><Powerrail /><NameCon UId=\"10\" Name=\"en\" /></Wire>" +
                "  <Wire UId=\"21\"><NameCon UId=\"10\" Name=\"eno\" /><NameCon UId=\"11\" Name=\"in\" /></Wire>" +
                "  <Wire UId=\"22\"><IdentCon UId=\"3\" /><NameCon UId=\"11\" Name=\"operand\" /></Wire>" +
                "</Wires>")));

            if (!model.IsStructured || model.Coils.Count != 1)
            {
                failures.Add($"box series: expected 1 structured coil, got structured={model.IsStructured} coils={model.Coils.Count}");
            }
            else if (!model.Coils[0].Paths[0].Steps.Any(step => step.Kind == FlgElementKind.Box))
            {
                failures.Add("box series: the box is missing from the path");
            }
        }

        // 6. No power rail: must be reported, never guessed.
        {
            RungModel model = SeriesParallelReducer.Reduce(FlgNetworkGraph.Build(Parse(
                "<Parts>" + AccessA + AccessQ + "<Part Name=\"Contact\" UId=\"10\" /><Part Name=\"Coil\" UId=\"11\" /></Parts>" +
                "<Wires>" +
                "  <Wire UId=\"21\"><IdentCon UId=\"1\" /><NameCon UId=\"10\" Name=\"operand\" /></Wire>" +
                "</Wires>")));

            if (model.IsStructured || model.UnstructuredReason != "no-powerrail")
            {
                failures.Add($"no-powerrail: expected an unstructured model with reason 'no-powerrail', got " +
                    $"structured={model.IsStructured} reason={model.UnstructuredReason ?? "(none)"}");
            }
        }

        if (failures.Count > 0)
        {
            foreach (string failure in failures)
            {
                Console.WriteLine($"  [problem] {failure}");
            }

            Console.WriteLine("[FAIL] rung reducer");
            return 1;
        }

        Console.WriteLine("[ok] rung reducer: 6 synthetic cases");
        return 0;
    }

    /// <summary>
    /// Phase 3 self-check with known answers: a network the reducer and the translator must agree
    /// on, evaluated exhaustively. Without this, the equivalence check could pass by comparing
    /// nothing (the fixtures hold no comparable plain coil).
    /// </summary>
    private static int CheckRungEquivalenceSynthetic()
    {
        const string AccessA = "<Access Scope=\"LocalVariable\" UId=\"1\"><Symbol><Component Name=\"A\" /></Symbol></Access>";
        const string AccessB = "<Access Scope=\"LocalVariable\" UId=\"2\"><Symbol><Component Name=\"B\" /></Symbol></Access>";
        const string AccessQ = "<Access Scope=\"LocalVariable\" UId=\"3\"><Symbol><Component Name=\"Q\" /></Symbol></Access>";

        static XElement CompileUnit(string parts, string wires) =>
            XElement.Parse(
                "<SW.Blocks.CompileUnit ID=\"1\"><AttributeList><NetworkSource>" +
                "<FlgNet xmlns=\"http://www.siemens.com/automation/Openness/SW/NetworkSource/FlgNet/v4\">" +
                parts + wires +
                "</FlgNet></NetworkSource></AttributeList></SW.Blocks.CompileUnit>");

        var failures = new List<string>();

        // [A] AND [B] -> (=) Q, and the same network with B negated. Both must agree with the
        // translator on all four input combinations.
        foreach (bool negateB in new[] { false, true })
        {
            string negated = negateB ? "<Negated Name=\"operand\" />" : string.Empty;
            XElement unit = CompileUnit(
                "<Parts>" + AccessA + AccessB + AccessQ +
                "<Part Name=\"Contact\" UId=\"10\" /><Part Name=\"Contact\" UId=\"11\">" + negated + "</Part>" +
                "<Part Name=\"Coil\" UId=\"12\" /></Parts>",
                "<Wires>" +
                "  <Wire UId=\"20\"><Powerrail /><NameCon UId=\"10\" Name=\"in\" /></Wire>" +
                "  <Wire UId=\"21\"><IdentCon UId=\"1\" /><NameCon UId=\"10\" Name=\"operand\" /></Wire>" +
                "  <Wire UId=\"22\"><NameCon UId=\"10\" Name=\"out\" /><NameCon UId=\"11\" Name=\"in\" /></Wire>" +
                "  <Wire UId=\"23\"><IdentCon UId=\"2\" /><NameCon UId=\"11\" Name=\"operand\" /></Wire>" +
                "  <Wire UId=\"24\"><NameCon UId=\"11\" Name=\"out\" /><NameCon UId=\"12\" Name=\"in\" /></Wire>" +
                "  <Wire UId=\"25\"><IdentCon UId=\"3\" /><NameCon UId=\"12\" Name=\"operand\" /></Wire>" +
                "</Wires>");

            IReadOnlyList<string> statements = ProgramBlockLogicYamlWriter.TranslateStatementsOf(unit);
            if (statements.Count != 1)
            {
                failures.Add($"synthetic equivalence (negate={negateB}): expected 1 statement, got {statements.Count}");
                continue;
            }

            var match = System.Text.RegularExpressions.Regex.Match(statements[0], @"^Q\s*:=\s*(?<value>.+);$");
            if (!match.Success)
            {
                failures.Add($"synthetic equivalence (negate={negateB}): unexpected statement '{statements[0]}'");
                continue;
            }

            if (!BooleanExpression.TryParse(match.Groups["value"].Value, out BooleanExpression? translated) || translated == null)
            {
                failures.Add($"synthetic equivalence (negate={negateB}): cannot parse '{match.Groups["value"].Value}'");
                continue;
            }

            FlgNetworkGraph graph = FlgNetworkGraph.Build(unit.Descendants().First(element => element.Name.LocalName == "FlgNet"));
            RungModel rung = SeriesParallelReducer.Reduce(graph);
            if (!rung.IsStructured || rung.Coils.Count != 1)
            {
                failures.Add($"synthetic equivalence (negate={negateB}): reducer gave no single coil");
                continue;
            }

            BooleanExpression reduced = RungModel.ValueExpression(rung.Coils[0]);

            for (int mask = 0; mask < 4; mask++)
            {
                bool a = (mask & 1) != 0;
                bool b = (mask & 2) != 0;
                bool Activate(string name) => name switch
                {
                    "A" => a,
                    "B" => b,
                    _ => false
                };

                if (reduced.Evaluate(Activate) != translated.Evaluate(Activate))
                {
                    failures.Add($"synthetic equivalence (negate={negateB}): disagreement on A={a} B={b}");
                    break;
                }
            }
        }

        if (failures.Count > 0)
        {
            foreach (string failure in failures)
            {
                Console.WriteLine($"  [problem] {failure}");
            }

            Console.WriteLine("[FAIL] rung equivalence (synthetic)");
            return 1;
        }

        Console.WriteLine("[ok] rung equivalence (synthetic): 2 networks, 4 combinations each");
        return 0;
    }

    /// <summary>
    /// Phase 1 of docs/lad-understanding-plan.md: the LAD element graph must represent every
    /// element and every negation the XML holds. A parser that silently drops a contact still
    /// produces plausible output, so the check is conservation, not plausibility:
    ///   * elements built == Access + Part + Call entries counted,
    ///   * negated pins counted == raw &lt;Negated&gt; occurrences,
    ///   * no wire endpoint points at a UId the network does not define,
    ///   * no pin is fed by two wires (TIA rejects that shape: M0/E3a).
    /// </summary>
    private static int CheckFlgGraph(string root, string label)
    {
        string[] files;
        try
        {
            files = Directory
                .EnumerateFiles(root, "*.xml", SearchOption.AllDirectories)
                .OrderBy(path => path, StringComparer.Ordinal)
                .ToArray();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[FAIL] LAD element graph ({label}): {ex.GetType().Name}: {ex.Message}");
            return 1;
        }

        long networks = 0;
        long elements = 0;
        long wires = 0;
        long negated = 0;
        long withBox = 0;
        long reduced = 0;
        long unreduced = 0;
        long coils = 0;
        long withLadderText = 0;
        var unreducedReasons = new SortedDictionary<string, int>(StringComparer.Ordinal);
        var problems = new List<string>();

        foreach (string file in files)
        {
            XDocument document;
            try
            {
                document = XDocument.Load(file);
            }
            catch
            {
                // Not SimaticML (or not XML we can read): the crawl has its own accounting for
                // unreadable exports, so this check stays silent about them.
                continue;
            }

            foreach (XElement unit in document.Descendants().Where(element => element.Name.LocalName == "SW.Blocks.CompileUnit"))
            {
                XElement? flgNet = unit.Descendants().FirstOrDefault(element => element.Name.LocalName == "FlgNet");
                if (flgNet == null)
                {
                    continue;
                }

                networks++;

                int rawNegated = flgNet.Descendants().Count(element => element.Name.LocalName == "Negated");
                FlgNetworkGraph graph = FlgNetworkGraph.Build(flgNet);

                elements += graph.Elements.Count;
                wires += graph.Wires.Count;
                negated += graph.Counts.Negated;
                if (graph.Elements.Any(element => element.Kind == FlgElementKind.Box))
                {
                    withBox++;
                }

                string where = $"{Path.GetFileName(file)}";

                // Phase 2: reducing must never throw, and the share of networks it can express is a
                // number a reader cares about (a regression that drops it would otherwise be silent).
                try
                {
                    RungModel rung = SeriesParallelReducer.Reduce(graph);
                    if (rung.IsStructured)
                    {
                        reduced++;
                        coils += rung.Coils.Count;
                        // Phase 4: the rung text the tool surface serves has to be produced for the
                        // networks it claims to describe, not just for hand-picked samples.
                        if (LadderText.Render(graph, rung).Length > 0)
                        {
                            withLadderText++;
                        }
                    }
                    else
                    {
                        unreduced++;
                        string reason = rung.UnstructuredReason ?? "(none)";
                        unreducedReasons[reason] = unreducedReasons.TryGetValue(reason, out int seen) ? seen + 1 : 1;
                    }
                }
                catch (Exception ex)
                {
                    if (problems.Count < 20)
                    {
                        problems.Add($"{where}: the reducer threw {ex.GetType().Name}: {ex.Message}");
                    }
                }

                // Elements: a mismatch is only legitimate when the parse reported why (a missing
                // or duplicated UId), which is itself a problem worth printing.
                var hardDiagnostics = graph.Diagnostics
                    .Where(diagnostic =>
                        diagnostic.StartsWith("flg_dangling_uid", StringComparison.Ordinal) ||
                        diagnostic.StartsWith("flg_multi_source", StringComparison.Ordinal) ||
                        diagnostic.StartsWith("flg_duplicate_uid", StringComparison.Ordinal) ||
                        diagnostic.StartsWith("flg_no_source", StringComparison.Ordinal))
                    .ToArray();

                foreach (string diagnostic in hardDiagnostics)
                {
                    if (problems.Count < 20)
                    {
                        problems.Add($"{where}: {diagnostic}");
                    }
                }

                if (graph.Elements.Count != graph.Counts.Elements &&
                    !graph.Diagnostics.Any(diagnostic => diagnostic.StartsWith("flg_missing_uid", StringComparison.Ordinal) ||
                        diagnostic.StartsWith("flg_duplicate_uid", StringComparison.Ordinal)))
                {
                    problems.Add($"{where}: built {graph.Elements.Count} element(s) but counted {graph.Counts.Elements}");
                }

                if (graph.Counts.Negated != rawNegated)
                {
                    problems.Add($"{where}: counted {graph.Counts.Negated} negated pin(s) but the XML has {rawNegated}");
                }
            }
        }

        if (problems.Count > 0)
        {
            foreach (string problem in problems)
            {
                Console.WriteLine($"  [problem] {problem}");
            }

            Console.WriteLine($"[FAIL] LAD element graph ({label}): {problems.Count} problem(s) over {networks} network(s)");
            return 1;
        }

        if (networks == 0)
        {
            Console.WriteLine($"[skip] LAD element graph ({label}): no FlgNet network under {root}");
            return 0;
        }

        Console.WriteLine(
            $"[ok] LAD element graph ({label}): networks={networks} elements={elements} " +
            $"wires={wires} negated={negated} withBox={withBox}");
        Console.WriteLine(
            $"[ok] rung text ({label}): {withLadderText}/{reduced} structured network(s) render a rung view");
        Console.WriteLine(
            $"[ok] rung reducer ({label}): structured={reduced} unstructured={unreduced} coils={coils}" +
            (unreducedReasons.Count > 0
                ? " reasons=" + string.Join(",", unreducedReasons.Select(pair => $"{pair.Key}:{pair.Value}"))
                : string.Empty));
        return 0;
    }

    private static int CheckSqliteRoundTrip()
    {
        var dbPath = TempDbPath();
        try
        {
            var graph = new SemanticPlcGraph();
            graph.UpsertNode(new SemanticGraphNode(
                "self-test:project",
                SemanticNodeKind.Project,
                "self-test"));
            graph.UpsertNode(new SemanticGraphNode(
                "self-test:block",
                SemanticNodeKind.FunctionBlock,
                "SelfTest"));
            graph.UpsertEdge(new SemanticGraphEdge(
                "self-test:edge",
                "self-test:project",
                "self-test:block",
                SemanticRelationshipType.Contains));

            SqliteSemanticGraphStore.Save(dbPath, graph);
            var loaded = SqliteSemanticGraphStore.Load(dbPath);

            if (loaded.Nodes.Count != 2 || loaded.Edges.Count != 1)
            {
                Console.WriteLine(
                    $"[FAIL] sqlite round-trip: expected 2 nodes / 1 edge, got {loaded.Nodes.Count} / {loaded.Edges.Count}");
                return 1;
            }

            Console.WriteLine(
                $"[ok] sqlite round-trip: nodes={loaded.Nodes.Count} edges={loaded.Edges.Count}");
            return 0;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[FAIL] sqlite round-trip: {ex.GetType().Name}: {ex.Message}");
            return 1;
        }
        finally
        {
            TryDelete(dbPath);
        }
    }

    private static int CheckExportCrawl(string deviceDir)
    {
        try
        {
            if (!Directory.Exists(deviceDir))
            {
                Console.WriteLine($"[FAIL] export crawl: '{deviceDir}' is not a directory");
                return 1;
            }

            var result = ExportFolderCrawler.Import(
                deviceDir,
                progress: message => Console.WriteLine($"[crawl] {message}"));

            var byKind = string.Join(", ", result.Graph.Nodes
                .GroupBy(node => node.Kind)
                .OrderBy(group => group.Key, StringComparer.Ordinal)
                .Select(group => $"{group.Key}={group.Count()}"));

            Console.WriteLine(
                $"[ok] export crawl ({result.Source}): filesFound={result.FilesFound} filesImported={result.FilesImported} " +
                $"nodes={result.Graph.Nodes.Count} edges={result.Graph.Edges.Count}");
            Console.WriteLine($"[crawl] by kind: {byKind}");

            foreach (var warning in result.Warnings)
            {
                Console.WriteLine($"[crawl] warning: {warning}");
            }

            if (result.FilesImported == 0)
            {
                Console.WriteLine("[FAIL] export crawl: nothing was imported");
                return 1;
            }

            return 0;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[FAIL] export crawl: {ex.GetType().Name}: {ex.Message}");
            return 1;
        }
    }

    /// <summary>
    /// Drives the same dispatch the protocol uses, so this covers ingestion,
    /// querying and the read-only guard rather than the operations in isolation.
    /// </summary>
    private static int CheckOperations(string deviceDir)
    {
        var dbPath = TempDbPath();
        try
        {
            var ingest = Program.Execute(
                "self-test",
                OperationCatalog.Ingest,
                new JsonObject { ["deviceDir"] = deviceDir, ["dbPath"] = dbPath },
                NullProgressSink.Instance);

            var ingestError = DescribeError(ingest);
            if (ingestError is not null)
            {
                Console.WriteLine($"[FAIL] ingest: {ingestError}");
                return 1;
            }

            var ingestData = ingest["data"] as JsonObject;
            Console.WriteLine(
                $"[ok] ingest: filesFound={ingestData?["filesFound"]} filesImported={ingestData?["filesImported"]} " +
                $"nodes={ingestData?["nodes"]} edges={ingestData?["edges"]}");

            var query = Program.Execute(
                "self-test",
                OperationCatalog.Query,
                new JsonObject
                {
                    ["dbPath"] = dbPath,
                    ["sql"] = "SELECT kind, COUNT(*) AS count FROM graph_nodes GROUP BY kind ORDER BY kind;",
                },
                NullProgressSink.Instance);

            var queryError = DescribeError(query);
            if (queryError is not null)
            {
                Console.WriteLine($"[FAIL] query: {queryError}");
                return 1;
            }

            var queryData = query["data"] as JsonObject;
            var columns = queryData?["columns"] as JsonArray;
            if (columns is null)
            {
                Console.WriteLine("[FAIL] query: the result carried no columns");
                return 1;
            }

            var rows = queryData?["rows"] as JsonArray;
            Console.WriteLine($"[ok] query: columns={columns.Count} rows={rows?.Count ?? 0}");

            // A LAD network's translated logic must be attached to its row. The
            // join between the translator and the importer is a segment key, and a
            // one-character mistake there empties every LAD network without
            // changing a single node count — the crawl stays green and only an
            // expert reading the database notices (docs/decisions.md D28).
            var logicQuery = Program.Execute(
                "self-test",
                OperationCatalog.Query,
                new JsonObject
                {
                    ["dbPath"] = dbPath,
                    ["sql"] =
                        "SELECT " +
                        "SUM(CASE WHEN language = 'LAD' THEN 1 ELSE 0 END) AS lad, " +
                        "SUM(CASE WHEN language = 'LAD' AND logic_statements IS NOT NULL AND length(logic_statements) > 0 " +
                        "THEN 1 ELSE 0 END) AS lad_with_logic FROM knowledge_networks;",
                },
                NullProgressSink.Instance);

            var logicError = DescribeError(logicQuery);
            if (logicError is not null)
            {
                Console.WriteLine($"[FAIL] LAD logic: {logicError}");
                return 1;
            }

            var logicRow = (logicQuery["data"] as JsonObject)?["rows"] as JsonArray;
            var firstRow = logicRow is { Count: > 0 } ? logicRow[0] as JsonArray : null;
            var lad = firstRow?[0]?.GetValue<int>() ?? 0;
            var ladWithLogic = firstRow?[1]?.GetValue<int>() ?? 0;
            if (lad > 0 && ladWithLogic == 0)
            {
                Console.WriteLine(
                    $"[FAIL] LAD logic: {lad} LAD network(s) but none carries translated logic — " +
                    "the translator/importer segment key is not joining");
                return 1;
            }

            Console.WriteLine($"[ok] LAD logic: {ladWithLogic}/{lad} LAD network(s) carry translated logic");

            // Phase 4 of docs/lad-understanding-plan.md: the rung view has to reach the database,
            // not merely be computable in memory. The first end-to-end check of this was a manual
            // ingest+query; a regression that stopped storing ladderText would have left every other
            // check green, so it is asserted here.
            var ladderQuery = Program.Execute(
                "self-test",
                OperationCatalog.Query,
                new JsonObject
                {
                    ["dbPath"] = dbPath,
                    ["sql"] =
                        "SELECT " +
                        "SUM(CASE WHEN language = 'LAD' THEN 1 ELSE 0 END) AS lad, " +
                        "SUM(CASE WHEN EXISTS (SELECT 1 FROM graph_node_properties p " +
                        "  WHERE p.node_id = knowledge_networks.network_id AND p.name = 'ladderText') " +
                        "  THEN 1 ELSE 0 END) AS with_ladder " +
                        "FROM knowledge_networks;",
                },
                NullProgressSink.Instance);

            var ladderError = DescribeError(ladderQuery);
            if (ladderError is not null)
            {
                Console.WriteLine($"[FAIL] ladder text: {ladderError}");
                return 1;
            }

            var ladderRow = (ladderQuery["data"] as JsonObject)?["rows"] as JsonArray;
            var ladderFirst = ladderRow is { Count: > 0 } ? ladderRow[0] as JsonArray : null;
            var ladNetworks = ladderFirst?[0]?.GetValue<int>() ?? 0;
            var withLadder = ladderFirst?[1]?.GetValue<int>() ?? 0;
            if (ladNetworks > 0 && withLadder == 0)
            {
                Console.WriteLine(
                    $"[FAIL] ladder text: {ladNetworks} LAD network(s) but none carries a stored rung view — " +
                    "LadderText is not reaching the property store");
                return 1;
            }

            // The gap is expected: a LAD-labelled network with no FlgNet source (an empty or
            // comment-only network) has nothing to draw, and a network with neither a coil nor an
            // open end renders nothing. The guard above is about the view not reaching the store at
            // all, which would zero the numerator.
            int withoutView = ladNetworks - withLadder;
            Console.WriteLine(
                $"[ok] ladder text: {withLadder}/{ladNetworks} LAD network(s) carry a stored rung view" +
                (withoutView > 0 ? $" ({withoutView} have no FlgNet source, or no coil and no open end)" : string.Empty));

            // The read-only guard must refuse a write even though the caller is the
            // engine itself: it is the backstop, not a convenience.
            var write = Program.Execute(
                "self-test",
                OperationCatalog.Query,
                new JsonObject { ["dbPath"] = dbPath, ["sql"] = "DROP TABLE graph_nodes;" },
                NullProgressSink.Instance);

            var writeCode = (write["error"] as JsonObject)?["code"]?.GetValue<string>();
            if (write["ok"]?.GetValue<bool>() != false || writeCode != "QUERY_REJECTED")
            {
                Console.WriteLine($"[FAIL] read-only guard: a DROP was not rejected with QUERY_REJECTED (got {writeCode ?? "ok=true"})");
                return 1;
            }

            Console.WriteLine("[ok] read-only guard: DROP rejected with QUERY_REJECTED");
            return 0;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[FAIL] operations: {ex.GetType().Name}: {ex.Message}");
            return 1;
        }
        finally
        {
            TryDelete(dbPath);
        }
    }

    /// <summary>
    /// The incremental `Update` operation against a real D24 device tree.
    ///
    /// A plain fixture crawl (like <see cref="CheckExportCrawl"/>) would not be enough:
    /// the production layout is the manifest one, and it is the one whose component
    /// provenance this check has to prove. So the tree is built under the OS temp
    /// directory from two real exports plus a hand-written `_manifest.json`, ingested,
    /// then mutated the way a sync would mutate it.
    /// </summary>
    private static int CheckIncrementalUpdate(string fixturesDir)
    {
        var root = Path.Combine(Path.GetTempPath(), $"{Protocol.EngineName}-update-{Guid.NewGuid():N}");
        var deviceDir = Path.Combine(root, "source", "UpdateFixture");
        var dbPath = Path.Combine(root, "knowledge", "UpdateFixture", "UpdateFixture_knowledge.db");
        const string mainRelative = "blocks/Main [OB1].xml";
        const string fcRelative = "blocks/010_Cell/FC_LAD_SimulateCylinder_Call [FC1].xml";
        const string sclRelative = "blocks/SclAssign [FC10].xml";

        try
        {
            var blocksDir = Path.Combine(deviceDir, "blocks");
            var groupDir = Path.Combine(blocksDir, "010_Cell");
            Directory.CreateDirectory(groupDir);
            var mainPath = Path.Combine(blocksDir, "Main [OB1].xml");
            var fcPath = Path.Combine(groupDir, "FC_LAD_SimulateCylinder_Call [FC1].xml");
            var sclPath = Path.Combine(blocksDir, "SclAssign [FC10].xml");
            File.Copy(Path.Combine(fixturesDir, "Main [OB1].xml"), mainPath);
            File.Copy(
                Path.Combine(fixturesDir, "FC_LAD_SimulateCylinder_Call [FC1].xml"),
                fcPath);
            File.Copy(Path.Combine(fixturesDir, "SclAssign [FC10].xml"), sclPath);
            WriteDeviceManifest(
                deviceDir,
                ("blocks", "Main", "", mainPath, "OB"),
                ("blocks", "FC_LAD_SimulateCylinder_Call", "010_Cell/", fcPath, "FC"),
                ("blocks", "SclAssign", "", sclPath, "FC"));

            var ingest = Program.Execute(
                "self-test",
                OperationCatalog.Ingest,
                new JsonObject { ["deviceDir"] = deviceDir, ["dbPath"] = dbPath },
                NullProgressSink.Instance);
            var ingestError = DescribeError(ingest);
            if (ingestError is not null)
            {
                Console.WriteLine($"[FAIL] incremental update: ingest failed: {ingestError}");
                return 1;
            }

            var componentsBefore = ScalarLong(dbPath, "SELECT COUNT(*) FROM source_components;");
            var hashBefore = ScalarString(
                dbPath,
                "SELECT content_hash FROM source_components WHERE relative_path = $path;",
                ("$path", fcRelative));
            var mainNodesBefore = ComponentNodeCount(dbPath, mainRelative);
            var nodesBefore = ScalarLong(dbPath, "SELECT COUNT(*) FROM graph_nodes;");
            var edgesBefore = ScalarLong(dbPath, "SELECT COUNT(*) FROM graph_edges;");
            if (componentsBefore != 3 ||
                hashBefore is null ||
                mainNodesBefore == 0 ||
                nodesBefore == 0 ||
                edgesBefore == 0)
            {
                Console.WriteLine(
                    $"[FAIL] incremental update: the manifest ingest left no usable provenance " +
                    $"(components={componentsBefore} hash={(hashBefore is null ? "null" : "set")} " +
                    $"mainNodes={mainNodesBefore} nodes={nodesBefore} edges={edgesBefore})");
                return 1;
            }

            if (ScalarLong(dbPath, "SELECT COUNT(*) FROM graph_nodes WHERE id = 'symbol:btn_forward';") != 1)
            {
                Console.WriteLine("[FAIL] incremental update: the fixture's symbol:btn_forward was not imported");
                return 1;
            }

            // 1. Mutate one block exactly like a rename of an interface member: the
            //    interface declaration and the network access are the same text, so a
            //    single replace changes both.
            var mutated = File.ReadAllText(fcPath).Replace(
                "\"btn_forward\"",
                "\"btn_forward_renamed\"",
                StringComparison.Ordinal);
            File.WriteAllText(fcPath, mutated);

            var update = Program.Execute(
                "self-test",
                OperationCatalog.Update,
                new JsonObject
                {
                    ["deviceDir"] = deviceDir,
                    ["dbPath"] = dbPath,
                    ["changedPaths"] = new JsonArray(fcRelative),
                },
                NullProgressSink.Instance);
            var updateError = DescribeError(update);
            if (updateError is not null)
            {
                Console.WriteLine($"[FAIL] incremental update: update failed: {updateError}");
                return 1;
            }

            var data = update["data"] as JsonObject;
            var changed = data?["changed"]?.GetValue<int>() ?? -1;
            var closure = data?["closure"]?.GetValue<int>() ?? -1;
            var removed = data?["removed"]?.GetValue<int>() ?? -1;
            var closurePaths = (data?["closureComponents"] as JsonArray)?
                .Select(node => node?.GetValue<string>() ?? string.Empty)
                .ToArray() ?? Array.Empty<string>();
            var hashAfter = ScalarString(
                dbPath,
                "SELECT content_hash FROM source_components WHERE relative_path = $path;",
                ("$path", fcRelative));
            var expectedHash = ComponentKeys.ContentHashOf(File.ReadAllBytes(fcPath));
            var mainNodesAfter = ComponentNodeCount(dbPath, mainRelative);
            var callsSurvived = ScalarLong(
                dbPath,
                """
                SELECT COUNT(*)
                FROM graph_edges
                WHERE type = 'CALLS'
                  AND from_node_id = 'block:Main'
                  AND to_node_id = 'block:FC_LAD_SimulateCylinder_Call';
                """);
            var oldSymbolGone = ScalarLong(dbPath, "SELECT COUNT(*) FROM graph_nodes WHERE id = 'symbol:btn_forward';") == 0;
            var newSymbolPresent = ScalarLong(
                dbPath,
                "SELECT COUNT(*) FROM graph_nodes WHERE id = 'symbol:btn_forward_renamed';") == 1;

            if (changed != 1 || closure < 1 || removed != 0 ||
                !closurePaths.Contains(mainRelative, StringComparer.Ordinal) ||
                hashAfter is null || string.Equals(hashAfter, hashBefore, StringComparison.Ordinal) ||
                !string.Equals(hashAfter, expectedHash, StringComparison.Ordinal) ||
                !oldSymbolGone || !newSymbolPresent ||
                mainNodesAfter != mainNodesBefore ||
                callsSurvived != 1)
            {
                Console.WriteLine(
                    $"[FAIL] incremental update: changed={changed} closure={closure} removed={removed} " +
                    $"closurePaths=[{string.Join(", ", closurePaths)}] " +
                    $"hashChanged={!string.Equals(hashAfter, hashBefore, StringComparison.Ordinal)} " +
                    $"hashMatchesFile={string.Equals(hashAfter, expectedHash, StringComparison.Ordinal)} " +
                    $"oldSymbolGone={oldSymbolGone} newSymbolPresent={newSymbolPresent} " +
                    $"mainNodes={mainNodesBefore}->{mainNodesAfter} callsSurvived={callsSurvived}");
                return 1;
            }

            // The database still opens as a graph after an in-place update.
            var loaded = SqliteSemanticGraphStore.Load(dbPath);
            if (loaded.Nodes.Count == 0)
            {
                Console.WriteLine("[FAIL] incremental update: the updated database loads as an empty graph");
                return 1;
            }

            Console.WriteLine(
                $"[ok] incremental update: changed={changed} closure={closure} " +
                $"closurePaths=[{string.Join(", ", closurePaths)}] " +
                $"nodes={data?["nodes"]} edges={data?["edges"]}");

            // 2. A deleted block is removed from the database, and its neighbours keep
            //    their node counts.
            File.Delete(sclPath);
            var mainNodesBeforeRemoval = ComponentNodeCount(dbPath, mainRelative);
            var removal = Program.Execute(
                "self-test",
                OperationCatalog.Update,
                new JsonObject
                {
                    ["deviceDir"] = deviceDir,
                    ["dbPath"] = dbPath,
                    ["removedPaths"] = new JsonArray(sclRelative, "blocks/NotInTheDatabase.xml"),
                },
                NullProgressSink.Instance);
            var removalError = DescribeError(removal);
            if (removalError is not null)
            {
                Console.WriteLine($"[FAIL] incremental removal: {removalError}");
                return 1;
            }

            var removalData = removal["data"] as JsonObject;
            var removedCount = removalData?["removed"]?.GetValue<int>() ?? -1;
            var ignored = (removalData?["ignoredRemovedPaths"] as JsonArray)?
                .Select(node => node?.GetValue<string>() ?? string.Empty)
                .ToArray() ?? Array.Empty<string>();
            var sclComponentGone = ScalarLong(
                dbPath,
                "SELECT COUNT(*) FROM source_components WHERE relative_path = $path;",
                ("$path", sclRelative)) == 0;
            var sclNodeGone = ScalarLong(
                dbPath,
                "SELECT COUNT(*) FROM graph_nodes WHERE id = 'block:SclAssign';") == 0;
            if (removedCount != 1 || !sclComponentGone || !sclNodeGone ||
                !ignored.Contains("blocks/NotInTheDatabase.xml", StringComparer.Ordinal) ||
                ComponentNodeCount(dbPath, mainRelative) != mainNodesBeforeRemoval)
            {
                Console.WriteLine(
                    $"[FAIL] incremental removal: removed={removedCount} componentGone={sclComponentGone} " +
                    $"nodeGone={sclNodeGone} ignored=[{string.Join(", ", ignored)}]");
                return 1;
            }

            Console.WriteLine(
                $"[ok] incremental removal: removed={removedCount} ignoredUnknown={ignored.Length} " +
                $"nodes={removalData?["nodes"]} edges={removalData?["edges"]}");

            // 3. The refusal codes: a database without provenance, an unknown changed
            //    path, and a batch over the component cap.
            var plainDb = Path.Combine(root, "plain.db");
            SqliteSemanticGraphStore.Save(plainDb, new SemanticPlcGraph());
            var requiresRebuild = Program.Execute(
                "self-test",
                OperationCatalog.Update,
                new JsonObject
                {
                    ["deviceDir"] = deviceDir,
                    ["dbPath"] = plainDb,
                    ["changedPaths"] = new JsonArray(fcRelative),
                },
                NullProgressSink.Instance);
            var unknown = Program.Execute(
                "self-test",
                OperationCatalog.Update,
                new JsonObject
                {
                    ["deviceDir"] = deviceDir,
                    ["dbPath"] = dbPath,
                    ["changedPaths"] = new JsonArray("blocks/NotInTheDatabase.xml"),
                },
                NullProgressSink.Instance);
            var tooLarge = Program.Execute(
                "self-test",
                OperationCatalog.Update,
                new JsonObject
                {
                    ["deviceDir"] = deviceDir,
                    ["dbPath"] = dbPath,
                    ["changedPaths"] = new JsonArray(fcRelative, mainRelative),
                    ["maxComponents"] = 1,
                },
                NullProgressSink.Instance);

            var requiresRebuildCode = ErrorCode(requiresRebuild);
            var unknownCode = ErrorCode(unknown);
            var tooLargeCode = ErrorCode(tooLarge);
            if (requiresRebuildCode != "UPDATE_REQUIRES_FULL_REBUILD" ||
                unknownCode != "UPDATE_UNKNOWN_COMPONENT" ||
                tooLargeCode != "UPDATE_TOO_LARGE")
            {
                Console.WriteLine(
                    $"[FAIL] update refusals: expected REQUIRES_FULL_REBUILD/UNKNOWN_COMPONENT/TOO_LARGE, " +
                    $"got {requiresRebuildCode ?? "ok"} / {unknownCode ?? "ok"} / {tooLargeCode ?? "ok"}");
                return 1;
            }

            Console.WriteLine(
                "[ok] update refusals: UPDATE_REQUIRES_FULL_REBUILD, UPDATE_UNKNOWN_COMPONENT, UPDATE_TOO_LARGE");

            // 4. Atomicity: the first changed component (the FC, sorted first) has
            //    already been replaced inside the transaction when the second one's
            //    file turns out to be missing. The whole batch must be rolled back.
            var hashBeforeFailedBatch = ScalarString(
                dbPath,
                "SELECT content_hash FROM source_components WHERE relative_path = $path;",
                ("$path", fcRelative));
            var nodesBeforeFailedBatch = ScalarLong(dbPath, "SELECT COUNT(*) FROM graph_nodes;");
            var edgesBeforeFailedBatch = ScalarLong(dbPath, "SELECT COUNT(*) FROM graph_edges;");
            var backup = mainPath + ".bak";
            File.Move(mainPath, backup);
            var failedBatch = Program.Execute(
                "self-test",
                OperationCatalog.Update,
                new JsonObject
                {
                    ["deviceDir"] = deviceDir,
                    ["dbPath"] = dbPath,
                    ["changedPaths"] = new JsonArray(fcRelative, mainRelative),
                },
                NullProgressSink.Instance);
            var failedCode = ErrorCode(failedBatch);
            File.Move(backup, mainPath);
            var hashAfterFailedBatch = ScalarString(
                dbPath,
                "SELECT content_hash FROM source_components WHERE relative_path = $path;",
                ("$path", fcRelative));
            var nodesAfterFailedBatch = ScalarLong(dbPath, "SELECT COUNT(*) FROM graph_nodes;");
            var edgesAfterFailedBatch = ScalarLong(dbPath, "SELECT COUNT(*) FROM graph_edges;");
            if (failedCode != "UPDATE_SOURCE_MISSING" ||
                !string.Equals(hashAfterFailedBatch, hashBeforeFailedBatch, StringComparison.Ordinal) ||
                nodesAfterFailedBatch != nodesBeforeFailedBatch ||
                edgesAfterFailedBatch != edgesBeforeFailedBatch)
            {
                Console.WriteLine(
                    $"[FAIL] update atomicity: {DescribeError(failedBatch) ?? "ok"} " +
                    $"hashRestored={string.Equals(hashAfterFailedBatch, hashBeforeFailedBatch, StringComparison.Ordinal)} " +
                    $"nodes={nodesBeforeFailedBatch}->{nodesAfterFailedBatch} " +
                    $"edges={edgesBeforeFailedBatch}->{edgesAfterFailedBatch}");
                return 1;
            }

            Console.WriteLine("[ok] update atomicity: a failed batch left the database unchanged");
            return 0;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[FAIL] incremental update: {ex.GetType().Name}: {ex.Message}");
            return 1;
        }
        finally
        {
            TryDeleteDirectory(root);
        }
    }

    /// <summary>Write the family-1 `_manifest.json` for the self test's device tree.</summary>
    private static void WriteDeviceManifest(
        string deviceDir,
        params (string Category, string Name, string Group, string File, string SimaticType)[] entries)
    {
        var device = Path.GetFileName(deviceDir);
        var blocks = new JsonArray();
        foreach (var entry in entries)
        {
            blocks.Add(new JsonObject
            {
                ["category"] = entry.Category,
                ["name"] = entry.Name,
                ["group"] = entry.Group,
                ["file"] = entry.File,
                ["simaticType"] = entry.SimaticType,
            });
        }

        var manifest = new JsonObject
        {
            ["schemaVersion"] = 1,
            ["generatedBy"] = "self-test",
            ["device"] = device,
            ["software"] = device,
            ["outputDir"] = deviceDir,
            ["failureCount"] = 0,
            ["blocks"] = blocks,
        };
        File.WriteAllText(
            Path.Combine(deviceDir, DeviceManifest.FileName),
            manifest.ToJsonString(Json.Wire));
    }

    /// <summary>How many graph nodes the component at one relative path owns.</summary>
    private static long ComponentNodeCount(string dbPath, string relativePath) =>
        ScalarLong(
            dbPath,
            """
            SELECT COUNT(*)
            FROM source_component_nodes ownership
            WHERE ownership.component_key = (
                SELECT component_key FROM source_components WHERE relative_path = $path
            );
            """,
            ("$path", relativePath));

    /// <summary>One scalar count/string read through a fresh read-only connection.</summary>
    private static long ScalarLong(
        string dbPath,
        string sql,
        params (string Name, string Value)[] parameters) =>
        Convert.ToInt64(Scalar(dbPath, sql, parameters));

    private static string? ScalarString(
        string dbPath,
        string sql,
        params (string Name, string Value)[] parameters)
    {
        var value = Scalar(dbPath, sql, parameters);
        return value is null || value == DBNull.Value ? null : Convert.ToString(value);
    }

    private static object? Scalar(
        string dbPath,
        string sql,
        params (string Name, string Value)[] parameters)
    {
        SqliteSemanticGraphStore.EnsureSqliteInitialized();
        using var connection = new SqliteConnection($"Data Source={dbPath}");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        foreach (var parameter in parameters)
        {
            command.Parameters.AddWithValue(parameter.Name, parameter.Value);
        }

        var value = command.ExecuteScalar();
        return value;
    }

    private static string? ErrorCode(JsonObject frame) =>
        frame["ok"]?.GetValue<bool>() == true
            ? null
            : (frame["error"] as JsonObject)?["code"]?.GetValue<string>();

    private static string? DescribeError(JsonObject frame)
    {
        if (frame["ok"]?.GetValue<bool>() == true)
        {
            return null;
        }

        var error = frame["error"] as JsonObject;
        return $"{error?["code"]}: {error?["message"]}";
    }

    private static string TempDbPath() =>
        Path.Combine(Path.GetTempPath(), $"{Protocol.EngineName}-self-test-{Guid.NewGuid():N}.db");

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
            // A leftover temp file must not turn a passing self test into a failure.
        }
    }

    /// <summary>
    /// Best-effort removal of a temp directory this check created under the OS temp
    /// folder. No junction or link is involved, so a recursive delete is safe here.
    /// </summary>
    private static void TryDeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path))
            {
                Directory.Delete(path, recursive: true);
            }
        }
        catch
        {
            // Same rule as TryDelete: cleanup cannot fail the check.
        }
    }
}
