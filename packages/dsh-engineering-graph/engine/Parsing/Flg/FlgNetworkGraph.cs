// The LAD/FBD element graph of one network: elements, pins and wires.
//
// WHY THIS EXISTS
// ---------------
// The existing translator (ProgramBlockLogicYamlWriter) turns a network into a flat list of
// boolean statements. That is a good answer to "what does this rung compute", but it throws
// away the topology: which contact sits in which parallel branch, which coil hangs off a
// fan-out, what order the elements appear in. Humans read LAD *as* that topology, so the
// model below keeps it. Phase 1 of docs/lad-understanding-plan.md.
//
// Term map (matches how Openness writes FlgNet, and what
// docs/research/lad-corpus-inventory.md counted in real exports):
//   <Access>   a variable/constant/label -> FlgElementKind.Access (Operand = symbol text)
//   <Part>     an instruction            -> Contact / Coil / SetCoil / ResetCoil / OrBox / Box
//   <Call>     a block call              -> FlgElementKind.Call (Operand = instance DB name)
//   <Instance> the instance of a Call    -> FlgElementKind.Instance (also a pin owner)
//   <Wire>     one connection            -> FlgWire (one source, 0..n targets: this is fan-out)
//   <OpenCon>  an open branch end        -> not an element: it says "this end goes nowhere"
//
// TWO RULES THAT CAME FROM REAL EXPORTS, NOT FROM THE SPEC TEXT
// -------------------------------------------------------------
// 1. A <Call>'s pin directions are declared, not guessable: <Parameter Name="FaultCode"
//    Section="Output"/>. "FaultCode" is neither an input-looking nor output-looking name, so the
//    name-based table in FlgPinRoles would call it an input and reverse the wire. Call and
//    Instance pins are therefore resolved from the declaration first.
// 2. <OpenCon UId="40"/> references an arbitrary open-connector id, NOT an element. Treating it
//    as a dangling reference made 20 networks in the reference project look broken.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Xml.Linq;

namespace EngineeringGraph.Engine;

/// <summary>What an entry under <c>&lt;Parts&gt;</c> is, as far as topology matters.</summary>
public enum FlgElementKind
{
    /// <summary>A variable, constant or label reference (the operand of a contact/coil/box pin).</summary>
    Access,

    /// <summary>Open/normally-closed/edge contact: a series element with <c>in</c>/<c>out</c>.</summary>
    Contact,

    /// <summary>Plain coil <c>(=)</c>.</summary>
    Coil,

    /// <summary>Set coil <c>(S)</c>.</summary>
    SetCoil,

    /// <summary>Reset coil <c>(R)</c>.</summary>
    ResetCoil,

    /// <summary>OR box (<c>Part Name="O"</c> with a <c>Card</c> cardinality).</summary>
    OrBox,

    /// <summary>Any other instruction box (Move, comparison, timer, arithmetic, alarm, ...).</summary>
    Box,

    /// <summary>A block call.</summary>
    Call,

    /// <summary>
    /// The instance of a block call or an instruction box. Owns pins of its own (TIA wires the
    /// call's <c>en</c> on the Call and the instance's <c>in</c> on the Instance), so it has to be
    /// an element or every such wire dangles.
    /// </summary>
    Instance
}

/// <summary>One node of the graph. <see cref="Id"/> is the SimaticML UId, unique within the network.</summary>
public sealed record FlgElement(
    string Id,
    FlgElementKind Kind,
    string Name,
    string? Operand,
    bool Negated,
    int Order);

/// <summary>The element+pin a wire points at.</summary>
public sealed record FlgWireTarget(string ElementId, string PinName);

/// <summary>
/// One <c>&lt;Wire&gt;</c>. A wire has at most one source (an element pin, the power rail, or
/// nothing when both ends are open) and any number of targets: several targets on one wire is how
/// LAD expresses a branch, not a repeat of the source. TIA rejects the same source on two wires
/// ("used multiple times at the cables", measured in M0/E3a).
/// </summary>
public sealed record FlgWire(
    string Id,
    string? SourceElementId,
    string? SourcePinName,
    bool FromPowerRail,
    bool IsOpen,
    IReadOnlyList<FlgWireTarget> Targets);

