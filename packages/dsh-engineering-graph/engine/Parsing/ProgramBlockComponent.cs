// ---------------------------------------------------------------------------
// Vendored into dsh-engineering-graph (DSH plugin family 3) from:
//   C:\Users\Ansel\orca\projects\AgentAssistPlcDev\src\Mcp.Knowledge\Parsing\ProgramBlockComponent.cs
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
// Ported from PlcSourceExporter (src/PlcSourceExporter.Core/ProgramBlockCallGraph.cs) — adapted for mcp-knowledge; keep changes minimal to ease future re-syncs.
// Only the ProgramBlockComponent record class ports; the call-graph builder and the
// metadata.json-backed catalog stay behind (replaced by a root-element crawler in stage 2).
namespace EngineeringGraph.Engine;

public sealed class ProgramBlockComponent
{
    public ProgramBlockComponent(string name, string category, string sourcePath, string exportedFile)
    {
        Name = name;
        Category = category;
        SourcePath = sourcePath;
        ExportedFile = exportedFile;
    }

    public string Name { get; }

    public string Category { get; }

    public string SourcePath { get; }

    public string ExportedFile { get; }
}
