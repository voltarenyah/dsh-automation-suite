// Invariants over the rendered LAD view. They do not know what a correct rung text is; they only
// check that information which is in the XML is not lost on the way to the text. That is the
// class of defect the reference equivalence check could not see (see
// docs/reviews/2026-11-28-ladder-projection-defects.md, sections 3 and 4.1):
//
//   I1  every coil element of the network appears as a rung coil line (also mid-chain coils,
//       set/reset coils, unreachable coils);
//   I2  every variable operand of the network appears literally in the ladder text;
//   I3  every block instance, with its array index, appears in the logic text;
//   I4  two instruction boxes of the same name on one rung line have different operands in the
//       XML, yet the rung line cannot tell them apart.
//
// Each invariant is a pure function of its inputs, so SelfCheck can prove it still detects a
// broken input, and AuditFolder can count violations over a whole export without a golden file.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml.Linq;

namespace EngineeringGraph.Engine;

internal static class RungInvariants
{
    internal sealed record NetworkAudit(
        IReadOnlyList<string> I1,
        IReadOnlyList<string> I2,
        IReadOnlyList<string> I3,
        IReadOnlyList<string> I4,
        bool HasBox);

    private static bool IsCoilKind(FlgElementKind kind) =>
        kind is FlgElementKind.Coil or FlgElementKind.SetCoil or FlgElementKind.ResetCoil;

    private static bool IsComponent(XElement element) => element.Name.LocalName == "Component";

    /// <summary>I1: every coil element is rendered as a coil line of the rung model.</summary>
    internal static IReadOnlyList<string> CheckI1(FlgNetworkGraph graph, RungModel rung)
    {
        var rendered = new HashSet<string>(rung.Coils.Select(coil => coil.ElementId), StringComparer.OrdinalIgnoreCase);
        var missing = new List<string>();
        foreach (FlgElement element in graph.Elements)
        {
            if (IsCoilKind(element.Kind) && !rendered.Contains(element.Id))
            {
                missing.Add($"{element.Id}:{graph.OperandOf(element.Id) ?? element.Id}");
            }
        }

        return missing;
    }

    /// <summary>I2: every variable operand (an Access with a Symbol, not a constant) is in the ladder text.</summary>
    internal static IReadOnlyList<string> CheckI2(XElement flgNet, string ladderText)
    {
        var missing = new List<string>();
        foreach (XElement access in flgNet.Descendants().Where(element => element.Name.LocalName == "Access"))
        {
            if (!access.Descendants().Any(element => element.Name.LocalName == "Symbol"))
            {
                continue;
            }

            string text = ProgramBlockLogicYamlWriter.FlgNetContext.GetAccessValue(access);
            if (text.Length == 0 || ladderText.Contains(text, StringComparison.Ordinal))
            {
                continue;
            }

            if (!missing.Contains(text))
            {
                missing.Add(text);
            }
        }

        return missing;
    }

    /// <summary>I3: every block instance is named in the logic text with its full (indexed) name.</summary>
    internal static IReadOnlyList<string> CheckI3(XElement flgNet, string logicText)
    {
        var missing = new List<string>();
        foreach (XElement instance in flgNet.Descendants().Where(element => element.Name.LocalName == "Instance"))
        {
            string name = RenderInstanceChain(instance);
            if (name.Length == 0 || logicText.Contains(name, StringComparison.Ordinal))
            {
                continue;
            }

            if (!missing.Contains(name))
            {
                missing.Add(name);
            }
        }

        return missing;
    }

    /// <summary>
    /// I4: on one rung line, two boxes of the same name must be distinguishable. They are not
    /// distinguishable when their XML operands differ but their rendered step names are equal.
    /// </summary>
    internal static IReadOnlyList<string> CheckI4(XElement flgNet, FlgNetworkGraph graph, RungModel rung)
    {
        var owners = InstanceOwners(flgNet);
        var lines = new List<string>();
        foreach (RungPath path in AllPaths(rung))
        {
            RungStep[] boxes = path.Steps.Where(step => step.Kind is FlgElementKind.Box or FlgElementKind.Call).ToArray();
            bool indistinguishable = false;
            for (int i = 0; i < boxes.Length && !indistinguishable; i++)
            {
                for (int j = i + 1; j < boxes.Length && !indistinguishable; j++)
                {
                    if (string.Equals(RungModel.StepName(boxes[i]), RungModel.StepName(boxes[j]), StringComparison.Ordinal) &&
                        Signature(graph, owners, boxes[i].ElementId) != Signature(graph, owners, boxes[j].ElementId))
                    {
                        indistinguishable = true;
                    }
                }
            }

            if (indistinguishable)
            {
                lines.Add(RungModel.ConditionOf(path));
            }
        }

        return lines.Distinct(StringComparer.Ordinal).ToArray();
    }

