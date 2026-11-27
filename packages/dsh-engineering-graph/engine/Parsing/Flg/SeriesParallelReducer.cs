// Turns one network's element graph into the rungs a reader thinks in: "which series of
// elements reaches this coil".
//
// WHY PATHS AND NOT A TREE
// ------------------------
// The obvious output of a "series/parallel reducer" is a tree. But LAD's topology is not a tree:
// a fan-out feeds several independent rungs, and an OR box merges several chains that started at
// the same split point. Building the tree requires walking backwards from every merge to find its
// split, and every ambiguity there becomes a guess.
//
// Enumerating the complete paths from the power rail to each terminal is unambiguous: it is what
// the PLC actually does, it needs no merge/split guessing, and it converts directly into the
// boolean expression a coil's value is computed from (OR over paths of AND over steps), which is
// what phase 3 compares against the translated statements. A ladder drawing for phase 4 comes
// from the same paths by merging shared prefixes, so nothing is lost by not building the tree
// here.
//
// WHAT THE M0 EXPERIMENTS CHANGED (docs/research/tia-lad-structure-rules.md)
// -------------------------------------------------------------------------
// Coils may sit mid-branch and be followed by more elements (E1 plain, E5 reset coil), so a coil
// is a normal pass-through step that also writes, not a forced terminal. Nested branches (E2) and
// fan-out (E4) are legal, so neither is a reason to give up on a network.
using System;
using System.Collections.Generic;
using System.Linq;

namespace EngineeringGraph.Engine;

/// <summary>One element on the way from the power rail to a terminal.</summary>
public sealed record RungStep(
    string ElementId,
    FlgElementKind Kind,
    string? Operand,
    bool Negated);

/// <summary>One complete route from the power rail to a terminal (a coil, an open end, ...).</summary>
public sealed record RungPath(
    IReadOnlyList<RungStep> Steps,
    string? TerminalElementId,
    FlgElementKind? TerminalKind,
    string? TerminalOperand,
    bool IsOpenEnd);

/// <summary>
/// Every path that reaches one coil. More than one path means the coil is an OR of them, and
/// <paramref name="Negated"/> means the coil is drawn inverted <c>-(/)</c>: it writes NOT(condition).
/// </summary>
public sealed record RungCoil(
    string ElementId,
    FlgElementKind Kind,
    string? Operand,
    IReadOnlyList<RungPath> Paths,
    bool Negated);

/// <summary>The rungs of one network, or the reason they could not be derived.</summary>
public sealed class RungModel
{
    internal RungModel(
        IReadOnlyList<RungCoil> coils,
        IReadOnlyList<RungPath> openEnds,
        bool isStructured,
        string? unstructuredReason,
        IReadOnlyList<string> notes,
        int pathCount)
    {
        Coils = coils;
        OpenEnds = openEnds;
        IsStructured = isStructured;
        UnstructuredReason = unstructuredReason;
        Notes = notes;
        PathCount = pathCount;
    }

    public IReadOnlyList<RungCoil> Coils { get; }

    /// <summary>Paths that end without a coil (EN chains, diagnostics wiring, empty branches).</summary>
    public IReadOnlyList<RungPath> OpenEnds { get; }

    public bool IsStructured { get; }

    public string? UnstructuredReason { get; }

    public IReadOnlyList<string> Notes { get; }

    public int PathCount { get; }

    /// <summary>
    /// The boolean expression behind a coil: OR over its paths, each path AND over its steps.
    /// Boxes and calls appear as an opaque step name, because their internal condition is their own
    /// network's business.
    /// </summary>
    public static string ConditionOf(RungPath path)
    {
        if (path.Steps.Count == 0)
        {
            return "TRUE";
        }

        var terms = new List<string>(path.Steps.Count);
        foreach (RungStep step in path.Steps)
        {
            string name = StepName(step);
            terms.Add(step.Negated ? "NOT " + name : name);
        }

        return string.Join(" AND ", terms);
    }