/// <summary>
/// The element graph of one network, plus the raw counts needed to prove the parse did not drop
/// anything (phase 1 acceptance) and any structural problems found.
/// </summary>
public sealed class FlgNetworkGraph
{
    private readonly Dictionary<string, FlgElement> _elements;
    private readonly Dictionary<string, Dictionary<string, FlgPinRole>> _declaredPins;
    private readonly Dictionary<(string ElementId, string PinName), List<FlgWire>> _incoming;

    private FlgNetworkGraph(
        IReadOnlyList<FlgElement> elements,
        IReadOnlyList<FlgWire> wires,
        IReadOnlyList<string> diagnostics,
        FlgCounts counts,
        Dictionary<string, Dictionary<string, FlgPinRole>> declaredPins)
    {
        Elements = elements;
        Wires = wires;
        Diagnostics = diagnostics;
        Counts = counts;
        _declaredPins = declaredPins;

        _elements = new Dictionary<string, FlgElement>(StringComparer.OrdinalIgnoreCase);
        foreach (FlgElement element in elements)
        {
            _elements[element.Id] = element;
        }

        _incoming = new Dictionary<(string, string), List<FlgWire>>();
        foreach (FlgWire wire in wires)
        {
            foreach (FlgWireTarget target in wire.Targets)
            {
                var key = (target.ElementId, target.PinName);
                if (!_incoming.TryGetValue(key, out List<FlgWire>? list))
                {
                    list = new List<FlgWire>();
                    _incoming[key] = list;
                }

                list.Add(wire);
            }
        }
    }

    public IReadOnlyList<FlgElement> Elements { get; }

    public IReadOnlyList<FlgWire> Wires { get; }

    /// <summary>Structural problems found while parsing. Empty means a clean network.</summary>
    public IReadOnlyList<string> Diagnostics { get; }

    /// <summary>How much of the XML the graph claims to represent; the conservation test uses it.</summary>
    public FlgCounts Counts { get; }

    public FlgElement? Find(string id) =>
        _elements.TryGetValue(id, out FlgElement? element) ? element : null;

    /// <summary>
    /// Direction of a pin. A declared direction (from a Call's <c>&lt;Parameter Section=...&gt;</c>)
    /// wins over the name-based table: block pin names are arbitrary.
    /// </summary>
    public FlgPinRole RoleOf(string elementId, string pinName)
    {
        if (_declaredPins.TryGetValue(elementId, out Dictionary<string, FlgPinRole>? pins) &&
            pins.TryGetValue(pinName, out FlgPinRole declared))
        {
            return declared;
        }

        return FlgPinRoles.Role(pinName);
    }

    /// <summary>The wires that feed the given pin (normally 0 or 1; 2+ is reported as a diagnostic).</summary>
    public IReadOnlyList<FlgWire> IncomingWires(string elementId, string pinName) =>
        _incoming.TryGetValue((elementId, pinName), out List<FlgWire>? list)
            ? list
            : Array.Empty<FlgWire>();

    /// <summary>
    /// Resolves the single source feeding a pin. False when the pin is unconnected, fed by more
    /// than one wire, or fed by an unknown element.
    /// </summary>
    public bool TryGetInputSource(string elementId, string pinName, out FlgWire wire)
    {
        IReadOnlyList<FlgWire> incoming = IncomingWires(elementId, pinName);
        if (incoming.Count == 1)
        {
            wire = incoming[0];
            return true;
        }

        wire = null!;
        return false;
    }

    /// <summary>
    /// The operand text behind an element: an Access's symbol, a Call's instance DB, or, for a
    /// contact/coil, the Access wired to its <c>operand</c> pin.
    /// </summary>
    public string? OperandOf(string elementId)
    {
        FlgElement? element = Find(elementId);
        if (element == null)
        {
            return null;
        }

        if (element.Kind is FlgElementKind.Access or FlgElementKind.Call or FlgElementKind.Instance)
        {
            return element.Operand;
        }

        if (!TryGetInputSource(elementId, "operand", out FlgWire wire) || wire.SourceElementId == null)
        {
            return null;
        }

        return Find(wire.SourceElementId)?.Operand;
    }