    /// <summary>Runs I1–I4 on one CompileUnit that carries a FlgNet. Throws only on malformed XML.</summary>
    internal static NetworkAudit AuditNetwork(XElement compileUnit)
    {
        XElement flgNet = compileUnit.Descendants().First(element => element.Name.LocalName == "FlgNet");
        FlgNetworkGraph graph = FlgNetworkGraph.Build(flgNet);
        RungModel rung = SeriesParallelReducer.Reduce(graph);
        string ladder = LadderText.Render(graph, rung);
        string logic = string.Join("\n", ProgramBlockLogicYamlWriter.TranslateStatementsOf(compileUnit));
        bool hasBox = graph.Elements.Any(element => element.Kind is FlgElementKind.Box or FlgElementKind.Call);
        return new NetworkAudit(
            CheckI1(graph, rung),
            CheckI2(flgNet, ladder),
            CheckI3(flgNet, logic),
            CheckI4(flgNet, graph, rung),
            hasBox);
    }

    /// <summary>Counts the four invariants over every CompileUnit under <paramref name="root"/>.</summary>
    internal static JsonObject AuditFolder(string root)
    {
        var totals = new Dictionary<string, (long Networks, long Items)>
        {
            ["I1"] = (0, 0), ["I2"] = (0, 0), ["I3"] = (0, 0), ["I4"] = (0, 0),
        };
        var examples = new Dictionary<string, List<string>>
        {
            ["I1"] = new(), ["I2"] = new(), ["I3"] = new(), ["I4"] = new(),
        };
        long files = 0;
        long networks = 0;
        long errors = 0;
        long i3Indexed = 0;
        long i2NoBoxNetworks = 0;
        long i2NoBoxItems = 0;

        foreach (string file in Directory.EnumerateFiles(root, "*.xml", SearchOption.AllDirectories).OrderBy(path => path, StringComparer.Ordinal))
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

            files++;
            string relative = Path.GetRelativePath(root, file).Replace('\\', '/');
            foreach (XElement unit in document.Descendants().Where(element => element.Name.LocalName == "SW.Blocks.CompileUnit"))
            {
                if (!unit.Descendants().Any(element => element.Name.LocalName == "FlgNet"))
                {
                    continue;
                }

                networks++;
                string where = $"{relative}#{unit.Attribute("ID")?.Value ?? "?"}";
                NetworkAudit audit;
                try
                {
                    audit = AuditNetwork(unit);
                }
                catch (Exception ex)
                {
                    errors++;
                    Console.Error.WriteLine($"audit error at {where}: {ex.GetType().Name}: {ex.Message}");
                    continue;
                }

                Record(totals, examples, "I1", where, audit.I1);
                Record(totals, examples, "I2", where, audit.I2);
                Record(totals, examples, "I3", where, audit.I3);
                i3Indexed += audit.I3.Count(name => name.Contains('['));
                if (audit.I2.Count > 0 && !audit.HasBox)
                {
                    i2NoBoxNetworks++;
                    i2NoBoxItems += audit.I2.Count;
                }
                Record(totals, examples, "I4", where, audit.I4);
            }
        }

        var report = new JsonObject
        {
            ["root"] = root,
            ["files"] = files,
            ["networks"] = networks,
            ["errors"] = errors,
        };

        foreach (string key in new[] { "I1", "I2", "I3", "I4" })
        {
            report[key] = new JsonObject
            {
                ["networks"] = totals[key].Networks,
                ["items"] = totals[key].Items,
                ["examples"] = new JsonArray(examples[key].Select(text => (JsonNode)JsonValue.Create(text)!).ToArray()),
            };
        }