    /// <summary>
    /// The value a coil writes: OR over its paths, each path AND over its steps, inverted when the
    /// coil is drawn negated. This is the expression a reader should reason with — the "condition"
    /// alone is not the written value for a negated coil (caught by the phase-3 equivalence check on
    /// `030_Faults_Cav_A`: 34 negated contacts in series into a negated coil).
    /// </summary>
    internal static BooleanExpression ValueExpression(RungCoil coil)
    {
        var paths = new List<BooleanExpression>(coil.Paths.Count);
        foreach (RungPath path in coil.Paths)
        {
            var steps = new List<BooleanExpression>(path.Steps.Count);
            foreach (RungStep step in path.Steps)
            {
                steps.Add(BooleanExpression.OperandTerm(step.Operand ?? step.ElementId, step.Negated));
            }

            paths.Add(BooleanExpression.And(steps));
        }

        BooleanExpression condition = BooleanExpression.Or(paths);
        return coil.Negated ? BooleanExpression.Not(condition) : condition;
    }

    public static string StepName(RungStep step)
    {
        // A box or a call is opaque here: its condition lives in another network. Bracketing it
        // keeps it visibly different from a boolean operand — without the brackets a rendered
        // condition reads "A AND Eq AND B", which looks like a term but is not one.
        if (step.Kind is FlgElementKind.Box or FlgElementKind.Call)
        {
            return "[" + (string.IsNullOrWhiteSpace(step.Operand) ? step.Kind.ToString() : step.Operand) + "]";
        }

        if (!string.IsNullOrWhiteSpace(step.Operand))
        {
            return step.Operand!;
        }

        return step.ElementId;
    }
}

/// <summary>Derives the rungs of a network from its element graph.</summary>
public static class SeriesParallelReducer
{
    /// <summary>Above this many paths the enumeration is not useful to a reader; the network is reported as complex.</summary>
    public const int DefaultMaxPaths = 400;

    public static RungModel Reduce(FlgNetworkGraph graph, int maxPaths = DefaultMaxPaths)
    {
        if (graph == null)
        {
            throw new ArgumentNullException(nameof(graph));
        }

        var notes = new List<string>();

        // Rung starts: every pin fed straight from the power rail.
        var starts = graph.Wires
            .Where(wire => wire.FromPowerRail)
            .SelectMany(wire => wire.Targets)
            .ToArray();

        if (starts.Length == 0)
        {
            return Unstructured("no-powerrail", notes);
        }

        var paths = new List<RungPath>();
        foreach (FlgWireTarget start in starts)
        {
            if (paths.Count >= maxPaths)
            {
                return Unstructured("too-many-paths", notes);
            }

            Walk(graph, start.ElementId, new List<RungStep>(), new HashSet<string>(StringComparer.OrdinalIgnoreCase), paths, notes, maxPaths);
        }

        var coils = new List<RungCoil>();
        var openEnds = new List<RungPath>();
        foreach (RungPath path in paths)
        {
            if (path.TerminalKind is FlgElementKind.Coil or FlgElementKind.SetCoil or FlgElementKind.ResetCoil)
            {
                RungCoil? existing = coils.FirstOrDefault(coil =>
                    string.Equals(coil.ElementId, path.TerminalElementId, StringComparison.OrdinalIgnoreCase));
                if (existing == null)
                {
                    coils.Add(new RungCoil(
                        path.TerminalElementId!,
                        path.TerminalKind!.Value,
                        path.TerminalOperand,
                        new[] { path },
                        graph.Find(path.TerminalElementId!)?.Negated ?? false));
                }
                else
                {
                    coils[coils.IndexOf(existing)] = existing with { Paths = existing.Paths.Append(path).ToArray() };
                }

                continue;
            }

            openEnds.Add(path);
        }

        return new RungModel(coils, openEnds, true, null, notes, paths.Count);
    }

