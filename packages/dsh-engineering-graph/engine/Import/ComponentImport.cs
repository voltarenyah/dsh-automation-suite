// ---------------------------------------------------------------------------
// Vendored into dsh-engineering-graph from:
//   C:\Users\Ansel\orca\projects\AgentAssistPlcDev\src\Mcp.Knowledge\Import\ComponentImport.cs
//   on 2026-10-15.
//
// Adaptations applied by this vendoring pass (nothing else was touched):
//   * namespace Mcp.Knowledge.<Graph|Parsing|Import>  ->  EngineeringGraph.Engine
//     (flattened to ONE namespace, following the TIA Openness plugin's TiaOpennessV17Min.Controller,
//      which uses a single flat namespace for its whole executable)
//   * the now-redundant `using Mcp.Knowledge.*;` lines were removed
//   * the temp-directory segment "Mcp.Knowledge" -> "EngineeringGraph.Engine"
// The origin's own header below is kept verbatim.
// Naming rule: docs/decisions.md D17.
// ---------------------------------------------------------------------------
using System.Security.Cryptography;

namespace EngineeringGraph.Engine;

/// <summary>
/// The identity rules a component import must satisfy for provenance-driven
/// incremental updates to work.
///
/// `ComponentProvenanceStore.Replace` validates that the replacement's component key
/// AND relative path are exactly the ones already stored, so every importer has to
/// derive them the same way. This type is where those two derivations are stated:
/// </summary>
public static class ComponentKeys
{
    /// <summary>
    /// Key for a component identified by its device-relative path, the fallback the
    /// legacy manifest already uses when an entry carries no `id`.
    ///
    /// Path-based on purpose: renaming the <em>block</em> inside one XML file keeps
    /// the path, so the identity still matches and the old nodes are replaced by the
    /// new ones instead of the update being refused. A block whose file *moves* is a
    /// different component and requires a full rebuild, which is the conservative
    /// answer rather than guessing which two rows are the same object.
    /// </summary>
    public static string ForPath(string relativePath) => "path:" + relativePath;

    /// <summary>
    /// Content hash of one source file: SHA-256 of the file bytes, lowercase hex.
    ///
    /// Deliberately the same rule the legacy manifest and the crawler use, so the
    /// `content_hash` column means one thing across layouts. It is a change key, not
    /// a normalized identity: a fresh export bumps `&lt;DocumentInfo&gt;&lt;Created&gt;`
    /// and therefore the hash even when the logic is identical. That is acceptable
    /// here because the update operation is driven by an explicit `changedPaths`
    /// list, not by comparing hashes; the column is what a caller can read to see
    /// that a replacement really landed.
    /// </summary>
    public static string ContentHashOf(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}

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