        // I3 is split in two: an indexed name (S_IEC_Timer[0]) can lose only its index, while a plain
        // name (Switch_FrontLightCurtain) is absent from the logic text altogether.
        report["I3"]!["indexed"] = i3Indexed;
        report["I3"]!["plain"] = totals["I3"].Items - i3Indexed;

        // I2 outside any box: these are not box-input losses, so the box signature fix does not reach them.
        report["I2"]!["withoutBox"] = new JsonObject { ["networks"] = i2NoBoxNetworks, ["items"] = i2NoBoxItems };

        return report;
    }

    /// <summary>CLI entry: <c>--rung-invariants &lt;exportRoot&gt;</c>. Prints one JSON object.</summary>
    internal static int RunCli(string? root)
    {
        if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root))
        {
            Console.Error.WriteLine("usage: EngineeringGraph.Engine --rung-invariants <exportRoot>");
            return 2;
        }

        JsonObject report = AuditFolder(root);
        Console.WriteLine(report.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        return 0;
    }

    /// <summary>
    /// Proves each invariant still detects a broken input. The inputs are built by hand, not by the
    /// reducer, so a fix to the reducer cannot turn these checks into tautologies.
    /// </summary>
    internal static int SelfCheck()
    {
        int failures = 0;

        // I1: the rung model renders only the last coil of a chain; coil "1" is missing.
        FlgNetworkGraph chain = GraphOf("<FlgNet><Parts><Part Name=\"Coil\" UId=\"1\" /><Part Name=\"Coil\" UId=\"2\" /></Parts><Wires /></FlgNet>");
        var lastOnly = new RungModel(
            new[] { new RungCoil("2", FlgElementKind.Coil, null, new[] { new RungPath(Array.Empty<RungStep>(), "2", FlgElementKind.Coil, null, false) }, false) },
            Array.Empty<RungPath>(), true, null, Array.Empty<string>(), 1);
        failures += Check("I1 flags a coil the rung model does not render", CheckI1(chain, lastOnly).Count == 1);
        var both = new RungModel(
            new[]
            {
                new RungCoil("1", FlgElementKind.Coil, null, new[] { new RungPath(Array.Empty<RungStep>(), "1", FlgElementKind.Coil, null, false) }, false),
                new RungCoil("2", FlgElementKind.Coil, null, new[] { new RungPath(Array.Empty<RungStep>(), "2", FlgElementKind.Coil, null, false) }, false),
            },
            Array.Empty<RungPath>(), true, null, Array.Empty<string>(), 2);
        failures += Check("I1 is silent when every coil is rendered", CheckI1(chain, both).Count == 0);

        // I2: variable A is missing from the text, B is present, constants are not operands.
        XElement operands = XElement.Parse(
            "<FlgNet><Parts>" +
            "<Access Scope=\"LocalVariable\" UId=\"1\"><Symbol><Component Name=\"A\" /></Symbol></Access>" +
            "<Access Scope=\"LocalVariable\" UId=\"2\"><Symbol><Component Name=\"B\" /></Symbol></Access>" +
            "<Access Scope=\"LiteralConstant\" UId=\"3\"><Constant><ConstantType>Int</ConstantType><ConstantValue>7</ConstantValue></Constant></Access>" +
            "</Parts><Wires /></FlgNet>");
        failures += Check("I2 flags a variable operand absent from the text", CheckI2(operands, "x := B;").SequenceEqual(new[] { "A" }));
        failures += Check("I2 accepts text that carries every variable", CheckI2(operands, "A AND B").Count == 0);

        // I3: the instance is TON on S_IEC_Timer[0]; a logic text naming it without the index is wrong.
        XElement instance = XElement.Parse(
            "<FlgNet><Parts><Part Name=\"TON\" UId=\"5\"><Instance Scope=\"LocalVariable\">" +
            "<Component Name=\"S_IEC_Timer\" AccessModifier=\"Array\"><Access Scope=\"LiteralConstant\"><Constant><ConstantType>DInt</ConstantType>" +
            "<ConstantValue>0</ConstantValue></Constant></Access></Component></Instance></Part></Parts><Wires /></FlgNet>");
        failures += Check("I3 flags an instance whose index is missing from the logic text", CheckI3(instance, "S_IEC_Timer.TON(").SequenceEqual(new[] { "S_IEC_Timer[0]" }));
        failures += Check("I3 accepts the indexed instance name", CheckI3(instance, "S_IEC_Timer[0].TON(").Count == 0);

        // I4: two Move boxes on one rung, fed by different variables, rendered as "[Move]" twice.
        XElement moves = XElement.Parse(
            "<FlgNet><Parts>" +
            "<Part Name=\"Move\" UId=\"10\" /><Part Name=\"Move\" UId=\"11\" />" +
            "<Access Scope=\"LocalVariable\" UId=\"1\"><Symbol><Component Name=\"A\" /></Symbol></Access>" +
            "<Access Scope=\"LocalVariable\" UId=\"2\"><Symbol><Component Name=\"B\" /></Symbol></Access>" +
            "</Parts><Wires>" +
            "<Wire UId=\"20\"><IdentCon UId=\"1\" /><NameCon UId=\"10\" Name=\"in\" /></Wire>" +
            "<Wire UId=\"21\"><IdentCon UId=\"2\" /><NameCon UId=\"11\" Name=\"in\" /></Wire>" +
            "</Wires></FlgNet>");
        var rung = new RungModel(
            new[]
            {
                new RungCoil("99", FlgElementKind.Coil, "Q", new[]
                {
                    new RungPath(
                        new[]
                        {
                            new RungStep("10", FlgElementKind.Box, "Move", false),
                            new RungStep("11", FlgElementKind.Box, "Move", false),
                        },
                        "99", FlgElementKind.Coil, "Q", false),
                }, false),
            },
            Array.Empty<RungPath>(), true, null, Array.Empty<string>(), 1);
        failures += Check("I4 flags two same-name boxes with different operands on one line", CheckI4(moves, FlgNetworkGraph.Build(moves), rung).Count == 1);

        XElement sameOperand = XElement.Parse(moves.ToString().Replace("<IdentCon UId=\"2\" />", "<IdentCon UId=\"1\" />"));
        failures += Check("I4 is silent when the two boxes really are identical", CheckI4(sameOperand, FlgNetworkGraph.Build(sameOperand), rung).Count == 0);

        // Regression tests for the rendered text itself (defects 1-3). Unlike the detectors above,
        // these assert the expected output, so they fail if the renderer loses information again.
        string renderedChain = RenderOf(
            "<FlgNet><Parts>" +
            "<Part Name=\"Coil\" UId=\"1\" /><Part Name=\"Coil\" UId=\"2\" />" +
            "<Access Scope=\"LocalVariable\" UId=\"3\"><Symbol><Component Name=\"A\" /></Symbol></Access>" +
            "<Access Scope=\"LocalVariable\" UId=\"4\"><Symbol><Component Name=\"B\" /></Symbol></Access>" +
            "</Parts><Wires>" +
            "<Wire UId=\"10\"><Powerrail /><NameCon UId=\"1\" Name=\"in\" /></Wire>" +
            "<Wire UId=\"11\"><IdentCon UId=\"3\" /><NameCon UId=\"1\" Name=\"operand\" /></Wire>" +
            "<Wire UId=\"12\"><NameCon UId=\"1\" Name=\"out\" /><NameCon UId=\"2\" Name=\"in\" /></Wire>" +
            "<Wire UId=\"13\"><IdentCon UId=\"4\" /><NameCon UId=\"2\" Name=\"operand\" /></Wire>" +
            "</Wires></FlgNet>");
        failures += Check("defect 2: a coil followed by another coil keeps both lines",
            renderedChain.Contains("(=) A   <-  TRUE", StringComparison.Ordinal) && renderedChain.Contains("(=) B   <-  TRUE", StringComparison.Ordinal));

        string box = RenderOf(
            "<FlgNet><Parts>" +
            "<Part Name=\"Eq\" UId=\"20\" />" +
            "<Access Scope=\"LocalVariable\" UId=\"1\"><Symbol><Component Name=\"ActMode\" /></Symbol></Access>" +
            "<Access Scope=\"LiteralConstant\" UId=\"2\"><Constant><ConstantType>Int</ConstantType><ConstantValue>7</ConstantValue></Constant></Access>" +
            "<Access Scope=\"LocalVariable\" UId=\"3\"><Symbol><Component Name=\"Q\" /></Symbol></Access>" +
            "<Part Name=\"Coil\" UId=\"30\" />" +
            "</Parts><Wires>" +
            "<Wire UId=\"10\"><Powerrail /><NameCon UId=\"20\" Name=\"pre\" /></Wire>" +
            "<Wire UId=\"11\"><IdentCon UId=\"1\" /><NameCon UId=\"20\" Name=\"in1\" /></Wire>" +
            "<Wire UId=\"12\"><IdentCon UId=\"2\" /><NameCon UId=\"20\" Name=\"in2\" /></Wire>" +
            "<Wire UId=\"13\"><NameCon UId=\"20\" Name=\"out\" /><NameCon UId=\"30\" Name=\"in\" /></Wire>" +
            "<Wire UId=\"14\"><IdentCon UId=\"3\" /><NameCon UId=\"30\" Name=\"operand\" /></Wire>" +
            "</Wires></FlgNet>");
        failures += Check("defect 3: a comparison box names its operands, constants included",
            box.Contains("(=) Q   <-  [Eq ActMode, 7]", StringComparison.Ordinal));

        string timer = RenderOf(
            "<FlgNet><Parts>" +
            "<Part Name=\"TON\" UId=\"40\"><Instance Scope=\"LocalVariable\" UId=\"41\">" +
            "<Component Name=\"S_IEC_Timer\" AccessModifier=\"Array\"><Access Scope=\"LiteralConstant\"><Constant><ConstantType>DInt</ConstantType>" +
            "<ConstantValue>0</ConstantValue></Constant></Access></Component></Instance></Part>" +
            "<Part Name=\"Coil\" UId=\"30\" />" +
            "<Access Scope=\"LocalVariable\" UId=\"3\"><Symbol><Component Name=\"Done\" /></Symbol></Access>" +
            "</Parts><Wires>" +
            "<Wire UId=\"10\"><Powerrail /><NameCon UId=\"40\" Name=\"en\" /></Wire>" +
            "<Wire UId=\"13\"><NameCon UId=\"40\" Name=\"Q\" /><NameCon UId=\"30\" Name=\"in\" /></Wire>" +
            "<Wire UId=\"14\"><IdentCon UId=\"3\" /><NameCon UId=\"30\" Name=\"operand\" /></Wire>" +
            "</Wires></FlgNet>");
        failures += Check("defect 1: a timer instance keeps its array index in the rung view",
            timer.Contains("[TON S_IEC_Timer[0]]", StringComparison.Ordinal));

        // N4: an edge contact carries a memory bit that is not its operand.
        string edge = RenderOf(
            "<FlgNet><Parts>" +
            "<Part Name=\"PContact\" UId=\"50\" /><Part Name=\"Coil\" UId=\"30\" />" +
            "<Access Scope=\"LocalVariable\" UId=\"1\"><Symbol><Component Name=\"Btn\" /></Symbol></Access>" +
            "<Access Scope=\"LocalVariable\" UId=\"2\"><Symbol><Component Name=\"Mem\" /></Symbol></Access>" +
            "<Access Scope=\"LocalVariable\" UId=\"3\"><Symbol><Component Name=\"Q\" /></Symbol></Access>" +
            "</Parts><Wires>" +
            "<Wire UId=\"10\"><Powerrail /><NameCon UId=\"50\" Name=\"in\" /></Wire>" +
            "<Wire UId=\"11\"><IdentCon UId=\"1\" /><NameCon UId=\"50\" Name=\"operand\" /></Wire>" +
            "<Wire UId=\"12\"><IdentCon UId=\"2\" /><NameCon UId=\"50\" Name=\"bit\" /></Wire>" +
            "<Wire UId=\"13\"><NameCon UId=\"50\" Name=\"out\" /><NameCon UId=\"30\" Name=\"in\" /></Wire>" +
            "<Wire UId=\"14\"><IdentCon UId=\"3\" /><NameCon UId=\"30\" Name=\"operand\" /></Wire>" +
            "</Wires></FlgNet>");
        failures += Check("N4: an edge contact names its instruction and its memory bit",
            edge.Contains("PContact(Btn, mem=Mem)", StringComparison.Ordinal));

        // Box flow: the written variable is the wire's SOURCE (N3), so direction must come from the pin.
        string move = RenderOf(
            "<FlgNet><Parts>" +
            "<Part Name=\"Move\" UId=\"60\" />" +
            "<Access Scope=\"LocalVariable\" UId=\"1\"><Symbol><Component Name=\"Src\" /></Symbol></Access>" +
            "<Access Scope=\"LocalVariable\" UId=\"2\"><Symbol><Component Name=\"Dst\" /></Symbol></Access>" +
            "</Parts><Wires>" +
            "<Wire UId=\"10\"><Powerrail /><NameCon UId=\"60\" Name=\"en\" /></Wire>" +
            "<Wire UId=\"11\"><IdentCon UId=\"1\" /><NameCon UId=\"60\" Name=\"in\" /></Wire>" +
            "<Wire UId=\"12\"><NameCon UId=\"60\" Name=\"out1\" /><IdentCon UId=\"2\" /></Wire>" +
            "</Wires></FlgNet>");
        failures += Check("box flow: a Move reads as 'source -> target'",
            move.Contains("[Move Src -> Dst]", StringComparison.Ordinal));

        // N2: an instance may combine an array index with a nested member. The old renderer walked
        // Descendants(), which pulled the index expression's own Component in and lost the index;
        // the expected text is the one a reader would write.
        XElement nested = XElement.Parse(
            "<Instance Scope=\"LocalVariable\" UId=\"38\">" +
            "<Component Name=\"statProductData\" AccessModifier=\"Array\">" +
            "<Access Scope=\"LiteralConstant\"><Constant><ConstantType>DInt</ConstantType>" +
            "<ConstantValue>1</ConstantValue></Constant></Access></Component>" +
            "<Component Name=\"CoolingTime\" /></Instance>");
        failures += Check("N2: an instance keeps its index when it also has a nested member",
            string.Equals(
                ProgramBlockLogicYamlWriter.FlgNetContext.FormatInstance(nested),
                "statProductData[1].CoolingTime",
                StringComparison.Ordinal));

        XElement siblings = XElement.Parse(
            "<Instance Scope=\"GlobalVariable\" UId=\"25\">" +
            "<Component Name=\"PC\" /><Component Name=\"T_Acces_Request\" /></Instance>");
        failures += Check("N2: sibling instance segments are joined with a dot",
            string.Equals(
                ProgramBlockLogicYamlWriter.FlgNetContext.FormatInstance(siblings),
                "PC.T_Acces_Request",
                StringComparison.Ordinal));

        // N1: an instance call is named by its instance DB, not by its block type.
        XElement callUnit = XElement.Parse(
            "<SW.Blocks.CompileUnit ID=\"1\"><AttributeList><NetworkSource>" +
            "<FlgNet xmlns=\"http://www.siemens.com/automation/Openness/SW/NetworkSource/FlgNet/v4\"><Parts>" +
            "<Call UId=\"70\"><CallInfo Name=\"Switch\" BlockType=\"FB\">" +
            "<Instance Scope=\"GlobalVariable\" UId=\"71\"><Component Name=\"FLCurtain_PC_DB\" /></Instance>" +
            "<Parameter Name=\"Input\" Section=\"Input\" Type=\"Bool\" />" +
            "</CallInfo></Call>" +
            "<Access Scope=\"GlobalVariable\" UId=\"1\"><Symbol><Component Name=\"IS_F_LCurtain\" /></Symbol></Access>" +
            "</Parts><Wires>" +
            "<Wire UId=\"10\"><Powerrail /><NameCon UId=\"70\" Name=\"en\" /></Wire>" +
            "<Wire UId=\"11\"><IdentCon UId=\"1\" /><NameCon UId=\"70\" Name=\"Input\" /></Wire>" +
            "</Wires></FlgNet></NetworkSource></AttributeList></SW.Blocks.CompileUnit>");
        string callLogic = string.Join("\n", ProgramBlockLogicYamlWriter.TranslateStatementsOf(callUnit));
        failures += Check("N1: an instance call is named by its instance, not its block type",
            callLogic.Contains("FLCurtain_PC_DB(Input := IS_F_LCurtain)", StringComparison.Ordinal) &&
            !callLogic.Contains("Switch(", StringComparison.Ordinal));

        Console.WriteLine(failures == 0 ? "[ok] rung invariants detect what they claim to detect" : $"[FAIL] rung invariant detectors: {failures} failed");
        return failures;
    }

    // ---- helpers ----------------------------------------------------------------------------

    private static int Check(string name, bool passed)
    {
        if (!passed)
        {
            Console.WriteLine($"[FAIL] {name}");
            return 1;
        }

        return 0;
    }

    private static FlgNetworkGraph GraphOf(string flgNetXml) => FlgNetworkGraph.Build(XElement.Parse(flgNetXml));

    private static string RenderOf(string flgNetXml)
    {
        FlgNetworkGraph graph = GraphOf(flgNetXml);
        return LadderText.Render(graph, SeriesParallelReducer.Reduce(graph));
    }

    private static IEnumerable<RungPath> AllPaths(RungModel rung) =>
        rung.Coils.SelectMany(coil => coil.Paths).Concat(rung.OpenEnds);

    /// <summary>Renders an Instance the way the spec says it should read: component chain, each array index.</summary>
    private static string RenderInstanceChain(XElement parent)
    {
        var segments = new List<string>();
        foreach (XElement component in parent.Elements().Where(IsComponent))
        {
            string name = ((string?)component.Attribute("Name"))?.Trim() ?? string.Empty;
            if (string.Equals((string?)component.Attribute("AccessModifier"), "Array", StringComparison.OrdinalIgnoreCase))
            {
                string[] indexes = component
                    .Elements()
                    .Where(element => element.Name.LocalName == "Access")
                    .Select(ProgramBlockLogicYamlWriter.FlgNetContext.GetAccessValue)
                    .Where(value => value.Length > 0)
                    .ToArray();
                if (indexes.Length > 0)
                {
                    name += "[" + string.Join(", ", indexes) + "]";
                }
            }

            string rest = RenderInstanceChain(component);
            segments.Add(rest.Length == 0 ? name : name + "." + rest);
        }

        return string.Join(".", segments);
    }

    /// <summary>Maps a Part or Call UId to its Instance UId: a call's pins are owned by both.</summary>
    private static Dictionary<string, string> InstanceOwners(XElement flgNet)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (XElement element in flgNet.Descendants().Where(element => element.Name.LocalName is "Part" or "Call"))
        {
            XElement? instance = element.Elements().FirstOrDefault(child => child.Name.LocalName == "Instance");
            string uid = ProgramBlockLogicYamlWriter.FlgNetContext.GetUid(element);
            string instanceUid = instance == null ? string.Empty : ProgramBlockLogicYamlWriter.FlgNetContext.GetUid(instance);
            if (uid.Length > 0 && instanceUid.Length > 0)
            {
                map[uid] = instanceUid;
            }
        }

        return map;
    }

    /// <summary>The sorted operand texts wired into a box (or its instance): what distinguishes it.</summary>
    private static string Signature(FlgNetworkGraph graph, Dictionary<string, string> owners, string elementId)
    {
        var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { elementId };
        if (owners.TryGetValue(elementId, out string? instanceUid))
        {
            ids.Add(instanceUid);
        }

        var operands = new SortedSet<string>(StringComparer.Ordinal);
        foreach (FlgWire wire in graph.Wires)
        {
            if (wire.SourceElementId == null || !wire.Targets.Any(target => ids.Contains(target.ElementId)))
            {
                continue;
            }

            FlgElement? source = graph.Find(wire.SourceElementId);
            if (source is { Kind: FlgElementKind.Access })
            {
                operands.Add(source.Operand ?? string.Empty);
            }
        }

        return string.Join("|", operands);
    }

    private static void Record(
        Dictionary<string, (long Networks, long Items)> totals,
        Dictionary<string, List<string>> examples,
        string key,
        string where,
        IReadOnlyList<string> items)
    {
        if (items.Count == 0)
        {
            return;
        }

        (long networks, long count) = totals[key];
        totals[key] = (networks + 1, count + items.Count);
        if (examples[key].Count < 10)
        {
            examples[key].Add($"{where}: {string.Join("; ", items.Take(4))}");
        }
    }
}
