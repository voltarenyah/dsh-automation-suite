// ---------------------------------------------------------------------------
// Vendored into dsh-engineering-graph (DSH plugin family 3) from:
//   C:\Users\Ansel\orca\projects\AgentAssistPlcDev\src\Mcp.Knowledge\Import\ComponentImport.cs
//   on 2026-10-15.
//
// Adaptations applied by this vendoring pass (nothing else was touched):
//   * namespace Mcp.Knowledge.<Graph|Parsing|Import>  ->  EngineeringGraph.Engine
//     (flattened to ONE namespace, following family 1's TiaOpennessV17Min.Controller,
//      which uses a single flat namespace for its whole executable)
//   * the now-redundant `using Mcp.Knowledge.*;` lines were removed
//   * the temp-directory segment "Mcp.Knowledge" -> "EngineeringGraph.Engine"
// The origin's own header below is kept verbatim.
// Naming rule: docs/decisions.md D17.
// ---------------------------------------------------------------------------
namespace EngineeringGraph.Engine;

public sealed record ComponentImport(
    string ComponentKey,
    string RelativePath,
    string ContentHash,
    IReadOnlySet<string> NodeIds,
    IReadOnlySet<string> EdgeIds);

public sealed class ComponentIdentityMismatchException : Exception
{
    public ComponentIdentityMismatchException(string message)
        : base(message)
    {
    }

    public string Code => "COMPONENT_IDENTITY_MISMATCH";
}

public sealed class ComponentProvenanceUnavailableException : Exception
{
    public ComponentProvenanceUnavailableException(string message)
        : base(message)
    {
    }

    public string Code => "COMPONENT_PROVENANCE_REBUILD_REQUIRED";
}