    /// <summary>
    /// Follows the flow forward from one pin. <paramref name="path"/> is the prefix; the element that
    /// owns the pin is appended here, not by the caller.
    /// </summary>
    private static void Walk(
        FlgNetworkGraph graph,
        string elementId,
        List<RungStep> path,
        HashSet<string> visited,
        List<RungPath> results,
        List<string> notes,
        int maxPaths)
    {
        if (results.Count >= maxPaths)
        {
            return;
        }

        if (!visited.Add(elementId))
        {
            notes.Add($"cycle: the flow returns to '{elementId}'; the path was cut there.");
            results.Add(Terminate(path, null));
            return;
        }

        FlgElement? element = graph.Find(elementId);
        if (element == null)
        {
            // A dangling UId is already reported by the graph; do not invent a step for it.
            notes.Add($"dangling: the flow reaches unknown UId '{elementId}'.");
            results.Add(Terminate(path, null));
            visited.Remove(elementId);
            return;
        }

        var steps = new List<RungStep>(path.Count + 1);
        steps.AddRange(path);

        // Accesses and instances are operands, not flow: reaching one means the wire pointed at a
        // data pin, which is not a rung.
        if (element.Kind is FlgElementKind.Access or FlgElementKind.Instance)
        {
            notes.Add($"non-flow element '{elementId}' ({element.Kind}) sits on a rung path.");
            results.Add(new RungPath(steps, null, null, null, true));
            visited.Remove(elementId);
            return;
        }

        // Two kinds are structure, not conditions:
        //   * an OR box merges branches (its structure shows up as several paths reaching one coil);
        //   * a coil writes the RLO and passes it on unchanged (E1/E5 allow elements after it), so
        //     it is never a term of the condition that reaches it.
        if (element.Kind != FlgElementKind.OrBox && !IsCoil(element.Kind))
        {
            steps.Add(new RungStep(
                element.Id,
                element.Kind,
                OperandFor(graph, element),
                element.Negated));
        }

        FlgWireTarget[] next = Outgoing(graph, element);

        // Legal since M0/E1 (plain coil) and M0/E5 (reset coil): the rung continues past the coil.
        // Record it, because such a coil writes but is not the terminal of the path it sits on.
        if (next.Length > 0 && IsCoil(element.Kind))
        {
            notes.Add($"coil '{element.Id}' passes the rung on; the path terminates further right.");
        }

        if (next.Length == 0)
        {
            // Terminal. A coil here writes; anything else is an open end (EN chain, alarm wiring).
            results.Add(new RungPath(
                steps,
                element.Id,
                element.Kind,
                OperandFor(graph, element),
                IsCoil(element.Kind) ? false : true));

            visited.Remove(elementId);
            return;
        }

        foreach (FlgWireTarget target in next)
        {
            Walk(graph, target.ElementId, steps, visited, results, notes, maxPaths);
        }

        visited.Remove(elementId);
    }

    private static RungPath Terminate(List<RungStep> path, FlgElement? element) =>
        new(
            path.ToArray(),
            element?.Id,
            element?.Kind,
            null,
            true);

    /// <summary>
    /// The pins the flow leaves this element through. A box or call continues on its ENO/out pin;
    /// contacts, coils and OR boxes continue on <c>out</c>. Several targets on the returned wires
    /// are a fan-out, which is legal (M0/E4) and simply produces several paths.
    /// </summary>
    private static FlgWireTarget[] Outgoing(FlgNetworkGraph graph, FlgElement element)
    {
        var outgoing = graph.Wires
            .Where(wire => string.Equals(wire.SourceElementId, element.Id, StringComparison.OrdinalIgnoreCase))
            .ToArray();

        if (outgoing.Length == 0)
        {
            return Array.Empty<FlgWireTarget>();
        }

        string[] preferred = element.Kind switch
        {
            FlgElementKind.Box or FlgElementKind.Call => new[] { "eno", "out" },
            _ => new[] { "out" }
        };

        foreach (string pin in preferred)
        {
            FlgWire[] matching = outgoing
                .Where(wire => string.Equals(wire.SourcePinName, pin, StringComparison.OrdinalIgnoreCase))
                .ToArray();
            if (matching.Length > 0)
            {
                return matching.SelectMany(wire => wire.Targets).ToArray();
            }
        }

        // No named output pin (an instruction with an unlisted one): any wire leaving the element is
        // the continuation.
        return outgoing.SelectMany(wire => wire.Targets).ToArray();
    }

    /// <summary>
    /// The text a reader needs for a step. A box or call is named by its instruction/callee (its
    /// condition is its own network's business); a contact or coil by the operand wired to it.
    /// </summary>
    private static string? OperandFor(FlgNetworkGraph graph, FlgElement element) =>
        element.Kind is FlgElementKind.Box or FlgElementKind.Call
            ? element.Name
            : graph.OperandOf(element.Id);

    private static bool IsCoil(FlgElementKind kind) =>
        kind is FlgElementKind.Coil or FlgElementKind.SetCoil or FlgElementKind.ResetCoil;

    private static RungModel Unstructured(string reason, List<string> notes) =>
        new(
            Array.Empty<RungCoil>(),
            Array.Empty<RungPath>(),
            false,
            reason,
            notes,
            0);
}
