using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>
    /// One engineering object as the evidence ledger knows it.
    ///
    /// The ledger is the machine-readable answer to "what did TIA hold when this
    /// source tree was written": a fingerprint per block / PLC type, a normalized
    /// content hash per tag table, the PLC checksum those were read under, and the
    /// tombstones of objects that disappeared. The SQLite knowledge graph is a
    /// derived view; this file is the evidence.
    /// </summary>
    internal sealed class EvidenceObject
    {
        public string Key;
        public string Category;
        public string Name;
        public string GroupPath;
        public string Path;
        public string State = EvidenceDocument.StatePresent;
        public string Reason;
        public Dictionary<string, string> Fingerprint;
        public string ContentHash;

        // ------------------------------------------------------- F-signatures

        /// <summary>
        /// True when TIA returned a <c>SafetySignatureProvider</c> for this
        /// object. The provider is authoritative: a block of an F-CPU that is
        /// not part of the safety program gets none, and an F-block always does.
        /// </summary>
        public bool IsSafetyBlock;

        /// <summary>The kind of signature, e.g. <c>BlockOfflineSignature</c>.</summary>
        public string SafetySignatureType;

        /// <summary>
        /// The signature value. <c>0</c> is a valid state ("no valid signature
        /// yet" or "a change invalidated it"); <c>null</c> means the object is
        /// not an F-block, which is why presence and value are separate.
        /// </summary>
        public ulong? SafetySignatureValue;

        /// <summary>Why reading the signature failed, when it did.</summary>
        public string SafetySignatureError;

        /// <summary>
        /// The fingerprint part of the change signature: the full fingerprint for
        /// a block / PLC type, the normalized content hash for a tag table.
        /// </summary>
        public string FingerprintPart
        {
            get
            {
                if (string.Equals(Category, EvidenceDocument.CategoryTagTables, StringComparison.Ordinal))
                {
                    return ContentHash ?? string.Empty;
                }
                return EvidenceDocument.FingerprintSignature(Fingerprint);
            }
        }

        /// <summary>
        /// The F-signature as one comparable token, empty for a non-F object.
        /// The provider's presence is part of it, so "became an F-block" and
        /// "stopped being one" are changes even when the fingerprints agree.
        /// </summary>
        public string SafetySignatureKey
        {
            get
            {
                if (!IsSafetyBlock) return string.Empty;
                return (SafetySignatureType ?? string.Empty)
                    + "|" + (SafetySignatureValue.HasValue
                        ? SafetySignatureValue.Value.ToString(CultureInfo.InvariantCulture)
                        : "-")
                    + (string.IsNullOrEmpty(SafetySignatureError) ? string.Empty : "|error");
            }
        }

        /// <summary>
        /// The value compared between two ledgers: the fingerprint (or content
        /// hash) plus the F-signature of safety blocks.
        /// </summary>
        public string Signature
        {
            get
            {
                string fingerprint = FingerprintPart;
                if (!IsSafetyBlock) return fingerprint;
                return fingerprint + "\nF:" + SafetySignatureKey;
            }
        }

        public EvidenceObject Clone()
        {
            EvidenceObject copy = new EvidenceObject();
            copy.Key = Key;
            copy.Category = Category;
            copy.Name = Name;
            copy.GroupPath = GroupPath;
            copy.Path = Path;
            copy.State = State;
            copy.Reason = Reason;
            copy.ContentHash = ContentHash;
            copy.IsSafetyBlock = IsSafetyBlock;
            copy.SafetySignatureType = SafetySignatureType;
            copy.SafetySignatureValue = SafetySignatureValue;
            copy.SafetySignatureError = SafetySignatureError;
            if (Fingerprint != null)
            {
                copy.Fingerprint = new Dictionary<string, string>(Fingerprint, StringComparer.Ordinal);
            }
            return copy;
        }
    }

    /// <summary>One object that disappeared from the PLC, with the checksum it was absent under.</summary>
    internal sealed class EvidenceTombstone
    {
        public string Key;
        public string Category;
        public string Name;
        public string GroupPath;
        public string RemovedAtChecksum;
        public string Reason;

        public EvidenceTombstone Clone()
        {
            return new EvidenceTombstone
            {
                Key = Key,
                Category = Category,
                Name = Name,
                GroupPath = GroupPath,
                RemovedAtChecksum = RemovedAtChecksum,
                Reason = Reason,
            };
        }
    }

    /// <summary>The three sets a comparison produces, all of them keyed by <see cref="EvidenceDocument.KeyOf"/>.</summary>
    internal sealed class EvidenceDelta
    {
        public readonly List<string> Changed = new List<string>();
        public readonly List<string> Added = new List<string>();
        public readonly List<string> Removed = new List<string>();
    }

    /// <summary>
    /// The evidence ledger of one device.
    ///
    /// It is written to the STAGE directory by <c>SyncScan</c> and committed into
    /// <c>source/&lt;device&gt;/_evidence.json</c> by the engineering-context
    /// plugin. The controller only ever reads and writes this document; it never
    /// touches git and does not know whether the directory is called STAGE or
    /// SOURCE.
    /// </summary>
    internal sealed class EvidenceDocument
    {
        public const int SchemaVersion = 1;
        public const string HashAlgorithm = "xml-norm-v1";

        public const string CategoryBlocks = "blocks";
        public const string CategoryTypes = "types";
        public const string CategoryTagTables = "tag_tables";

        public const string StatePresent = "present";
        public const string StateUnexportable = "unexportable";

        public string Device;
        public string Software;
        public string PlcChecksum;
        public string StateId;

        /// <summary>
        /// True when the scan that wrote this ledger asked
        /// <c>SafetySignatureProvider</c> for the blocks that could be safety
        /// blocks. A ledger written before F-signatures existed lacks the flag;
        /// the fast path then re-scans once to backfill instead of pretending
        /// the missing signatures are unchanged.
        /// </summary>
        public bool SafetyRecorded;

        public readonly Dictionary<string, EvidenceObject> Objects =
            new Dictionary<string, EvidenceObject>(StringComparer.Ordinal);
        public readonly List<EvidenceTombstone> Tombstones = new List<EvidenceTombstone>();

        /// <summary>
        /// The stable key of one object. The group path is part of it on purpose:
        /// moving a block between groups is a move, not a different object, and the
        /// key has to survive the path change in the source tree.
        /// </summary>
        public static string KeyOf(string category, string groupPath, string name)
        {
            string group = groupPath == null ? string.Empty : groupPath.Trim().Trim('/');
            return (category ?? string.Empty) + "|" + group + "|" + (name ?? string.Empty);
        }

        /// <summary>
        /// A deterministic signature of a fingerprint map.
        ///
        /// Fingerprint ids are face names (Code / Interface / Comments / …), not
        /// object ids, so they are sorted and joined here: two maps are equal iff
        /// every face has the same value.
        /// </summary>
        public static string FingerprintSignature(Dictionary<string, string> fingerprint)
        {
            if (fingerprint == null || fingerprint.Count == 0) return string.Empty;
            List<string> keys = new List<string>(fingerprint.Keys);
            keys.Sort(StringComparer.Ordinal);
            StringBuilder builder = new StringBuilder();
            foreach (string key in keys)
            {
                builder.Append(key).Append('=').Append(fingerprint[key] ?? string.Empty).Append('\n');
            }
            return builder.ToString();
        }

        /// <summary>
        /// Compare a previous ledger with the current facts.
        ///
        /// A missing previous ledger means "everything is new" (the initial full
        /// scan). An object whose signature differs is changed; a previous object
        /// whose key is gone is removed — the caller may only write a tombstone when
        /// the current listing was complete, which it always is here because the
        /// controller enumerates the composition itself instead of a capped list.
        ///
        /// A ledger written before F-signatures were recorded has no safety fields.
        /// For that first scan the fingerprint decides, so upgrading the controller
        /// does not report every F-block as changed; the new ledger then carries the
        /// signatures and later scans compare them too.
        /// </summary>
        public static EvidenceDelta Compare(EvidenceDocument previous, IDictionary<string, EvidenceObject> current)
        {
            EvidenceDelta delta = new EvidenceDelta();
            foreach (KeyValuePair<string, EvidenceObject> pair in current)
            {
                EvidenceObject before;
                if (previous == null || !previous.Objects.TryGetValue(pair.Key, out before))
                {
                    delta.Added.Add(pair.Key);
                    continue;
                }
                bool changed = !string.Equals(before.FingerprintPart, pair.Value.FingerprintPart, StringComparison.Ordinal);
                if (!changed && previous.SafetyRecorded)
                {
                    changed = !string.Equals(before.SafetySignatureKey, pair.Value.SafetySignatureKey, StringComparison.Ordinal);
                }
                if (changed) delta.Changed.Add(pair.Key);
            }

            if (previous != null)
            {
                foreach (string key in previous.Objects.Keys)
                {
                    if (!current.ContainsKey(key)) delta.Removed.Add(key);
                }
            }

            delta.Changed.Sort(StringComparer.Ordinal);
            delta.Added.Sort(StringComparer.Ordinal);
            delta.Removed.Sort(StringComparer.Ordinal);
            return delta;
        }

        /// <summary>
        /// Read one ledger. A missing file is a normal first run and yields
        /// <c>null</c>; an unreadable or incompatible file is a coded error, never a
        /// silent full rescan.
        /// </summary>
        public static EvidenceDocument Load(string path)
        {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return null;

            string text = File.ReadAllText(path);
            JsonArgs root;
            try
            {
                root = JsonArgs.Parse(text);
            }
            catch (ControllerException ex)
            {
                throw new ControllerException("evidence_invalid",
                    "The evidence file " + Text.Quote(path) + " is not valid JSON: " + ex.Message,
                    JsonObject.Of("path", path));
            }

            int schema = root.Int("schemaVersion", 0);
            if (schema != SchemaVersion)
            {
                throw new ControllerException("evidence_version_mismatch",
                    "The evidence file " + Text.Quote(path) + " has schemaVersion " + schema.ToString(CultureInfo.InvariantCulture)
                        + "; this controller writes " + SchemaVersion.ToString(CultureInfo.InvariantCulture)
                        + ". Rebuild the ledger with a full scan instead of guessing.",
                    JsonObject.Of("path", path, "schemaVersion", schema, "expected", SchemaVersion));
            }

            EvidenceDocument document = new EvidenceDocument();
            document.Device = root.String("device", null);
            document.Software = root.String("software", null);
            document.PlcChecksum = root.String("plcChecksum", null);
            document.StateId = root.String("stateId", null);
            document.SafetyRecorded = root.Bool("safetyRecorded", false);

            JsonArgs objects = root.Object("objects");
            foreach (string key in objects.Keys)
            {
                JsonArgs item = objects.Object(key);
                EvidenceObject entry = ReadObject(item, key);
                entry.State = StatePresent;
                document.Objects[key] = entry;
            }

            foreach (object raw in Items(root.Raw("unexportable")))
            {
                Dictionary<string, object> dictionary = raw as Dictionary<string, object>;
                if (dictionary == null) continue;
                JsonArgs item = JsonArgs.FromValue(dictionary, "unexportable[]");
                string key = item.String("key", null);
                if (string.IsNullOrEmpty(key))
                {
                    key = KeyOf(item.String("category", null), item.String("group", null), item.String("name", null));
                }
                EvidenceObject entry = ReadObject(item, key);
                entry.State = StateUnexportable;
                entry.Reason = item.String("reason", null);
                document.Objects[key] = entry;
            }

            foreach (object raw in Items(root.Raw("tombstones")))
            {
                Dictionary<string, object> dictionary = raw as Dictionary<string, object>;
                if (dictionary == null) continue;
                JsonArgs item = JsonArgs.FromValue(dictionary, "tombstones[]");
                EvidenceTombstone tombstone = new EvidenceTombstone();
                tombstone.Key = item.String("key", null);
                tombstone.Category = item.String("category", null);
                tombstone.Name = item.String("name", null);
                tombstone.GroupPath = item.String("group", null);
                tombstone.RemovedAtChecksum = item.String("removedAtChecksum", null);
                tombstone.Reason = item.String("reason", null);
                if (!string.IsNullOrEmpty(tombstone.Key)) document.Tombstones.Add(tombstone);
            }

            if (string.IsNullOrEmpty(document.StateId)) document.StateId = document.ComputeStateId();
            return document;
        }

        private static EvidenceObject ReadObject(JsonArgs item, string key)
        {
            EvidenceObject entry = new EvidenceObject();
            entry.Key = key;
            entry.Category = item.String("category", null);
            entry.Name = item.String("name", null);
            entry.GroupPath = item.String("group", null);
            entry.Path = item.String("path", null);
            entry.ContentHash = item.String("contentHash", null);
            entry.Fingerprint = ReadFingerprint(item.Object("fingerprint"));
            entry.IsSafetyBlock = item.Bool("isSafetyBlock", false);
            JsonArgs safety = item.Object("safetySignature");
            entry.SafetySignatureType = safety.String("type", null);
            entry.SafetySignatureValue = ReadUnsignedLong(safety.Raw("value"));
            entry.SafetySignatureError = safety.String("reason", null);
            return entry;
        }

        /// <summary>
        /// Reads the F-signature value without letting a malformed ledger carry a
        /// huge or negative number into the comparison.
        /// </summary>
        private static ulong? ReadUnsignedLong(object raw)
        {
            if (raw == null) return null;
            if (raw is ulong) return (ulong)raw;
            try
            {
                return Convert.ToUInt64(raw, CultureInfo.InvariantCulture);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static Dictionary<string, string> ReadFingerprint(JsonArgs fingerprint)
        {
            Dictionary<string, string> result = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (string id in fingerprint.Keys)
            {
                result[id] = fingerprint.String(id, null);
            }
            return result;
        }

        private static IEnumerable Items(object raw)
        {
            IEnumerable enumerable = raw as IEnumerable;
            if (enumerable == null) yield break;
            foreach (object item in enumerable) yield return item;
        }

        /// <summary>
        /// The ledger as JSON. Key order is fixed and every collection is sorted, so
        /// the same facts always produce the same bytes (a diff on this file means a
        /// real change).
        /// </summary>
        public JsonObject ToJson()
        {
            JsonObject root = new JsonObject();
            root.Add("schemaVersion", SchemaVersion);
            root.Add("hashAlgo", HashAlgorithm);
            root.Add("safetyRecorded", SafetyRecorded);
            root.Add("device", Device);
            root.Add("software", Software);
            root.Add("plcChecksum", PlcChecksum);
            root.Add("stateId", string.IsNullOrEmpty(StateId) ? ComputeStateId() : StateId);

            JsonObject objects = new JsonObject();
            List<string> presentKeys = new List<string>();
            foreach (KeyValuePair<string, EvidenceObject> pair in Objects)
            {
                if (pair.Value.State == StatePresent) presentKeys.Add(pair.Key);
            }
            presentKeys.Sort(StringComparer.Ordinal);
            foreach (string key in presentKeys) objects.Add(key, ObjectJson(Objects[key]));
            root.Add("objects", objects);

            List<string> unexportableKeys = new List<string>();
            foreach (KeyValuePair<string, EvidenceObject> pair in Objects)
            {
                if (pair.Value.State != StatePresent) unexportableKeys.Add(pair.Key);
            }
            unexportableKeys.Sort(StringComparer.Ordinal);
            List<JsonObject> unexportable = new List<JsonObject>();
            foreach (string key in unexportableKeys) unexportable.Add(ObjectJson(Objects[key]));
            root.Add("unexportable", unexportable);

            List<JsonObject> tombstones = new List<JsonObject>();
            foreach (EvidenceTombstone tombstone in Tombstones)
            {
                JsonObject item = new JsonObject();
                item.Add("key", tombstone.Key);
                item.Add("category", tombstone.Category);
                item.Add("name", tombstone.Name);
                if (!string.IsNullOrEmpty(tombstone.GroupPath)) item.Add("group", tombstone.GroupPath);
                item.Add("removedAtChecksum", tombstone.RemovedAtChecksum);
                item.Add("reason", tombstone.Reason);
                tombstones.Add(item);
            }
            root.Add("tombstones", tombstones);
            return root;
        }

        private static JsonObject ObjectJson(EvidenceObject entry)
        {
            JsonObject item = new JsonObject();
            item.Add("key", entry.Key);
            item.Add("category", entry.Category);
            item.Add("name", entry.Name);
            if (!string.IsNullOrEmpty(entry.GroupPath)) item.Add("group", entry.GroupPath);
            if (!string.IsNullOrEmpty(entry.Path)) item.Add("path", entry.Path);
            if (entry.Fingerprint != null && entry.Fingerprint.Count > 0)
            {
                JsonObject fingerprint = new JsonObject();
                List<string> ids = new List<string>(entry.Fingerprint.Keys);
                ids.Sort(StringComparer.Ordinal);
                foreach (string id in ids) fingerprint.Add(id, entry.Fingerprint[id]);
                item.Add("fingerprint", fingerprint);
            }
            if (!string.IsNullOrEmpty(entry.ContentHash)) item.Add("contentHash", entry.ContentHash);
            if (entry.IsSafetyBlock)
            {
                item.Add("isSafetyBlock", true);
                JsonObject safety = new JsonObject();
                safety.Add("type", entry.SafetySignatureType ?? "BlockOfflineSignature");
                if (entry.SafetySignatureValue.HasValue) safety.Add("value", entry.SafetySignatureValue.Value);
                if (!string.IsNullOrEmpty(entry.SafetySignatureError)) safety.Add("reason", entry.SafetySignatureError);
                item.Add("safetySignature", safety);
            }
            if (entry.State != StatePresent)
            {
                item.Add("state", entry.State);
                if (!string.IsNullOrEmpty(entry.Reason)) item.Add("reason", entry.Reason);
            }
            return item;
        }

        /// <summary>
        /// The identity of the engineering state this ledger describes: the PLC
        /// checksum plus one signature per object. It is what a commit trailer
        /// records so two commits can be compared without reading the XML.
        /// </summary>
        public string ComputeStateId()
        {
            List<string> keys = new List<string>(Objects.Keys);
            keys.Sort(StringComparer.Ordinal);
            StringBuilder builder = new StringBuilder();
            builder.Append(PlcChecksum ?? string.Empty).Append('\n');
            foreach (string key in keys)
            {
                builder.Append(key).Append('\t').Append(Objects[key].Signature).Append('\n');
            }
            return "sha256:" + Hashing.Sha256OfText(builder.ToString());
        }

        /// <summary>
        /// Normalize an exported XML file before hashing it.
        ///
        /// The export stamp in <c>&lt;DocumentInfo&gt;</c> changes on every export
        /// (MANIFEST-GAP-ANALYSIS.md §3), so hashing the raw bytes would report a
        /// change after every export. Only that metadata element and the line endings
        /// are removed; everything the engineer can edit is kept.
        /// </summary>
        public static string NormalizeXmlForHash(string text)
        {
            if (text == null) return string.Empty;
            string normalized = text;
            if (normalized.Length > 0 && normalized[0] == '\uFEFF') normalized = normalized.Substring(1);
            normalized = Regex.Replace(normalized, @"<DocumentInfo\b[^>]*/>", string.Empty, RegexOptions.IgnoreCase);
            normalized = Regex.Replace(normalized, @"<DocumentInfo\b.*?</DocumentInfo>", string.Empty,
                RegexOptions.IgnoreCase | RegexOptions.Singleline);
            normalized = normalized.Replace("\r\n", "\n").Replace('\r', '\n');
            return normalized;
        }
    }
}
