using System;
using System.Text.RegularExpressions;
using Siemens.Simatic.Simulation.Runtime;

namespace PlcsimAdvanced.Controller
{
    /// <summary>
    /// Maps a project CPU designation or order number to the PLCSIM Advanced
    /// instance CPU type.
    ///
    /// Accepted forms:
    ///   1515, 1515F, "CPU 1515F-2 PN", "CPU1515F"      (family, optional F)
    ///   6ES7 515-2FM01-0AB0 / 6ES7 515-2AN03-0AB0      (order number; A=standard, F=fail-safe)
    ///   unspecified / 1500 / CPU1500_Unspecified        (generic instance: the first TIA download initializes it)
    ///
    /// Only standard (A) and fail-safe (F) S7-1500 CPUs are mapped. Compact
    /// (C), technology (T/TF), R/H and ET 200SP families are refused with a
    /// clear error instead of silently creating the wrong instance.
    /// </summary>
    internal static class CpuTypes
    {
        internal static ECPUType Parse(string value)
        {
            string raw = (value ?? string.Empty).Trim();
            if (raw.Length == 0) return ECPUType.CPU1500_Unspecified;

            string normalized = raw;
            if (normalized.StartsWith("CPU", StringComparison.OrdinalIgnoreCase))
            {
                normalized = normalized.Substring(3).Trim();
            }
            if (normalized.Length == 0
                || string.Equals(normalized, "unspecified", StringComparison.OrdinalIgnoreCase)
                || string.Equals(normalized, "1500", StringComparison.OrdinalIgnoreCase)
                || normalized.StartsWith("1500_", StringComparison.OrdinalIgnoreCase))
            {
                return ECPUType.CPU1500_Unspecified;
            }

            string family;
            bool failsafe;

            // Order number: 6ES7 5xx-<slot><kind>...; kind A = standard, F = fail-safe.
            Match orderNumber = Regex.Match(
                raw,
                @"6ES7\s*5(?<family>11|13|15|16|17|18)-(?<slot>\d)(?<kind>[A-Z])",
                RegexOptions.IgnoreCase);
            if (orderNumber.Success)
            {
                family = "15" + orderNumber.Groups["family"].Value;
                string kind = orderNumber.Groups["kind"].Value.ToUpperInvariant();
                if (kind == "F") failsafe = true;
                else if (kind == "A") failsafe = false;
                else throw Unsupported(raw, "only standard (A) and fail-safe (F) S7-1500 order numbers are mapped");
            }
            else
            {
                // Family designation: 1515, 1515F, "1515F-2 PN", "CPU 1515F-2 PN".
                Match model = Regex.Match(
                    normalized,
                    @"^(?<family>15(?:11|13|15|16|17|18))(?<suffix>[A-Z]*)(?![0-9])",
                    RegexOptions.IgnoreCase);
                if (!model.Success) throw Unsupported(raw, "no S7-1500 family (1511/1513/1515/1516/1517/1518) was found");
                family = model.Groups["family"].Value;
                string suffix = model.Groups["suffix"].Value.ToUpperInvariant();
                if (suffix.Length == 0) failsafe = false;
                else if (suffix == "F") failsafe = true;
                else throw Unsupported(raw, "only standard and fail-safe (F) S7-1500 CPUs are exposed; compact/technology (C/T/TF) are not");
            }

            if (failsafe)
            {
                switch (family)
                {
                    case "1511": return ECPUType.CPU1511F;
                    case "1513": return ECPUType.CPU1513F;
                    case "1515": return ECPUType.CPU1515F;
                    case "1516": return ECPUType.CPU1516F;
                    case "1517": return ECPUType.CPU1517F;
                    case "1518": return ECPUType.CPU1518F;
                }
            }
            else
            {
                switch (family)
                {
                    case "1511": return ECPUType.CPU1511;
                    case "1513": return ECPUType.CPU1513;
                    case "1515": return ECPUType.CPU1515;
                    case "1516": return ECPUType.CPU1516;
                    case "1517": return ECPUType.CPU1517;
                    case "1518": return ECPUType.CPU1518;
                }
            }

            throw Unsupported(raw, "the S7-1500 family could not be resolved");
        }

        private static ControllerException Unsupported(string raw, string why)
        {
            return new ControllerException(
                "invalid_cpu_type",
                "CPU model '" + raw + "' cannot be mapped to a PLCSIM Advanced instance type: " + why
                + ". Pass a family (1511/1513/1515/1516/1517/1518, append F for fail-safe) or the project order number.");
        }
    }
}
