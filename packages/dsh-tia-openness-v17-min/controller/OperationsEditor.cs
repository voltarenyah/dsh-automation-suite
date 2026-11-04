using System;
using System.Collections.Generic;
using Siemens.Engineering;
using Siemens.Engineering.SW;
using Siemens.Engineering.SW.Blocks;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>
    /// The one operation whose effect is a TIA Portal <em>UI</em> action rather
    /// than a project or file change: opening blocks in the block editor.
    ///
    /// The API behind it is <see cref="IShowable.ShowInEditor"/> — an interface
    /// of <c>Siemens.Engineering</c> that <c>PlcBlock</c> implements in V17.
    /// There is no batch member: one call shows one object, so "open these ten
    /// blocks" is ten calls, and the operation exists to do that loop in one
    /// request while reporting each block separately.
    ///
    /// Measured facts this implementation depends on (V17 Openness, reflected
    /// from <c>Siemens.Engineering.dll</c> 17.0.0.0):
    ///
    /// - <c>IShowable.ShowInEditor()</c> takes no arguments and returns void;
    ///   13 types implement it, among them <c>PlcBlock</c> and every concrete
    ///   block class (<c>OB</c>, <c>FB</c>, <c>FC</c>, <c>DataBlock</c>
    ///   subclasses), plus <c>PlcTagTable</c>, <c>PlcWatchTable</c> and
    ///   <c>PlcForceTable</c>. This operation only opens blocks.
    /// - It is a UI command, so it needs a TIA Portal started with a user
    ///   interface (<see cref="OpennessHost.HasUserInterface"/>). Showing a block
    ///   of a project that was opened headless is impossible: the project belongs
    ///   to that headless instance, so the caller has to close and reopen it.
    ///
    /// The parameter and payload contract is frozen in
    /// <c>docs/EXTENDED-SURFACE.md</c> §27.
    /// </summary>
    internal sealed partial class OpennessOperations
    {
        /// <summary>
        /// How many editor tabs one request may open. TIA Portal opens one editor
        /// per block and keeps it; a request that names every block of a real
        /// project (1155 in the reference project) would bury the UI, so the
        /// ceiling is explicit and reported as <c>too_many_blocks</c>.
        /// </summary>
        public const int MaxEditorBlocks = 100;

        // ---------------------------------------------------- ShowBlocksInEditor

        private JsonObject ShowBlocksInEditor(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            List<string> requested = p.StringList("block_names");
            if (requested.Count == 0)
            {
                throw new ControllerException("invalid_params",
                    "'block_names' is required: name at least one block to open in the block editor.");
            }
            if (requested.Count > MaxEditorBlocks)
            {
                throw new ControllerException("too_many_blocks",
                    "One request may open at most " + MaxEditorBlocks + " block editors; it named "
                        + requested.Count + ". Split the list into batches.",
                    JsonObject.Of("requested", requested.Count, "limit", MaxEditorBlocks));
            }

            // Resolving the software also enforces project_not_open, and it runs
            // before the UI check so a caller without a project gets the error
            // that actually describes its situation. Checked here as well so the
            // message names THIS operation and explains the visible-window
            // requirement instead of the generic internal "ListPlcSoftware" text.
            if (!_host.HasProject)
            {
                throw new ControllerException(
                    "project_not_open",
                    "show_blocks_in_editor requires an open project. Open it with open_project and with_window=true "
                        + "(a headless project has no block editor to open), then call this tool again.",
                    JsonObject.Of("hint", "open_project with with_window=true, or adopt_open_project for a project the "
                        + "operator already opened in the TIA Portal window."));
            }

            PlcSoftwareRef software = _host.FindPlcSoftware(p.String("device_name", null), p.String("software_name", null));

            if (!_host.HasUserInterface)
            {
                throw new ControllerException(
                    "editor_unavailable",
                    "No block editor can be opened: this controller holds a TIA Portal instance without a user interface "
                        + "(the project was opened with with_window=false, so there is no window to show a block in). "
                        + "Close the project with close_project and open it again with open_project and with_window=true, "
                        + "then call this tool again.",
                    JsonObject.Of(
                        "withUserInterface", false,
                        "hint", "close_project, then open_project with with_window=true; or adopt_open_project for a project "
                            + "the operator already opened in the TIA Portal window."));
            }

            // Every name is resolved before the first editor opens: a typo must
            // not leave half of the batch open in the UI.
            List<BlockRef> all = _host.CollectBlocks(software.Software, null, true, false);
            List<BlockRef> selected = new List<BlockRef>();
            List<string> missing = new List<string>();
            List<JsonObject> ambiguous = new List<JsonObject>();
            List<string> firstAmbiguousCandidates = new List<string>();

            foreach (string raw in requested)
            {
                string value = (raw ?? string.Empty).Trim();
                if (value.Length == 0) continue;

                string groupPath;
                string name;
                OpennessHost.SplitGroupAndName(value, out groupPath, out name);
                string wantedGroup = OpennessHost.NormalizeGroupPath(groupPath);

                List<BlockRef> matches = new List<BlockRef>();
                foreach (BlockRef candidate in all)
                {
                    if (!string.Equals(candidate.Name, name, StringComparison.OrdinalIgnoreCase)) continue;
                    if (wantedGroup.Length > 0
                        && !string.Equals(OpennessHost.NormalizeGroupPath(candidate.GroupPath), wantedGroup,
                            StringComparison.OrdinalIgnoreCase)) continue;
                    matches.Add(candidate);
                }

                if (matches.Count == 0)
                {
                    missing.Add(value);
                    continue;
                }

                if (matches.Count > 1)
                {
                    // TIA allows the same block name in different user groups.
                    // Opening "the first one" would show a block the caller did
                    // not ask for, which is exactly the kind of silent mismatch a
                    // UI operation must not produce.
                    List<string> candidates = new List<string>();
                    foreach (BlockRef match in matches) candidates.Add(match.GroupPath + match.Name);
                    if (ambiguous.Count == 0) firstAmbiguousCandidates.AddRange(candidates);
                    ambiguous.Add(JsonObject.Of("requested", value, "candidates", candidates));
                    continue;
                }

                bool seen = false;
                foreach (BlockRef existing in selected)
                {
                    if (ReferenceEquals(existing.Block, matches[0].Block)) { seen = true; break; }
                }
                if (!seen) selected.Add(matches[0]);
            }

            if (missing.Count > 0 || ambiguous.Count > 0)
            {
                JsonObject details = new JsonObject();
                if (missing.Count > 0) details.Add("missing", missing);
                if (ambiguous.Count > 0) details.Add("ambiguous", ambiguous);
                details.Add("availableCount", all.Count);
                if (all.Count <= 40) details.Add("available", OpennessHost.AvailableNames(all, delegate (BlockRef b) { return b.GroupPath + b.Name; }));

                if (missing.Count > 0)
                {
                    throw new ControllerException("block_not_found",
                        "These blocks were not found: " + string.Join(", ", missing.ToArray())
                            + ". The project has " + all.Count + " block(s); use list_plc_objects to get their names.",
                        details);
                }

                throw new ControllerException("block_ambiguous",
                    "These names match more than one block: " + string.Join(", ", firstAmbiguousCandidates.ToArray())
                        + ". Qualify them with their user group, for example 'Group/Name'.",
                    details);            }

            if (selected.Count == 0)
            {
                throw new ControllerException("invalid_params",
                    "'block_names' contained no usable block name.");
            }

            progress.Report("editor",
                "Opening " + selected.Count + " block editor(s) in " + software.DisplayName + ".");
            log.Info("Showing " + selected.Count + " block(s) in the TIA Portal block editor, one call per block "
                + "(IShowable.ShowInEditor).");

            List<JsonObject> items = new List<JsonObject>();
            List<JsonObject> failed = new List<JsonObject>();

            foreach (BlockRef block in selected)
            {
                string label = block.GroupPath + block.Name;
                try
                {
                    IShowable showable = block.Block as IShowable;
                    if (showable == null)
                    {
                        failed.Add(EditorFailure(block, "editor_not_supported",
                            Text.Quote(label) + " is a " + BlockKindOf(block.Block)
                                + " and does not implement IShowable, so TIA has no editor to open for it."));
                        continue;
                    }

                    showable.ShowInEditor();
                    // The same shape list_plc_objects reports (name, group,
                    // language, number, dates) plus the concrete block kind.
                    JsonObject item = OpennessHost.DescribeBlock(block);
                    item.Add("kind", BlockKindOf(block.Block));
                    items.Add(item);

                    // Not a project change, but the operator-visible effect of the
                    // request, and the change log is what a UI consumer reads.
                    changes.Add("block", label, "shown_in_editor", "TIA Portal block editor");
                }
                catch (Exception ex)
                {
                    log.Warning("Showing " + Text.Quote(label) + " in the block editor failed: " + ex.Message);
                    failed.Add(EditorFailure(block, "editor_show_failed", Text.Quote(label) + ": " + ex.Message));
                }
            }

            JsonObject data = new JsonObject();
            data.Add("device", software.DeviceName);
            data.Add("software", software.SoftwareName);
            data.Add("withUserInterface", true);
            data.Add("requestedCount", requested.Count);
            data.Add("count", items.Count);
            data.Add("opened", items);
            data.Add("failedCount", failed.Count);
            data.Add("failed", failed);
            data.Add("maxEditorBlocks", MaxEditorBlocks);
            data.Add("dryRun", false);

            if (items.Count == 0)
            {
                // Every single block failed: that is not a partial success.
                string reason = failed.Count > 0 ? Convert.ToString(failed[0]["message"]) : "no block was shown";
                throw new ControllerException("editor_show_failed",
                    "No block editor could be opened: " + reason,
                    JsonObject.Of("failed", failed, "withUserInterface", true),
                    data);
            }

            if (failed.Count > 0)
            {
                log.Warning(failed.Count + " of " + selected.Count + " block editor(s) could not be opened (see data.failed).");
            }

            return data;
        }

        private static JsonObject EditorFailure(BlockRef block, string code, string message)
        {
            JsonObject item = new JsonObject();
            item.Add("name", block.Name);
            item.AddIfPresent("group", block.GroupPath);
            item.Add("kind", BlockKindOf(block.Block));
            item.Add("code", code);
            item.Add("message", message);
            return item;
        }

        /// <summary>
        /// The concrete block kind. <c>InstanceDB</c> and <c>ArrayDB</c> derive
        /// from <c>DataBlock</c>, so they are tested first; <c>CodeBlock</c> is
        /// the base of OB/FB/FC and comes last before falling back to the CLR type.
        /// </summary>
        private static string BlockKindOf(PlcBlock block)
        {
            if (block == null) return "unknown";
            if (block is OB) return "OB";
            if (block is FB) return "FB";
            if (block is FC) return "FC";
            if (block is InstanceDB) return "InstanceDB";
            if (block is ArrayDB) return "ArrayDB";
            if (block is GlobalDB) return "GlobalDB";
            if (block is DataBlock) return "DataBlock";
            if (block is CodeBlock) return "CodeBlock";
            return block.GetType().Name;
        }
    }
}