    /// <summary>Parses one <c>&lt;FlgNet&gt;</c> element. Never throws on odd input: problems land in Diagnostics.</summary>
    public static FlgNetworkGraph Build(XElement flgNet)
    {
        if (flgNet == null)
        {
            throw new ArgumentNullException(nameof(flgNet));
        }

        var diagnostics = new List<string>();
        var elements = new List<FlgElement>();
        var seenIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var declaredPins = new Dictionary<string, Dictionary<string, FlgPinRole>>(StringComparer.OrdinalIgnoreCase);

        int accessCount = 0;
        int partCount = 0;
        int callCount = 0;
        int instanceCount = 0;
        int wireCount = 0;
        int negatedCount = 0;

        // ---- pass 1: elements -------------------------------------------------------------
        var ordered = flgNet
            .Descendants()
            .Where(element =>
                element.Name.LocalName == "Access" ||
                element.Name.LocalName == "Part" ||
                element.Name.LocalName == "Call" ||
                element.Name.LocalName == "Instance")
            .Select((element, index) => new { Element = element, Order = index })
            .ToArray();

        foreach (var item in ordered)
        {
            string uid = ProgramBlockLogicYamlWriter.FlgNetContext.GetUid(item.Element);
            if (string.IsNullOrWhiteSpace(uid))
            {
                diagnostics.Add("flg_missing_uid: an element has no UId and was skipped.");
                continue;
            }

            string localName = item.Element.Name.LocalName;
            string name;
            string? operand = null;
            FlgElementKind kind;
            bool negated = false;

            if (localName == "Access")
            {
                accessCount++;
                kind = FlgElementKind.Access;
                name = "Access";
                operand = ProgramBlockLogicYamlWriter.FlgNetContext.GetAccessValue(item.Element);
            }
            else if (localName == "Call")
            {
                callCount++;
                kind = FlgElementKind.Call;
                XElement? callInfo = item.Element.Elements().FirstOrDefault(element => element.Name.LocalName == "CallInfo");
                name = ((string?)callInfo?.Attribute("Name"))?.Trim() ?? "Call";
                operand = NameOfChildInstance(item.Element);

                // Parameters carry the authoritative pin directions (see the file header).
                Dictionary<string, FlgPinRole> pins = DeclaredPins(callInfo);
                if (pins.Count > 0)
                {
                    declaredPins[uid] = pins;
                }
            }
            else if (localName == "Instance")
            {
                instanceCount++;
                kind = FlgElementKind.Instance;
                name = "Instance";
                operand = FirstComponentName(item.Element);

                // A call's instance is itself a pin owner ("in"/"en" land on it), and the same
                // declarations apply to it.
                XElement? ownerCall = item.Element.Ancestors().FirstOrDefault(element => element.Name.LocalName == "Call");
                XElement? ownerInfo = ownerCall?.Elements().FirstOrDefault(element => element.Name.LocalName == "CallInfo");
                Dictionary<string, FlgPinRole> pins = DeclaredPins(ownerInfo);
                if (pins.Count > 0)
                {
                    declaredPins[uid] = pins;
                }
            }
            else
            {
                partCount++;
                name = ((string?)item.Element.Attribute("Name"))?.Trim() ?? string.Empty;
                kind = ClassifyPart(name);
                // Negated pins, not negated parts: a box can carry several
                // (<Negated Name="operand"/>). The conservation test compares this against the
                // raw <Negated> count in the network, so the unit has to match.
                int negatedPins = item.Element
                    .Descendants()
                    .Count(element => element.Name.LocalName == "Negated");
                negated = negatedPins > 0;
                negatedCount += negatedPins;
            }

            // A UId is one namespace across Access/Part/Call/Instance/Wire inside a network: TIA
            // reports "at least two definitions for UIds" when a Wire reuses a Part's id (measured
            // while generating the 171 patch). Record it instead of silently overwriting.
            if (seenIds.TryGetValue(uid, out string? previous))
            {
                diagnostics.Add($"flg_duplicate_uid: UId '{uid}' is defined twice ({previous} and {localName}).");
                continue;
            }

            seenIds[uid] = localName;
            elements.Add(new FlgElement(uid, kind, name, operand, negated, item.Order));
        }

        // Declared directions (Call <Parameter Section=...>) win over the name table.
        FlgPinRole Role(string elementId, string pinName) =>
            declaredPins.TryGetValue(elementId, out Dictionary<string, FlgPinRole>? declared) &&
            declared.TryGetValue(pinName, out FlgPinRole role)
                ? role
                : FlgPinRoles.Role(pinName);
        // ---- pass 2: wires ----------------------------------------------------------------
        var wires = new List<FlgWire>();
        foreach (XElement wireElement in flgNet.Descendants().Where(element => element.Name.LocalName == "Wire"))
        {
            wireCount++;
            string wireId = ProgramBlockLogicYamlWriter.FlgNetContext.GetUid(wireElement);
            if (string.IsNullOrWhiteSpace(wireId))
            {
                diagnostics.Add("flg_missing_uid: a Wire has no UId and was skipped.");
                continue;
            }

            if (seenIds.TryGetValue(wireId, out string? previous))
            {
                diagnostics.Add($"flg_duplicate_uid: UId '{wireId}' is defined twice ({previous} and Wire).");
                continue;
            }

            seenIds[wireId] = "Wire";

            bool fromPowerRail = wireElement.Descendants().Any(element => element.Name.LocalName == "Powerrail");
            bool hasOpenCon = wireElement.Descendants().Any(element => element.Name.LocalName == "OpenCon");

            var nameCons = wireElement
                .Descendants()
                .Where(element => element.Name.LocalName == "NameCon")
                .Select(element => new FlgWireTarget(
                    ((string?)element.Attribute("UId"))?.Trim() ?? string.Empty,
                    ((string?)element.Attribute("Name"))?.Trim() ?? string.Empty))
                .Where(target => target.ElementId.Length > 0 && target.PinName.Length > 0)
                .ToArray();

            var identCons = wireElement
                .Descendants()
                .Where(element => element.Name.LocalName == "IdentCon")
                .Select(element => ((string?)element.Attribute("UId"))?.Trim() ?? string.Empty)
                .Where(uid => uid.Length > 0)
                .ToArray();

            string? sourceId = null;
            string? sourcePin = null;
            bool isOpen = false;
            FlgWireTarget[] targets;

            if (fromPowerRail)
            {
                targets = nameCons;
            }
            else if (identCons.Length == 1)
            {
                sourceId = identCons[0];
                targets = nameCons;
            }
            else
            {
                // No IdentCon and no rail: the source is an output pin among the NameCons.
                FlgWireTarget[] outputPins = nameCons
                    .Where(target => Role(target.ElementId, target.PinName) == FlgPinRole.Output)
                    .ToArray();

                if (outputPins.Length == 0)
                {
                    // An instruction whose output pin name is not in the table (e.g. RESULT): a
                    // single Unknown pin alongside a known Input is the source (the same rule the
                    // statement translator uses to chain such boxes).
                    FlgWireTarget[] unknownPins = nameCons
                        .Where(target => Role(target.ElementId, target.PinName) == FlgPinRole.Unknown)
                        .ToArray();
                    if (unknownPins.Length == 1 &&
                        nameCons.Any(target => Role(target.ElementId, target.PinName) == FlgPinRole.Input))
                    {
                        outputPins = unknownPins;
                    }
                }

                if (outputPins.Length > 0)
                {
                    sourceId = outputPins[0].ElementId;
                    sourcePin = outputPins[0].PinName;
                    targets = nameCons.Except(outputPins).ToArray();
                }
                else if (hasOpenCon)
                {
                    // An open branch end: e.g. <OpenCon UId="40"/><NameCon UId="32" Name="en"/>.
                    // There is no source because the branch goes nowhere; not a problem.
                    isOpen = true;
                    targets = nameCons;
                }
                else
                {
                    diagnostics.Add($"flg_no_source: wire '{wireId}' has no resolvable source.");
                    targets = nameCons;
                }
            }

            // Every element end of the wire must be a UId this network defines. OpenCon is
            // deliberately absent from this check: its UId is an open-connector id, not an element.
            if (sourceId != null && !seenIds.ContainsKey(sourceId))
            {
                diagnostics.Add($"flg_dangling_uid: wire '{wireId}' starts at unknown UId '{sourceId}'.");
            }

            foreach (FlgWireTarget target in targets)
            {
                if (!seenIds.ContainsKey(target.ElementId))
                {
                    diagnostics.Add(
                        $"flg_dangling_uid: wire '{wireId}' ends at unknown UId '{target.ElementId}' ({target.PinName}).");
                }
            }

            wires.Add(new FlgWire(wireId, sourceId, sourcePin, fromPowerRail, isOpen, targets));
        }

        var graph = new FlgNetworkGraph(
            elements,
            wires,
            diagnostics,
            new FlgCounts(accessCount, partCount, callCount, instanceCount, wireCount, negatedCount),
            declaredPins);

        // A pin fed by two wires is not a legal LAD connection; TIA would have rejected the
        // network. Report it so the reducer never has to guess between two sources.
        foreach (FlgWire wire in wires)
        {
            foreach (FlgWireTarget target in wire.Targets)
            {
                if (graph.IncomingWires(target.ElementId, target.PinName).Count > 1)
                {
                    diagnostics.Add(
                        $"flg_multi_source: pin '{target.PinName}' of UId '{target.ElementId}' is fed by more than one wire.");
                }
            }
        }

        return graph;
    }

