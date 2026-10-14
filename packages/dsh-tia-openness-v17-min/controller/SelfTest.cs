using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>
    /// Exercises everything in the controller that does not need TIA Portal:
    /// the NDJSON envelope, the JSON reader and writer, the argument validation,
    /// the operation whitelist, and the Simatic ML / external source readers.
    ///
    /// The self test is deliberately the only automated check that a CI machine
    /// without TIA Portal can run, so it also asserts that no Openness assembly
    /// was loaded as a side effect of starting the process.
    /// </summary>
    internal static class SelfTest
    {
        public static int Run(string controllerVersion, string opennessDir)
        {
            List<JsonObject> checks = new List<JsonObject>();
            bool ok = true;
            string workDirectory = Path.Combine(Path.GetTempPath(), "tia-openness-selftest-" + Guid.NewGuid().ToString("N"));

            try
            {
                Directory.CreateDirectory(workDirectory);

                Check(checks, ref ok, "whitelist_exact", WhitelistExact);
                Check(checks, ref ok, "whitelist_rejects_unknown", WhitelistRejectsUnknown);
                Check(checks, ref ok, "json_roundtrip", JsonRoundTrip);
                Check(checks, ref ok, "json_escaping", JsonEscaping);
                Check(checks, ref ok, "args_accessors", ArgsAccessors);
                Check(checks, ref ok, "args_rejects_wrong_type", ArgsRejectsWrongType);
                Check(checks, ref ok, "args_rejects_unknown_enum", ArgsRejectsUnknownEnum);
                Check(checks, ref ok, "result_frame_shape", ResultFrameShape);
                Check(checks, ref ok, "simatic_ml_header", delegate { SimaticMlHeaderCheck(workDirectory); });
                Check(checks, ref ok, "simatic_ml_rejects_garbage", delegate { SimaticMlRejectsGarbage(workDirectory); });
                Check(checks, ref ok, "external_source_scan", delegate { ExternalSourceScan(workDirectory); });
                Check(checks, ref ok, "sha256_matches_known_vector", delegate { Sha256Check(workDirectory); });
                Check(checks, ref ok, "openness_not_loaded_by_startup", OpennessNotLoaded);
                Check(checks, ref ok, "siemens_resolver_package_present", SiemensResolverPresent);
            }
            catch (Exception ex)
            {
                ok = false;
                checks.Add(JsonObject.Of("name", "self_test_harness", "ok", false,
                    "detail", ex.GetType().Name + ": " + ex.Message));
            }
            finally
            {
                try
                {
                    if (Directory.Exists(workDirectory)) Directory.Delete(workDirectory, true);
                }
                catch (Exception)
                {
                    // Temporary files are cleaned up by the OS if this fails.
                }
            }

            JsonObject openness = OpennessBootstrap.Probe(opennessDir, AssemblyResolver.CandidateDirectories);
            JsonObject report = new JsonObject();
            report.Add("type", "self_test");
            report.Add("controller", Protocol.ControllerName);
            report.Add("controllerVersion", controllerVersion);
            report.Add("protocol", Protocol.Version);
            report.Add("ok", ok);
            report.Add("checkCount", checks.Count);
            report.Add("failedCount", CountFailures(checks));
            report.Add("checks", checks);
            report.Add("openness", openness);
            report.Add("opennessUserGroup", GroupMembership.Probe());
            report.Add("note", "A failing check means the controller is not usable; the TIA Portal operations themselves "
                + "are only exercised by the functional test against a real project.");

            Console.Out.Write(JsonWriter.Write(report, true));
            Console.Out.Write('\n');
            Console.Out.Flush();
            return ok ? 0 : 1;
        }

        private static int CountFailures(List<JsonObject> checks)
        {
            int failed = 0;
            foreach (JsonObject check in checks)
            {
                if (!JsonObject.ReadBool(check, "ok", false)) failed++;
            }
            return failed;
        }

        private delegate void CheckBody();

        private static void Check(List<JsonObject> checks, ref bool ok, string name, CheckBody body)
        {
            JsonObject check = new JsonObject();
            check.Add("name", name);
            try
            {
                body();
                check.Add("ok", true);
            }
            catch (Exception ex)
            {
                ok = false;
                check.Add("ok", false);
                check.Add("detail", ex is SelfTestFailure ? ex.Message : ex.GetType().Name + ": " + ex.Message);
            }
            checks.Add(check);
        }

        private sealed class SelfTestFailure : Exception
        {
            public SelfTestFailure(string message) : base(message) { }
        }

        private static void Require(bool condition, string message)
        {
            if (!condition) throw new SelfTestFailure(message);
        }

        private static void RequireEqual(string expected, string actual, string what)
        {
            if (!string.Equals(expected, actual, StringComparison.Ordinal))
            {
                throw new SelfTestFailure(what + ": expected " + Text.Quote(expected) + " but found " + Text.Quote(actual));
            }
        }

        // ------------------------------------------------------------- the checks

        /// <summary>
        /// The whitelist is the controller's security boundary, so its exact
        /// contents are asserted here rather than only its size: a name that
        /// disappears from the catalog silently breaks the matching DSH tool.
        /// </summary>
        private static void WhitelistExact()
        {
            IList<string> all = OperationCatalog.All;
            string[] expected =
            {
                "OpenProject", "ExportBlocks", "ImportBlocks", "CompilePlc", "CloseProject",
                "CreateProject", "SaveProject", "ArchiveProject", "ProjectInfo", "ProjectLanguages", "ProjectTexts",
                "UpdateProject", "PortalSettings",
                "ListPlcObjects", "CreatePlcObjects", "DeletePlcObjects", "WriteTags", "SetBlockAttributes",
                "ProtectBlocks", "GenerateSource", "WatchAndForceTables", "SoftwareUnits",
                "SafetyStatus", "SetSafetySettings", "SafetySignatures",
            };
            RequireEqual(expected.Length.ToString(), all.Count.ToString(), "the whitelist size");
            for (int i = 0; i < expected.Length; i++)
            {
                RequireEqual(expected[i], all[i], "the whitelist entry " + (i + 1));
                Require(OperationCatalog.IsAllowed(expected[i]), "the whitelist is missing " + Text.Quote(expected[i]));
            }
            // The order is the wire order (ready frame, --help, the coverage
            // matrix), so a duplicate would shift the list rather than be caught
            // by the loop above.
            for (int i = 0; i < all.Count; i++)
            {
                for (int j = i + 1; j < all.Count; j++)
                {
                    Require(!string.Equals(all[i], all[j], StringComparison.Ordinal),
                        "the whitelist contains " + Text.Quote(all[i]) + " twice");
                }
            }
        }

        private static void WhitelistRejectsUnknown()
        {
            string[] refused =
            {
                "RunScript", "ImportBlock", "export_blocks", "OpenProject ", "DeleteBlock", "Shutdown", "Ping", string.Empty,
            };
            foreach (string name in refused)
            {
                Require(!OperationCatalog.IsAllowed(name), "the whitelist accepted " + Text.Quote(name));
            }
        }

        private static void JsonRoundTrip()
        {
            JsonObject payload = new JsonObject();
            payload.Add("ok", true);
            payload.Add("count", 3);
            payload.Add("missing", null);
            payload.Add("nested", JsonObject.Of("a", 1, "b", new List<string> { "x", "y" }));
            payload.Add("ratio", 0.5);

            string text = JsonWriter.Write(payload, false);
            JsonArgs parsed = JsonArgs.Parse(text);
            Require(parsed.Has("ok"), "the boolean survived the round trip");
            Require(parsed.Bool("ok", false), "the boolean value survived the round trip");
            RequireEqual("3", parsed.Int("count", 0).ToString(), "the integer survived the round trip");
            Require(!parsed.Has("missing"), "a null value is reported as absent");
            RequireEqual("1", parsed.Object("nested").Int("a", 0).ToString(), "a nested object survived the round trip");
            RequireEqual("2", parsed.Object("nested").StringList("b").Count.ToString(), "a nested array survived the round trip");
        }

        private static void JsonEscaping()
        {
            string tricky = "quote \" backslash \\ newline \n tab \t cjk \u4e2d\u6587 emoji \ud83d\ude00 control \u0001";
            JsonObject payload = JsonObject.Of("value", tricky);
            string text = JsonWriter.Write(payload, false);

            Require(text.IndexOf('\n') < 0, "a raw newline must be escaped");
            RequireEqual(tricky, JsonArgs.Parse(text).String("value", null), "the escaped string survived the round trip");
        }

        private static void ArgsAccessors()
        {
            JsonArgs args = JsonArgs.Parse("{\"s\":\"v\",\"b\":true,\"i\":7,\"list\":[\"a\",\"b\"],\"one\":\"only\",\"nested\":{\"k\":\"v\"}}");
            RequireEqual("v", args.String("s", null), "a string is read back");
            Require(args.Bool("b", false), "a boolean is read back");
            RequireEqual("7", args.Int("i", 0).ToString(), "an integer is read back");
            RequireEqual("2", args.StringList("list").Count.ToString(), "an array is read back as a list");
            RequireEqual("1", args.StringList("one").Count.ToString(), "a single string is accepted as a one element list");
            RequireEqual("v", args.Object("nested").String("k", null), "a nested object is read back");
            RequireEqual("fallback", args.String("absent", "fallback"), "a missing value falls back");
        }

        private static void ArgsRejectsWrongType()
        {
            JsonArgs args = JsonArgs.Parse("{\"count\":\"seven\"}");
            try
            {
                args.Int("count", 0);
                throw new SelfTestFailure("a wrong type must be rejected, not coerced");
            }
            catch (ControllerException ex)
            {
                RequireEqual("invalid_params", ex.Code, "the error code of a wrong type");
            }
        }

        private static void ArgsRejectsUnknownEnum()
        {
            JsonArgs args = JsonArgs.Parse("{\"mode\":\"whatever\"}");
            try
            {
                args.Enum("mode", new[] { "auto", "simatic_ml" }, "auto");
                throw new SelfTestFailure("an unknown enum member must be rejected");
            }
            catch (ControllerException ex)
            {
                RequireEqual("invalid_params", ex.Code, "the error code of an unknown enum member");
                Require(ex.Message.IndexOf("simatic_ml", StringComparison.Ordinal) >= 0,
                    "the error message lists the allowed values");
            }
        }

        private static void ResultFrameShape()
        {
            DiagnosticLog log = new DiagnosticLog();
            log.Info("hello");
            ChangeLog changes = new ChangeLog();
            changes.Add("block", "FB1", "imported");

            JsonObject data = JsonObject.Of("dryRun", true, "plan", new List<string>());
            JsonObject frame = Frames.Result("42", "ImportBlocks", true, data, null, changes, log, DateTime.UtcNow);
            string text = JsonWriter.Write(frame, false);
            JsonArgs parsed = JsonArgs.Parse(text);

            RequireEqual("result", parsed.String("type", null), "the frame type");
            RequireEqual("1", parsed.Int("protocol", 0).ToString(), "the protocol version");
            RequireEqual("42", parsed.String("id", null), "the correlation id");
            RequireEqual("ImportBlocks", parsed.String("operation", null), "the operation name");
            Require(parsed.Bool("ok", false), "the ok flag");
            Require(parsed.Bool("dryRun", false), "the dry run flag is lifted out of the payload");
            RequireEqual("1", CountItems(parsed, "changes").ToString(), "the change list is populated");
            RequireEqual("1", CountItems(parsed, "diagnostics").ToString(), "the diagnostic list is populated");

            JsonObject failure = Frames.Result(null, "ExportBlocks", false, null,
                new ControllerException("block_not_found", "no such block", JsonObject.Of("missing", new List<string> { "FB9" })),
                null, null, DateTime.UtcNow);
            JsonArgs failed = JsonArgs.Parse(JsonWriter.Write(failure, false));
            Require(!failed.Bool("ok", true), "a failure frame reports ok=false");
            RequireEqual("block_not_found", failed.Object("error").String("code", null), "the error code of a failure frame");
        }

        private static int CountItems(JsonArgs args, string name)
        {
            System.Collections.IEnumerable items = args.Raw(name) as System.Collections.IEnumerable;
            if (items == null) return -1;
            int count = 0;
            foreach (object item in items) count++;
            return count;
        }

        private static void SimaticMlHeaderCheck(string workDirectory)
        {
            string path = Path.Combine(workDirectory, "FC_Test.xml");
            File.WriteAllText(path,
                "<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n"
                + "<Document>\r\n"
                + "  <SW.Blocks.FC ID=\"0\">\r\n"
                + "    <AttributeList>\r\n"
                + "      <Name>FC_Test</Name>\r\n"
                + "      <Number>7</Number>\r\n"
                + "      <ProgrammingLanguage>SCL</ProgrammingLanguage>\r\n"
                + "    </AttributeList>\r\n"
                + "  </SW.Blocks.FC>\r\n"
                + "</Document>\r\n", new UTF8Encoding(false));

            SimaticMlHeader header = SimaticMl.ReadHeader(path);
            RequireEqual("Document", header.DocumentRoot, "the document root");
            RequireEqual("SW.Blocks.FC", header.ElementName, "the object element");
            RequireEqual("block", header.Kind, "the object kind");
            RequireEqual("FC", header.SimaticType, "the Simatic type");
            RequireEqual("FC_Test", header.Name, "the block name");
            RequireEqual("7", header.Number, "the block number");
            RequireEqual("SCL", header.ProgrammingLanguage, "the programming language");

            JsonObject described = SimaticMl.DescribeSimaticMl(path);
            RequireEqual("simatic_ml", described["format"] as string, "the described format");
        }

        private static void SimaticMlRejectsGarbage(string workDirectory)
        {
            string path = Path.Combine(workDirectory, "broken.xml");
            File.WriteAllText(path, "<Document><SW.Blocks.FC>", new UTF8Encoding(false));
            try
            {
                SimaticMl.ReadHeader(path);
                throw new SelfTestFailure("a malformed XML file must be rejected");
            }
            catch (ControllerException ex)
            {
                RequireEqual("invalid_file", ex.Code, "the error code for a malformed file");
            }
        }

        private static void ExternalSourceScan(string workDirectory)
        {
            string path = Path.Combine(workDirectory, "source.scl");
            File.WriteAllText(path,
                "FUNCTION_BLOCK \"FB_Motor\"\r\n"
                + "VAR_INPUT\r\n"
                + "  start : Bool;\r\n"
                + "END_VAR\r\n"
                + "END_FUNCTION_BLOCK\r\n"
                + "\r\n"
                + "FUNCTION \"FC_Helper\" : Void\r\n"
                + "END_FUNCTION\r\n"
                + "\r\n"
                + "DATA_BLOCK \"DB_Data\"\r\n"
                + "END_DATA_BLOCK\r\n", new UTF8Encoding(false));

            JsonObject described = SimaticMl.DescribeExternalSource(path);
            RequireEqual("external_source", described["format"] as string, "the described format");
            RequireEqual("3", JsonObject.ReadInt(described, "objectCount", 0).ToString(), "the number of scanned declarations");
            RequireEqual("SCL", JsonObject.ReadString(described, "language", null), "the detected source language");
            Require(SimaticMl.LooksLikeExternalSource(path), "a .scl file is an external source");
            Require(!SimaticMl.LooksLikeSimaticMl(path), "a .scl file is not Simatic ML");
        }

        private static void Sha256Check(string workDirectory)
        {
            string path = Path.Combine(workDirectory, "hash.bin");
            File.WriteAllText(path, "abc", new UTF8Encoding(false));
            RequireEqual(
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                Hashing.Sha256OfFile(path),
                "the SHA-256 of \"abc\"");
        }

        private static void OpennessNotLoaded()
        {
            foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                string name = assembly.GetName().Name;
                if (string.Equals(name, "Siemens.Engineering", StringComparison.OrdinalIgnoreCase))
                {
                    throw new SelfTestFailure(
                        "Siemens.Engineering was loaded before any operation ran; the resolver must be the only loader.");
                }
            }
        }

        /// <summary>
        /// The controller resolves Openness through Siemens' own NuGet package, so
        /// the self test proves that package is present at run time (a missing
        /// package would otherwise only surface when the first operation tries to
        /// load the resolver).
        /// </summary>
        private static void SiemensResolverPresent()
        {
            string version = OpennessBootstrap.ResolverVersion();
            Require(!string.IsNullOrEmpty(version),
                "Siemens.Collaboration.Net.TiaPortal.Openness.Resolver is not loadable; the controller must be built with a NuGet restore.");
            Require(OpennessBootstrap.TiaPortalMajorVersion == 17,
                "this controller build is bound to TIA Portal V17");

            // The declared reference package version is compiled in through the
            // csproj default; the self test only asserts the major version matches.
            JsonObject probe = OpennessBootstrap.Probe(AssemblyResolver.DefaultOpennessDir, AssemblyResolver.CandidateDirectories);
            RequireEqual("17", Convert.ToString(JsonObject.ReadInt(probe, "tiaMajorVersion", 0)), "the probed TIA major version");
        }
    }
}
