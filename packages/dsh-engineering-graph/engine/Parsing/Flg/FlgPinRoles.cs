// Pin-name classification for LAD/FBD networks (FlgNet).
//
// WHY THIS FILE EXISTS
// --------------------
// The pin-role tables live inside ProgramBlockLogicYamlWriter (IsExplicitInputPin /
// IsInputPin / IsOutputPin). The element-graph model (FlgNetworkGraph) needs the same
// classification, and a second copy of those lists would drift: a pin added to one copy
// and not the other silently changes which end of a wire counts as the source, which is
// exactly the bug that makes a topology look wrong.
//
// So the writer's methods were promoted to `internal` and this class only delegates.
// There is ONE rule set. Do not reintroduce a name list here.
using System;

namespace EngineeringGraph.Engine;

/// <summary>Direction of a pin for topology purposes.</summary>
public enum FlgPinRole
{
    Input,
    Output,
    Unknown
}

internal static class FlgPinRoles
{
    /// <summary>
    /// Input pins by name, without the default-true fallthrough of <see cref="IsInputPin"/>.
    /// Pins of unlisted instructions stay Unknown, which lets the graph treat them as sources.
    /// </summary>
    internal static bool IsExplicitInputPin(string pinName) =>
        ProgramBlockLogicYamlWriter.FlgNetContext.IsExplicitInputPin(pinName);

    /// <summary>
    /// Input pins including the default-true fallthrough: anything that is not an output pin
    /// and not <c>operand</c>/<c>bit</c> counts as an input.
    /// </summary>
    internal static bool IsInputPin(string pinName) =>
        ProgramBlockLogicYamlWriter.FlgNetContext.IsInputPin(pinName);

    internal static bool IsOutputPin(string pinName) =>
        ProgramBlockLogicYamlWriter.FlgNetContext.IsOutputPin(pinName);

    internal static FlgPinRole Role(string pinName)
    {
        if (IsOutputPin(pinName))
        {
            return FlgPinRole.Output;
        }

        return IsExplicitInputPin(pinName) ? FlgPinRole.Input : FlgPinRole.Unknown;
    }

    internal static bool MatchesAny(string value, params string[] candidates) =>
        ProgramBlockLogicYamlWriter.MatchesAny(value, candidates);
}