    /// <summary>Pin directions declared by a Call's &lt;Parameter&gt; list.</summary>
    private static Dictionary<string, FlgPinRole> DeclaredPins(XElement? callInfo)
    {
        var pins = new Dictionary<string, FlgPinRole>(StringComparer.OrdinalIgnoreCase);
        if (callInfo == null)
        {
            return pins;
        }

        foreach (XElement parameter in callInfo.Elements().Where(element => element.Name.LocalName == "Parameter"))
        {
            string pinName = ((string?)parameter.Attribute("Name"))?.Trim() ?? string.Empty;
            string section = ((string?)parameter.Attribute("Section"))?.Trim() ?? string.Empty;
            if (pinName.Length == 0)
            {
                continue;
            }

            // InOut is read and written by the callee. Treat it as an input for topology purposes
            // (it is fed by a wire); recording the distinction is phase 5's job.
            pins[pinName] = section switch
            {
                "Output" => FlgPinRole.Output,
                "Return" => FlgPinRole.Output,
                "Input" => FlgPinRole.Input,
                "InOut" => FlgPinRole.Input,
                _ => FlgPinRole.Unknown
            };
        }

        return pins;
    }

    private static string? NameOfChildInstance(XElement call)
    {
        XElement? instance = call.Descendants().FirstOrDefault(element => element.Name.LocalName == "Instance");
        return instance == null ? null : FirstComponentName(instance);
    }

