using System;
using System.Collections.Generic;
using Siemens.Engineering;
using Siemens.Engineering.Safety;
using Siemens.Engineering.SW;
using Siemens.Engineering.SW.Blocks;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>
    /// F-related half of the Openness session, following the manual chapter
    /// "F-related Openness": the two <c>GlobalSettings</c> actions
    /// (<c>SafetyModificationsPossible</c>, <c>UsernameForFChangeHistory</c>), the
    /// per-CPU safety settings, and the F-signature service of a block.
    ///
    /// The manual obtains GlobalSettings from the TIA Portal instance
    /// (<c>TiaPortal.GetService&lt;GlobalSettings&gt;()</c>) and the signature
    /// provider from the block, so this file does the same.
    /// </summary>
    internal sealed partial class OpennessHost
    {
        /// <summary>
        /// The safety global settings service of the TIA Portal instance, or null
        /// with an explanation when the installation does not offer it.
        /// </summary>
        public GlobalSettings GlobalSettingsOf(out string reason)
        {
            reason = null;
            if (_portal == null)
            {
                reason = "No TIA Portal instance exists yet, so its GlobalSettings service cannot be requested.";
                return null;
            }
            try
            {
                GlobalSettings settings = _portal.GetService<GlobalSettings>();
                if (settings == null)
                {
                    reason = "TIA Portal returned no Siemens.Engineering.Safety.GlobalSettings service. The manual "
                        + "documents it for a TIA Portal with the failsafe option; an installation without STEP 7 "
                        + "Safety may not provide it.";
                }
                return settings;
            }
            catch (Exception ex)
            {
                reason = "Requesting the GlobalSettings service failed: " + ex.Message;
                return null;
            }
        }

        public JsonObject DescribeGlobalSettings(GlobalSettings settings, string reason)
        {
            JsonObject result = new JsonObject();
            if (settings == null)
            {
                result.Add("available", false);
                result.AddIfPresent("reason", reason);
                return result;
            }

            result.Add("available", true);
            bool modificationsPossible;
            try
            {
                modificationsPossible = settings.SafetyModificationsPossible();
                result.Add("safetyModificationsPossible", modificationsPossible);
            }
            catch (Exception ex)
            {
                result.Add("safetyModificationsPossibleError", ex.Message);
            }

            try
            {
                result.Add("usernameForFChangeHistory", settings.UsernameForFChangeHistory());
            }
            catch (Exception ex)
            {
                result.Add("usernameForFChangeHistoryError", ex.Message);
            }
            return result;
        }

        /// <summary>
        /// Writes the two documented GlobalSettings actions and reports the
        /// before/after pair for each of them.
        /// </summary>
        public JsonObject WriteGlobalSettings(GlobalSettings settings, bool? safetyModificationsPossible,
            string usernameForFChangeHistory)
        {
            JsonObject result = new JsonObject();

            if (safetyModificationsPossible.HasValue)
            {
                JsonObject entry = new JsonObject();
                try
                {
                    bool before = settings.SafetyModificationsPossible();
                    entry.Add("before", before);
                    if (before != safetyModificationsPossible.Value)
                    {
                        settings.SafetyModificationsPossible(safetyModificationsPossible.Value);
                    }
                    entry.Add("after", safetyModificationsPossible.Value);
                    entry.Add("changed", before != safetyModificationsPossible.Value);
                }
                catch (Exception ex)
                {
                    throw OpennessFailure("safety_setting_failed",
                        "Setting SafetyModificationsPossible failed: " + ex.Message, ex);
                }
                result.Add("safetyModificationsPossible", entry);
            }

            if (usernameForFChangeHistory != null)
            {
                JsonObject entry = new JsonObject();
                try
                {
                    string before = settings.UsernameForFChangeHistory();
                    entry.Add("before", before);
                    if (!string.Equals(before, usernameForFChangeHistory, StringComparison.Ordinal))
                    {
                        settings.UsernameForFChangeHistory(usernameForFChangeHistory);
                    }
                    entry.Add("after", usernameForFChangeHistory);
                    entry.Add("changed", !string.Equals(before, usernameForFChangeHistory, StringComparison.Ordinal));
                }
                catch (Exception ex)
                {
                    throw OpennessFailure("safety_setting_failed",
                        "Setting UsernameForFChangeHistory failed: " + ex.Message, ex);
                }
                result.Add("usernameForFChangeHistory", entry);
            }

            return result;
        }

        /// <summary>
        /// The per-CPU safety administration service. V17 publishes
        /// SafetySettings only as a property of SafetyAdministration, so both are
        /// reached through this one service.
        /// </summary>
        public SafetyAdministration SafetyAdministrationOf(PlcSoftware software, out string reason)
        {
            reason = null;
            if (software == null)
            {
                reason = "No PLC software is selected, so its safety services cannot be requested.";
                return null;
            }
            try
            {
                SafetyAdministration administration = software.GetService<SafetyAdministration>();
                if (administration == null)
                {
                    reason = "TIA Portal returned no Siemens.Engineering.Safety.SafetyAdministration service. A standard "
                        + "(non-failsafe) CPU does not have one.";
                }
                return administration;
            }
            catch (Exception ex)
            {
                reason = "Requesting the SafetyAdministration service failed: " + ex.Message;
                return null;
            }
        }

        /// <summary>Per-CPU safety settings, or an explanation when unavailable.</summary>
        public JsonObject DescribeSafetySettings(SafetyAdministration administration, string reason)
        {
            JsonObject result = new JsonObject();
            if (administration == null)
            {
                result.Add("available", false);
                result.AddIfPresent("reason", reason);
                return result;
            }

            SafetySettings settings = null;
            try
            {
                settings = administration.Settings;
            }
            catch (Exception ex)
            {
                reason = "Reading SafetyAdministration.Settings failed: " + ex.Message;
            }
            if (settings == null)
            {
                result.Add("available", false);
                result.AddIfPresent("reason", reason ?? "The safety administration exposes no Settings object.");
                return result;
            }

            result.Add("available", true);
            result.Add("activationOfFChangeHistory", SafeBool(delegate { return settings.ActivationOfFChangeHistory; }));
            result.Add("safetyModeCanBeDisabled", SafeBool(delegate { return settings.SafetyModeCanBeDisabled; }));
            result.Add("createDriverInstanceDataBlocksWithoutPrefix",
                SafeBool(delegate { return settings.CreateDriverInstanceDataBlocksWithoutPrefix; }));

            SafetySystemVersion version = null;
            try
            {
                version = settings.SafetySystemVersion;
            }
            catch (Exception)
            {
                // A CPU without an F-program can refuse the property.
            }
            result.AddIfPresent("safetySystemVersion", version == null
                ? null
                : SafeString(delegate { return version.Value; }));

            AssignmentOfBlockNumbers numbers = null;
            try
            {
                numbers = settings.AssignmentOfBlockNumbers;
            }
            catch (Exception)
            {
                // Optional detail.
            }
            if (numbers != null)
            {
                JsonObject blockNumbers = new JsonObject();
                blockNumbers.AddIfPresent("managementMode",
                    SafeString(delegate { return Convert.ToString(numbers.ManagementMode); }));
                blockNumbers.Add("fromFB", SafeInt(delegate { return numbers.FromFB; }));
                blockNumbers.Add("toFB", SafeInt(delegate { return numbers.ToFB; }));
                blockNumbers.Add("fromFC", SafeInt(delegate { return numbers.FromFC; }));
                blockNumbers.Add("toFC", SafeInt(delegate { return numbers.ToFC; }));
                blockNumbers.Add("fromDB", SafeInt(delegate { return numbers.FromDB; }));
                blockNumbers.Add("toDB", SafeInt(delegate { return numbers.ToDB; }));
                result.Add("assignmentOfBlockNumbers", blockNumbers);
            }
            return result;
        }

        /// <summary>Runtime groups and the offline-program state of one F-CPU.</summary>
        public JsonObject DescribeSafetyAdministration(SafetyAdministration administration, bool includeRuntimeGroups,
            string reason)
        {
            JsonObject result = new JsonObject();
            if (administration == null)
            {
                result.Add("available", false);
                result.AddIfPresent("reason", reason);
                return result;
            }

            result.Add("available", true);
            result.Add("isLoggedOnToSafetyOfflineProgram",
                SafeBool(delegate { return administration.IsLoggedOnToSafetyOfflineProgram; }));
            result.Add("isSafetyOfflineProgramPasswordSet",
                SafeBool(delegate { return administration.IsSafetyOfflineProgramPasswordSet; }));

            if (!includeRuntimeGroups) return result;

            List<JsonObject> groups = new List<JsonObject>();
            try
            {
                foreach (RuntimeGroup group in administration.RuntimeGroups)
                {
                    if (group == null) continue;
                    JsonObject entry = new JsonObject();
                    entry.AddIfPresent("name", SafeString(delegate { return group.Name; }));
                    entry.AddIfPresent("fobName", SafeString(delegate { return group.FOBName; }));
                    entry.AddIfPresent("mainSafetyBlockName", SafeString(delegate { return group.MainSafetyBlockName; }));
                    entry.AddIfPresent("mainSafetyBlockIDbName", SafeString(delegate { return group.MainSafetyBlockIDbName; }));
                    entry.AddIfPresent("preProcessingName", SafeString(delegate { return group.PreProcessingName; }));
                    entry.AddIfPresent("postProcessingName", SafeString(delegate { return group.PostProcessingName; }));
                    entry.AddIfPresent("infoDbName", SafeString(delegate { return group.InfoDbName; }));
                    entry.AddIfPresent("fobEventClass", SafeString(delegate { return group.FOBEventClass; }));
                    entry.Add("maximumCycleTime", SafeInt(delegate { return group.MaximumCycleTime; }));
                    entry.Add("warnCycleTime", SafeInt(delegate { return group.WarnCycleTime; }));
                    groups.Add(entry);
                }
            }
            catch (Exception ex)
            {
                result.Add("runtimeGroupError", ex.Message);
            }
            result.Add("runtimeGroupCount", groups.Count);
            result.Add("runtimeGroups", groups);
            return result;
        }

        /// <summary>
        /// A cheap "worth asking" filter before
        /// <c>GetService&lt;SafetySignatureProvider&gt;()</c>.
        ///
        /// V17 has no single <c>IsFBlock</c> attribute. What it does expose is the
        /// programming language: fail-safe blocks report one of the <c>F_*</c>
        /// members (<c>F_LAD</c>, <c>F_FBD</c>, <c>F_STL</c>, <c>F_DB</c>, their
        /// library variants and <c>F_CALL</c>). Measured on the reference project
        /// this catches 54 of its 55 safety blocks; the remaining one is the
        /// safety system OB <c>FOB_SAFETY</c>, which is an OB whose language is
        /// SCL. Every OB is therefore probed too — a PLC only has a handful.
        ///
        /// The filter only saves provider calls on the ~1000 standard blocks. It
        /// never decides that a block <em>is</em> an F-block: the provider's
        /// answer (null or a signature) stays authoritative, as the manual
        /// documents.
        /// </summary>
        public static bool MayBeSafetyBlock(PlcBlock block)
        {
            if (block == null) return false;
            try
            {
                switch (block.ProgrammingLanguage)
                {
                    case ProgrammingLanguage.F_STL:
                    case ProgrammingLanguage.F_LAD:
                    case ProgrammingLanguage.F_FBD:
                    case ProgrammingLanguage.F_DB:
                    case ProgrammingLanguage.F_LAD_LIB:
                    case ProgrammingLanguage.F_FBD_LIB:
                    case ProgrammingLanguage.F_CALL:
                        return true;
                    default:
                        break;
                }
            }
            catch (Exception)
            {
                // A block that cannot even report its language is worth the probe.
                return true;
            }
            return block is OB;
        }

        /// <summary>
        /// The F-signature of one block. A block whose
        /// <c>SafetySignatureProvider</c> is null is not an F-block (or not a
        /// block of an F-CPU S7-1200/1500), which is reported rather than treated
        /// as a failure.
        /// </summary>
        public JsonObject DescribeSafetySignature(PlcBlock block)
        {
            JsonObject item = new JsonObject();
            SafetySignatureProvider provider = null;
            try
            {
                provider = block.GetService<SafetySignatureProvider>();
            }
            catch (Exception ex)
            {
                item.Add("isFBlock", false);
                item.Add("reason", "Requesting the SafetySignatureProvider failed: " + ex.Message);
                return item;
            }

            if (provider == null)
            {
                item.Add("isFBlock", false);
                item.Add("reason", "TIA Portal returned no SafetySignatureProvider; the block is not an F-block or not a "
                    + "block of an F-CPU S7-1200/1500.");
                return item;
            }

            item.Add("isFBlock", true);
            try
            {
                SafetySignature signature = provider.Signatures.Find(SafetySignatureType.BlockOfflineSignature);
                if (signature == null)
                {
                    // The manual: a signature that does not exist yet, or that a
                    // recent change invalidated, is reported as 0.
                    item.Add("signatureType", Convert.ToString(SafetySignatureType.BlockOfflineSignature));
                    item.Add("value", 0UL);
                    item.Add("reason", "The block has no valid block offline signature yet.");
                    return item;
                }
                item.Add("signatureType", SafeString(delegate { return Convert.ToString(signature.Type); }));
                item.Add("value", signature.Value);
            }
            catch (Exception ex)
            {
                item.Add("reason", "Reading the F-signature failed: " + ex.Message);
            }
            return item;
        }
    }
}
