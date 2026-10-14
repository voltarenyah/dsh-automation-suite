using System;
using System.Collections.Generic;
using Siemens.Engineering;
using Siemens.Engineering.Safety;
using Siemens.Engineering.SW;
using Siemens.Engineering.SW.Blocks;
using Siemens.Engineering.SW.Types;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>
    /// The manual chapter "F-related Openness": reading and writing the two
    /// GlobalSettings actions, reading the per-CPU safety settings, and reading
    /// the F-signatures of blocks.
    ///
    /// The parameter and payload contract is frozen in
    /// <c>docs/EXTENDED-SURFACE.md</c>.
    /// </summary>
    internal sealed partial class OpennessOperations
    {
        // --------------------------------------------------------- SafetyStatus

        private JsonObject SafetyStatus(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            bool includeRuntimeGroups = p.Bool("include_runtime_groups", true);
            bool includeSettings = p.Bool("include_settings", true);
            bool withWindow = p.Bool("with_window", false);

            // The manual obtains GlobalSettings from the TIA Portal instance, so
            // the instance is started (or attached to) on demand here.
            _host.EnsurePortalStarted(withWindow, progress);

            JsonObject data = new JsonObject();

            string globalReason;
            GlobalSettings globalSettings = _host.GlobalSettingsOf(out globalReason);
            data.Add("globalSettings", _host.DescribeGlobalSettings(globalSettings, globalReason));

            PlcSoftwareRef software = null;
            if (_host.HasProject)
            {
                try
                {
                    software = _host.FindPlcSoftware(p.String("device_name", null), p.String("software_name", null));
                }
                catch (ControllerException ex)
                {
                    // A project without a usable PLC is not an F-related failure:
                    // the global settings were still reported above.
                    log.Warning("No PLC software could be selected for the F-related services: " + ex.Message);
                }
            }
            else
            {
                log.Info("No project is open, so only the TIA Portal GlobalSettings were reported.");
            }

            if (!includeSettings)
            {
                log.Info("Reported the F-related global settings only.");
                return data;
            }

            if (software == null)
            {
                JsonObject unavailable = new JsonObject();
                unavailable.Add("available", false);
                unavailable.Add("reason", _host.HasProject
                    ? "The project exposes no usable PLC software, so the per-CPU safety services cannot be queried."
                    : "No project is open, so the per-CPU safety services cannot be queried.");
                data.Add("settings", unavailable);
                data.Add("administration", unavailable);
                data.Add("runtimeGroups", new List<JsonObject>());
                return data;
            }

            data.Add("device", software.DeviceName);
            data.Add("software", software.SoftwareName);
            string administrationReason;
            SafetyAdministration administration = _host.SafetyAdministrationOf(software.Software, out administrationReason);
            data.Add("settings", _host.DescribeSafetySettings(administration, administrationReason));
            data.Add("administration", _host.DescribeSafetyAdministration(administration, includeRuntimeGroups,
                administrationReason));

            JsonObject administrationData = data["administration"] as JsonObject;
            if (administrationData != null && administrationData["runtimeGroups"] != null)
            {
                data.Add("runtimeGroups", administrationData["runtimeGroups"]);
            }
            else if (includeRuntimeGroups)
            {
                data.Add("runtimeGroups", new List<JsonObject>());
            }

            log.Info("Reported the F-related state of " + software.DisplayName + ".");
            return data;
        }

        // ----------------------------------------------------- SetSafetySettings

        private JsonObject SetSafetySettings(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            bool hasModifications = p.Has("safety_modifications_possible");
            string username = p.String("username_for_f_change_history", null);
            bool dryRun = p.Bool("dry_run", true);

            if (!hasModifications && username == null)
            {
                throw new ControllerException("invalid_params",
                    "set_safety_settings needs at least one of 'safety_modifications_possible' or "
                        + "'username_for_f_change_history'.");
            }

            bool withWindow = p.Bool("with_window", false);
            _host.EnsurePortalStarted(withWindow, progress);

            string reason;
            GlobalSettings settings = _host.GlobalSettingsOf(out reason);
            if (settings == null)
            {
                throw new ControllerException("global_settings_unavailable", reason);
            }

            bool modificationsValue = hasModifications && p.Bool("safety_modifications_possible", false);

            if (dryRun)
            {
                JsonObject before = _host.DescribeGlobalSettings(settings, null);
                JsonObject plan = new JsonObject();
                if (hasModifications)
                {
                    bool current = JsonObject.ReadBool(before, "safetyModificationsPossible", false);
                    plan.Add("safetyModificationsPossible", JsonObject.Of(
                        "before", current, "after", modificationsValue, "changed", current != modificationsValue));
                }
                if (username != null)
                {
                    string current = JsonObject.ReadString(before, "usernameForFChangeHistory", null);
                    plan.Add("usernameForFChangeHistory", JsonObject.Of(
                        "before", current, "after", username,
                        "changed", !string.Equals(current, username, StringComparison.Ordinal)));
                }
                plan.Add("wouldWrite", true);
                plan.Add("dryRun", true);
                log.Info("Dry run: the F-related global settings were not changed.");
                return plan;
            }

            progress.Report("safety", "Updating the F-related global settings.");
            JsonObject data = _host.WriteGlobalSettings(settings, hasModifications ? (bool?)modificationsValue : null,
                username);
            data.Add("dryRun", false);

            JsonObject modifications = data["safetyModificationsPossible"] as JsonObject;
            if (modifications != null && JsonObject.ReadBool(modifications, "changed", false))
            {
                changes.Add("safety", "SafetyModificationsPossible", "written",
                    JsonObject.ReadString(modifications, "before", "?") + " -> "
                        + JsonObject.ReadString(modifications, "after", "?"));
            }
            JsonObject history = data["usernameForFChangeHistory"] as JsonObject;
            if (history != null && JsonObject.ReadBool(history, "changed", false))
            {
                changes.Add("safety", "UsernameForFChangeHistory", "written");
            }
            log.Info("Updated the F-related global settings.");
            return data;
        }

        // ----------------------------------------------------- SafetySignatures

        private JsonObject SafetySignatures(JsonArgs p, DiagnosticLog log, ChangeLog changes, IProgressSink progress)
        {
            PlcSoftwareRef software = _host.FindPlcSoftware(p.String("device_name", null), p.String("software_name", null));
            string groupPath = p.String("group_path", null);
            List<string> blockNames = p.StringList("block_names");
            List<string> typeNames = p.StringList("type_names");

            List<BlockRef> blocks = new List<BlockRef>();
            List<string> missing = new List<string>();
            if (blockNames.Count == 0)
            {
                foreach (BlockRef reference in _host.CollectBlocks(software.Software, null, true, false))
                {
                    if (!string.IsNullOrWhiteSpace(groupPath)
                        && !OpennessHost.NormalizeGroupPath(reference.GroupPath)
                            .StartsWith(OpennessHost.NormalizeGroupPath(groupPath), StringComparison.OrdinalIgnoreCase)) continue;
                    blocks.Add(reference);
                }
            }
            else
            {
                foreach (string raw in blockNames)
                {
                    string group, name;
                    OpennessHost.SplitGroupAndName(raw, out group, out name);
                    BlockRef found = _host.FindBlock(software.Software, group ?? groupPath, name);
                    if (found == null) missing.Add(name); else blocks.Add(found);
                }
            }

            List<PlcTypeRef> types = new List<PlcTypeRef>();
            foreach (string raw in typeNames)
            {
                string group, name;
                OpennessHost.SplitGroupAndName(raw, out group, out name);
                PlcTypeRef found = _host.FindType(software.Software, group ?? groupPath, name);
                if (found == null) missing.Add(name); else types.Add(found);
            }

            if (missing.Count > 0)
            {
                throw new ControllerException("block_not_found",
                    "These objects were not found: " + string.Join(", ", missing.ToArray()) + ".",
                    JsonObject.Of("missing", missing));
            }

            progress.Report("safety", "Reading the F-signatures of " + (blocks.Count + types.Count) + " object(s).");
            List<JsonObject> results = new List<JsonObject>();
            int fBlocks = 0;
            int nonF = 0;
            foreach (BlockRef reference in blocks)
            {
                JsonObject item = _host.DescribeSafetySignature(reference.Block);
                item.Insert(0, "name", reference.Name);
                item.Insert(1, "group", OpennessHost.NormalizeGroupPath(reference.GroupPath));
                if (JsonObject.ReadBool(item, "isFBlock", false)) fBlocks++; else nonF++;
                results.Add(item);
            }
            foreach (PlcTypeRef reference in types)
            {
                // The manual documents the signature service for blocks; a PLC
                // type is reported as "not an F-block" rather than failing.
                JsonObject item = new JsonObject();
                item.Add("name", reference.Name);
                item.Add("group", OpennessHost.NormalizeGroupPath(reference.GroupPath));
                item.Add("isFBlock", false);
                item.Add("reason", "The manual documents SafetySignatureProvider on PlcBlock instances; a PLC type "
                    + "(UDT) carries no F-signature.");
                nonF++;
                results.Add(item);
            }

            JsonObject data = new JsonObject();
            data.Add("device", software.DeviceName);
            data.Add("software", software.SoftwareName);
            data.Add("signatureType", "block_offline_signature");
            data.Add("fBlockCount", fBlocks);
            data.Add("nonFBlockCount", nonF);
            data.Add("blocks", results);
            log.Info("Read " + results.Count + " signature record(s): " + fBlocks + " F-block(s), " + nonF + " without one.");
            return data;
        }
    }
}