    private static string? FirstComponentName(XElement element)
    {
        string? name = element
            .Descendants()
            .FirstOrDefault(child => child.Name.LocalName == "Component")
            ?.Attribute("Name")
            ?.Value
            ?.Trim();
        return string.IsNullOrWhiteSpace(name) ? null : name;
    }

    private static FlgElementKind ClassifyPart(string partName)
    {
        if (FlgPinRoles.MatchesAny(partName, "Contact", "NContact", "PContact"))
        {
            return FlgElementKind.Contact;
        }

        if (string.Equals(partName, "Coil", StringComparison.OrdinalIgnoreCase))
        {
            return FlgElementKind.Coil;
        }

        if (string.Equals(partName, "SCoil", StringComparison.OrdinalIgnoreCase))
        {
            return FlgElementKind.SetCoil;
        }

        if (string.Equals(partName, "RCoil", StringComparison.OrdinalIgnoreCase))
        {
            return FlgElementKind.ResetCoil;
        }

        if (string.Equals(partName, "O", StringComparison.OrdinalIgnoreCase))
        {
            return FlgElementKind.OrBox;
        }

        return FlgElementKind.Box;
    }
}

/// <summary>
/// How many entries the XML held versus what the graph built, so a parse that silently drops nodes
/// is caught by a test instead of by a reader who notices a missing contact.
/// </summary>
public sealed record FlgCounts(
    int Accesses,
    int Parts,
    int Calls,
    int Instances,
    int Wires,
    int Negated)
{
    public int Elements => Accesses + Parts + Calls + Instances;
}
