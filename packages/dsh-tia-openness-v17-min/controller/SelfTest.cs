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
                Check(checks, ref ok, "evidence_roundtrip", delegate { EvidenceRoundTrip(workDirectory); });
                Check(checks, ref ok, "evidence_diff", EvidenceDiff);
                Check(checks, ref ok, "evidence_xml_normalization", EvidenceXmlNormalization);
                Check(checks, ref ok, "manifest_adoption", delegate { ManifestAdoptionCheck(workDirectory); });
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
                "PlcChecksum", "SyncScan",
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

        private static EvidenceObject EvidenceObjectFor(string category, string group, string name, string signature)
        {
            EvidenceObject entry = new EvidenceObject();
            entry.Key = EvidenceDocument.KeyOf(category, group, name);
            entry.Category = category;
            entry.Name = name;
            entry.GroupPath = group;
            if (string.Equals(category, EvidenceDocument.CategoryTagTables, StringComparison.Ordinal))
            {
                entry.ContentHash = signature;
            }
            else
            {
                entry.Fingerprint = new Dictionary<string, string>(StringComparer.Ordinal);
                entry.Fingerprint["Code"] = signature;
            }
            return entry;
        }

        private static void EvidenceRoundTrip(string workDirectory)
        {
            EvidenceDocument document = new EvidenceDocument();
            document.Device = "PLC_1";
            document.Software = "PLC_1";
            document.PlcChecksum = "CHK-1";
            EvidenceObject block = EvidenceObjectFor(EvidenceDocument.CategoryBlocks, "010_Cell", "FB_Motor", "code-a");
            block.Path = "blocks/010_Cell/FB_Motor.xml";
            document.Objects[block.Key] = block;
            EvidenceObject table = EvidenceObjectFor(EvidenceDocument.CategoryTagTables, null, "Tags_1", "sha256:table-a");
            table.Path = "tag_tables/Tags_1.xml";
            document.Objects[table.Key] = table;
            EvidenceTombstone tombstone = new EvidenceTombstone();
            tombstone.Key = EvidenceDocument.KeyOf(EvidenceDocument.CategoryBlocks, null, "FB_Old");
            tombstone.Category = EvidenceDocument.CategoryBlocks;
            tombstone.Name = "FB_Old";
            tombstone.RemovedAtChecksum = "CHK-0";
            tombstone.Reason = "absent-from-complete-list";
            document.Tombstones.Add(tombstone);
            document.StateId = document.ComputeStateId();

            string path = Path.Combine(workDirectory, "evidence.json");
            File.WriteAllText(path, JsonWriter.Write(document.ToJson(), true), new UTF8Encoding(false));
            EvidenceDocument loaded = EvidenceDocument.Load(path);

            Require(loaded != null, "the ledger was read back");
            RequireEqual("CHK-1", loaded.PlcChecksum, "the checksum survived the round trip");
            RequireEqual("2", loaded.Objects.Count.ToString(), "both objects survived the round trip");
            RequireEqual("code-a", loaded.Objects[block.Key].Fingerprint["Code"], "the fingerprint survived the round trip");
            RequireEqual("sha256:table-a", loaded.Objects[table.Key].ContentHash, "the tag table hash survived the round trip");
            RequireEqual("1", loaded.Tombstones.Count.ToString(), "the tombstone survived the round trip");
            RequireEqual(document.StateId, loaded.StateId, "the state id survived the round trip");
        }

        private static void EvidenceDiff()
        {
            EvidenceDocument previous = new EvidenceDocument();
            previous.PlcChecksum = "CHK-1";
            EvidenceObject motor = EvidenceObjectFor(EvidenceDocument.CategoryBlocks, "010_Cell", "FB_Motor", "code-a");
            EvidenceObject old = EvidenceObjectFor(EvidenceDocument.CategoryBlocks, null, "FB_Old", "code-old");
            EvidenceObject table = EvidenceObjectFor(EvidenceDocument.CategoryTagTables, null, "Tags_1", "sha256:table-a");
            previous.Objects[motor.Key] = motor;
            previous.Objects[old.Key] = old;
            previous.Objects[table.Key] = table;

            Dictionary<string, EvidenceObject> current = new Dictionary<string, EvidenceObject>(StringComparer.Ordinal);
            current[motor.Key] = EvidenceObjectFor(EvidenceDocument.CategoryBlocks, "010_Cell", "FB_Motor", "code-a");
            EvidenceObject added = EvidenceObjectFor(EvidenceDocument.CategoryBlocks, null, "FC_New", "code-new");
            current[added.Key] = added;
            current[table.Key] = EvidenceObjectFor(EvidenceDocument.CategoryTagTables, null, "Tags_1", "sha256:table-b");

            EvidenceDelta delta = EvidenceDocument.Compare(previous, current);
            RequireEqual("1", delta.Changed.Count.ToString(), "one object changed");
            RequireEqual(table.Key, delta.Changed[0], "the changed object is the tag table");
            RequireEqual("1", delta.Added.Count.ToString(), "one object was added");
            RequireEqual(added.Key, delta.Added[0], "the added object is FC_New");
            RequireEqual("1", delta.Removed.Count.ToString(), "one object was removed");
            RequireEqual(old.Key, delta.Removed[0], "the removed object is FB_Old");
        }

        private static void EvidenceXmlNormalization()
        {
            string first = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<DocumentInfo><Created>2026-10-20T10:00:00Z</Created></DocumentInfo>\n"
                + "<SW.Blocks.FC><AttributeList><Name>FC_1</Name></AttributeList></SW.Blocks.FC>\n";
            string second = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n<DocumentInfo><Created>2026-10-21T11:00:00Z</Created></DocumentInfo>\r\n"
                + "<SW.Blocks.FC><AttributeList><Name>FC_1</Name></AttributeList></SW.Blocks.FC>\r\n";
            RequireEqual(
                EvidenceDocument.NormalizeXmlForHash(first),
                EvidenceDocument.NormalizeXmlForHash(second),
                "the document stamp and the line endings do not affect the hash");
            RequireEqual(
                Hashing.Sha256OfText(EvidenceDocument.NormalizeXmlForHash(first)),
                Hashing.Sha256OfText(EvidenceDocument.NormalizeXmlForHash(second)),
                "the normalized hashes are equal");

            string changed = first.Replace("<Name>FC_1</Name>", "<Name>FC_2</Name>");
            Require(
                !string.Equals(EvidenceDocument.NormalizeXmlForHash(first), EvidenceDocument.NormalizeXmlForHash(changed),
                    StringComparison.Ordinal),
                "a real content change still changes the normalized text");
        }

        /// <summary>One manifest row, as the writer produces it (only the fields adoption reads).</summary>
        private static JsonObject ManifestRow(string category, string group, string name, string file, bool verified, string sha256)
        {
            JsonObject row = new JsonObject();
            row.Add("category", category);
            if (!string.IsNullOrEmpty(group)) row.Add("group", group);
            row.Add("name", name);
            row.Add("file", file);
            row.Add("verified", verified);
            if (sha256 != null) row.Add("sha256", sha256);
            return row;
        }

        /// <summary>
        /// The `adopt_existing` decision table: a manifest row may replace an export
        /// only when it is verified, carries a digest, names a file inside the source
        /// root, and that file still hashes to the recorded digest. A tag table also
        /// has to be readable, because its ledger evidence is a content hash.
        /// </summary>
        private static void ManifestAdoptionCheck(string workDirectory)
        {
            string root = Path.Combine(workDirectory, "adopt-source");
            Directory.CreateDirectory(Path.Combine(root, "blocks", "010_Cell"));
            Directory.CreateDirectory(Path.Combine(root, "tag_tables"));
            string blockFile = Path.Combine(root, "blocks", "010_Cell", "FB_Motor.xml");
            File.WriteAllText(blockFile,
                "<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n"
                + "<Document>\r\n  <SW.Blocks.FB ID=\"0\">\r\n    <AttributeList>\r\n      <Name>FB_Motor</Name>\r\n"
                + "    </AttributeList>\r\n  </SW.Blocks.FB>\r\n</Document>\r\n", new UTF8Encoding(false));
            string blockSha = Hashing.Sha256OfFile(blockFile);

            string tableFile = Path.Combine(root, "tag_tables", "Tags_1.xml");
            string tableFirst = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n"
                + "<DocumentInfo><Created>2026-10-20T10:00:00Z</Created></DocumentInfo>\r\n"
                + "<SW.Tags.PlcTagTable><AttributeList><Name>Tags_1</Name></AttributeList></SW.Tags.PlcTagTable>\r\n";
            File.WriteAllText(tableFile, tableFirst, new UTF8Encoding(false));
            string tableSha = Hashing.Sha256OfFile(tableFile);

            // --- the manifest key and the file normalization
            string manifestPath = Path.Combine(workDirectory, "adopt-manifest.json");
            JsonObject manifest = new JsonObject();
            manifest.Add("outputDir", root);
            manifest.Add("blocks", new List<JsonObject>
            {
                ManifestRow(EvidenceDocument.CategoryBlocks, "010_Cell", "FB_Motor", Path.Combine(root, "blocks", "010_Cell", "FB_Motor.xml"), true, blockSha),
                ManifestRow(EvidenceDocument.CategoryTagTables, null, "Tags_1", "tag_tables/Tags_1.xml", true, tableSha),
            });
            File.WriteAllText(manifestPath, JsonWriter.Write(manifest, true), new UTF8Encoding(false));

            OpennessOperations.ManifestIndex index = OpennessOperations.ManifestIndex.Load(manifestPath);
            Require(index.IsUsable, "a manifest with rows is usable");
            string blockKey = EvidenceDocument.KeyOf(EvidenceDocument.CategoryBlocks, "010_Cell", "FB_Motor");
            RequireEqual("blocks|010_Cell|FB_Motor", blockKey, "the ledger key shape");
            Require(index.Entries.ContainsKey(blockKey), "a manifest row is keyed like the ledger: " + blockKey);
            string tableKey = EvidenceDocument.KeyOf(EvidenceDocument.CategoryTagTables, null, "Tags_1");
            Require(index.Entries.ContainsKey(tableKey), "the tag table row is keyed like its ledger entry");
            RequireEqual("blocks/010_Cell/FB_Motor.xml",
                JsonObject.ReadString(index.Entries[blockKey], "file", null),
                "a rooted manifest file is normalized against outputDir");
            RequireEqual("tag_tables/Tags_1.xml",
                JsonObject.ReadString(index.Entries[tableKey], "file", null),
                "a relative manifest file is kept as written");

            // --- the positive case
            string relative;
            string contentHash;
            string reason;
            JsonObject row = index.Entries[blockKey];
            Require(ManifestAdoption.TryAdopt(root, row, false, out relative, out contentHash, out reason),
                "a verified, matching row is adoptable" + (reason == null ? string.Empty : ": " + reason));
            RequireEqual("blocks/010_Cell/FB_Motor.xml", relative, "the adopted path is relative and slash-separated");
            Require(contentHash == null, "a block carries no content hash");

            // A digest spelled in upper case is the same digest.
            JsonObject upper = ManifestRow(EvidenceDocument.CategoryBlocks, "010_Cell", "FB_Motor",
                "blocks/010_Cell/FB_Motor.xml", true, blockSha.ToUpperInvariant());
            Require(ManifestAdoption.TryAdopt(root, upper, false, out relative, out contentHash, out reason),
                "the digest is compared case-insensitively");

            // --- every condition is mandatory
            JsonObject unverified = ManifestRow(EvidenceDocument.CategoryBlocks, "010_Cell", "FB_Motor",
                "blocks/010_Cell/FB_Motor.xml", false, blockSha);
            Require(!ManifestAdoption.TryAdopt(root, unverified, false, out relative, out contentHash, out reason),
                "an unverified row is exported again");

            JsonObject noSha = ManifestRow(EvidenceDocument.CategoryBlocks, "010_Cell", "FB_Motor",
                "blocks/010_Cell/FB_Motor.xml", true, null);
            Require(!ManifestAdoption.TryAdopt(root, noSha, false, out relative, out contentHash, out reason),
                "a row without sha256 is exported again");

            string changed = Hashing.Sha256OfText("something else");
            JsonObject wrongSha = ManifestRow(EvidenceDocument.CategoryBlocks, "010_Cell", "FB_Motor",
                "blocks/010_Cell/FB_Motor.xml", true, changed);
            Require(!ManifestAdoption.TryAdopt(root, wrongSha, false, out relative, out contentHash, out reason),
                "a file that no longer matches the digest is exported again");
            Require(!string.IsNullOrEmpty(reason), "a digest mismatch is reported, not silent");

            JsonObject missingFile = ManifestRow(EvidenceDocument.CategoryBlocks, null, "FB_Gone",
                "blocks/FB_Gone.xml", true, blockSha);
            Require(!ManifestAdoption.TryAdopt(root, missingFile, false, out relative, out contentHash, out reason),
                "a row whose file is gone is exported again");

            JsonObject noFile = ManifestRow(EvidenceDocument.CategoryBlocks, null, "FB_Motor", string.Empty, true, blockSha);
            Require(!ManifestAdoption.TryAdopt(root, noFile, false, out relative, out contentHash, out reason),
                "a row without a file is exported again");

            // A row that walks out of the source root is never trusted, even when the
            // outside file exists and its digest matches.
            string outside = Path.Combine(workDirectory, "outside.xml");
            File.WriteAllText(outside, tableFirst, new UTF8Encoding(false));
            JsonObject escape = ManifestRow(EvidenceDocument.CategoryBlocks, null, "FB_Outside",
                "../outside.xml", true, Hashing.Sha256OfFile(outside));
            Require(!ManifestAdoption.TryAdopt(root, escape, false, out relative, out contentHash, out reason),
                "a row that escapes the source root is refused");
            Require(!string.IsNullOrEmpty(reason), "an escaping row is reported, not silent");

            JsonObject rooted = ManifestRow(EvidenceDocument.CategoryTagTables, null, "Tags_1",
                tableFile, true, tableSha);
            Require(!ManifestAdoption.TryAdopt(root, rooted, true, out relative, out contentHash, out reason),
                "a rooted manifest file is refused: rows are relative by contract");

            // --- a tag table adopts with the normalized content hash a scan would compute
            Require(ManifestAdoption.TryAdopt(root, index.Entries[tableKey], true, out relative, out contentHash, out reason),
                "a readable tag table is adoptable" + (reason == null ? string.Empty : ": " + reason));
            RequireEqual("tag_tables/Tags_1.xml", relative, "the adopted tag table path");
            RequireEqual("sha256:" + Hashing.Sha256OfText(EvidenceDocument.NormalizeXmlForHash(tableFirst)),
                contentHash,
                "the adopted content hash is the normalized XML hash the ledger records");

            string tableSecond = tableFirst.Replace("2026-10-20T10:00:00Z", "2026-10-22T18:30:00Z");
            File.WriteAllText(tableFile, tableSecond, new UTF8Encoding(false));
            JsonObject restamped = ManifestRow(EvidenceDocument.CategoryTagTables, null, "Tags_1",
                "tag_tables/Tags_1.xml", true, Hashing.Sha256OfFile(tableFile));
            Require(ManifestAdoption.TryAdopt(root, restamped, true, out relative, out contentHash, out reason),
                "a re-stamped tag table is adoptable");
            RequireEqual("sha256:" + Hashing.Sha256OfText(EvidenceDocument.NormalizeXmlForHash(tableFirst)),
                contentHash,
                "a new export stamp does not change the adopted content hash");
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
