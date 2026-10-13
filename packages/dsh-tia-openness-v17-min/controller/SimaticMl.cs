using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>One object declared inside an external source file (SCL/STL source).</summary>
    internal sealed class ExternalSourceObject
    {
        public string Declaration;
        public string Name;
        public string BlockKind;
    }

    /// <summary>Header information of a Simatic ML export file.</summary>
    internal sealed class SimaticMlHeader
    {
        /// <summary>Root element of the document (usually <c>Document</c>).</summary>
        public string DocumentRoot;

        /// <summary>Element that carries the exported object, e.g. <c>SW.Blocks.FC</c>.</summary>
        public string ElementName;

        /// <summary><c>block</c>, <c>type</c>, <c>tag_table</c> or <c>unknown</c>.</summary>
        public string Kind = "unknown";

        /// <summary>Object family of this file: <c>blocks</c>, <c>types</c> or <c>tag_tables</c>.</summary>
        public string Category;

        /// <summary>Declared Simatic type, e.g. <c>FC</c>, <c>FB</c>, <c>OB</c>, <c>GlobalDB</c>, <c>PlcStruct</c>.</summary>
        public string SimaticType;

        public string Name;
        public string Number;
        public string ProgrammingLanguage;

        public List<string> Warnings = new List<string>();
    }

    /// <summary>
    /// Reads and validates the Simatic ML files this plugin exchanges, without
    /// ever handing unparsed input to Openness. Two shapes are supported:
    ///
    ///   * Simatic ML XML exported or imported block by block
    ///     (<c>&lt;Document&gt;&lt;SW.Blocks.FC&gt;...</c>), and
    ///   * SCL/STL external sources, which TIA turns into blocks itself.
    /// </summary>
    internal static class SimaticMl
    {
        /// <summary>File extensions treated as Simatic ML exports.</summary>
        private static readonly string[] XmlExtensions = { ".xml" };

        /// <summary>File extensions treated as PLC external sources.</summary>
        private static readonly string[] SourceExtensions = { ".scl", ".stl", ".db", ".udt", ".exp", ".txt", ".src" };

        /// <summary>Element name to Simatic object description, for the exports this plugin writes and reads.</summary>
        private static readonly Dictionary<string, string[]> ElementTypes = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
        {
            // element name -> { kind, simaticType, category }
            { "SW.Blocks.OB", new[] { "block", "OB", "blocks" } },
            { "SW.Blocks.FB", new[] { "block", "FB", "blocks" } },
            { "SW.Blocks.FC", new[] { "block", "FC", "blocks" } },
            { "SW.Blocks.GlobalDB", new[] { "block", "GlobalDB", "blocks" } },
            { "SW.Blocks.InstanceDB", new[] { "block", "InstanceDB", "blocks" } },
            { "SW.Blocks.ArrayDB", new[] { "block", "ArrayDB", "blocks" } },
            { "SW.Types.PlcStruct", new[] { "type", "PlcStruct", "types" } },
            { "SW.Types.PlcType", new[] { "type", "PlcType", "types" } },
            { "SW.Tags.PlcTagTable", new[] { "tag_table", "PlcTagTable", "tag_tables" } },
        };

        private static readonly Regex SourceDeclaration = new Regex(
            @"^[ \t]*(FUNCTION_BLOCK|ORGANIZATION_BLOCK|FUNCTION|DATA_BLOCK|TYPE|FB|FC|OB|DB)\s+""?([^""\s(;]+)""?",
            RegexOptions.Multiline | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        private static readonly Dictionary<string, string> SourceDeclarationKinds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { "FUNCTION_BLOCK", "FB" },
            { "FB", "FB" },
            { "FUNCTION", "FC" },
            { "FC", "FC" },
            { "ORGANIZATION_BLOCK", "OB" },
            { "OB", "OB" },
            { "DATA_BLOCK", "DB" },
            { "DB", "DB" },
            { "TYPE", "Type" },
        };

        public static bool LooksLikeSimaticMl(string path)
        {
            return HasExtension(path, XmlExtensions);
        }

        public static bool LooksLikeExternalSource(string path)
        {
            return HasExtension(path, SourceExtensions);
        }

        /// <summary>Extensible list of file extensions the import operation accepts.</summary>
        public static string[] SupportedExtensions()
        {
            List<string> all = new List<string>();
            all.AddRange(XmlExtensions);
            all.AddRange(SourceExtensions);
            return all.ToArray();
        }

        private static bool HasExtension(string path, string[] extensions)
        {
            string extension = Path.GetExtension(path);
            for (int i = 0; i < extensions.Length; i++)
            {
                if (string.Equals(extensions[i], extension, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        /// <summary>
        /// Reads the header of a Simatic ML file. Throws
        /// <see cref="ControllerException"/> with <c>invalid_file</c> when the file
        /// is not a well-formed Simatic ML export.
        /// </summary>
        public static SimaticMlHeader ReadHeader(string path)
        {
            XDocument document;
            try
            {
                document = XDocument.Load(path, LoadOptions.None);
            }
            catch (Exception ex)
            {
                throw new ControllerException(
                    "invalid_file",
                    "Simatic ML file " + Text.Quote(path) + " is not well-formed XML: " + ex.Message);
            }

            if (document.Root == null)
            {
                throw new ControllerException("invalid_file", "Simatic ML file " + Text.Quote(path) + " has no root element.");
            }

            SimaticMlHeader header = new SimaticMlHeader();
            header.DocumentRoot = document.Root.Name.LocalName;

            XElement element = document.Root;
            if (string.Equals(header.DocumentRoot, "Document", StringComparison.OrdinalIgnoreCase))
            {
                // A real TIA export wraps the object in metadata:
                //   <Document><Engineering version="V17"/><DocumentInfo>…</DocumentInfo><SW.Blocks.FB>…
                // Picking the first child naively would select <Engineering> and lose
                // the block name, which in turn would silently disable the write-after
                // verification, so the object element is selected explicitly.
                element = SelectObjectElement(document.Root);
                if (element == null)
                {
                    throw new ControllerException("invalid_file", "Simatic ML file " + Text.Quote(path) + " has an empty <Document> element.");
                }
                if (!element.Name.LocalName.StartsWith("SW.", StringComparison.OrdinalIgnoreCase))
                {
                    header.Warnings.Add("No <SW.*> object element was found; the object was taken from <" + element.Name.LocalName + ">.");
                }
            }
            else
            {
                header.Warnings.Add("The document root is <" + header.DocumentRoot + "> instead of <Document>.");
            }

            header.ElementName = element.Name.LocalName;
            string[] described;
            if (ElementTypes.TryGetValue(header.ElementName, out described))
            {
                header.Kind = described[0];
                header.SimaticType = described[1];
                header.Category = described[2];
            }
            else
            {
                header.Kind = "unknown";
                header.SimaticType = header.ElementName;
                header.Warnings.Add("Unrecognized Simatic ML element <" + header.ElementName + ">; it is not a PLC block or PLC type.");
            }

            XElement attributeList = FindChild(element, "AttributeList");
            if (attributeList != null)
            {
                header.Name = ValueOf(attributeList, "Name");
                header.Number = ValueOf(attributeList, "Number");
                header.ProgrammingLanguage = ValueOf(attributeList, "ProgrammingLanguage");
            }

            if (string.IsNullOrEmpty(header.Name))
            {
                // Some exports carry the name in an attribute of the object element.
                XAttribute nameAttribute = element.Attribute("Name");
                if (nameAttribute != null) header.Name = nameAttribute.Value;
            }

            if (string.IsNullOrEmpty(header.Name) && header.Kind != "type")
            {
                header.Warnings.Add("The file declares no block name, so an import cannot target it explicitly.");
            }

            return header;
        }

        /// <summary>Validates that a Simatic ML file can be parsed; returns the header on success.</summary>
        public static JsonObject DescribeSimaticMl(string path)
        {
            SimaticMlHeader header = ReadHeader(path);
            JsonObject result = new JsonObject();
            result.Add("file", path);
            result.Add("format", "simatic_ml");
            result.Add("documentRoot", header.DocumentRoot);
            result.Add("element", header.ElementName);
            result.Add("kind", header.Kind);
            result.Add("simaticType", header.SimaticType);
            result.AddIfPresent("name", header.Name);
            result.AddIfPresent("number", header.Number);
            result.AddIfPresent("programmingLanguage", header.ProgrammingLanguage);
            if (header.Warnings.Count > 0)
            {
                List<string> warnings = new List<string>(header.Warnings);
                result.Add("warnings", warnings);
            }
            return result;
        }

        /// <summary>
        /// Scans an external source file for the objects it declares. TIA decides
        /// the final names while generating blocks, so this scan is used for
        /// dry-run previews and verification targets, not as the source of truth.
        /// </summary>
        public static JsonObject DescribeExternalSource(string path)
        {
            string text;
            try
            {
                text = File.ReadAllText(path, DetectEncoding(path));
            }
            catch (Exception ex)
            {
                throw new ControllerException("invalid_file", "External source " + Text.Quote(path) + " could not be read: " + ex.Message);
            }

            List<ExternalSourceObject> objects = new List<ExternalSourceObject>();
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (Match match in SourceDeclaration.Matches(text))
            {
                string declaration = match.Groups[1].Value.ToUpperInvariant();
                string name = match.Groups[2].Value.Trim();
                if (name.Length == 0) continue;
                string key = declaration + "\u0000" + name;
                if (!seen.Add(key)) continue;

                ExternalSourceObject item = new ExternalSourceObject();
                item.Declaration = declaration;
                item.Name = name;
                string kind;
                item.BlockKind = SourceDeclarationKinds.TryGetValue(declaration, out kind) ? kind : "Unknown";
                objects.Add(item);
            }

            JsonObject result = new JsonObject();
            result.Add("file", path);
            result.Add("format", "external_source");
            result.Add("language", GuessSourceLanguage(path, text));
            result.Add("objectCount", objects.Count);

            List<JsonObject> declared = new List<JsonObject>();
            foreach (ExternalSourceObject item in objects)
            {
                declared.Add(JsonObject.Of(
                    "declaration", item.Declaration,
                    "name", item.Name,
                    "kind", item.BlockKind));
            }
            result.Add("objects", declared);

            if (objects.Count == 0)
            {
                result.Add("warning", "No FUNCTION_BLOCK/FUNCTION/DATA_BLOCK/ORGANIZATION_BLOCK/TYPE declaration was found; "
                    + "TIA may generate no blocks from this file.");
            }
            return result;
        }

        private static string GuessSourceLanguage(string path, string text)
        {
            string extension = Path.GetExtension(path);
            if (string.Equals(extension, ".scl", StringComparison.OrdinalIgnoreCase)) return "SCL";
            if (string.Equals(extension, ".stl", StringComparison.OrdinalIgnoreCase)) return "STL";
            if (Regex.IsMatch(text, @"^\s*(FUNCTION_BLOCK|FUNCTION|DATA_BLOCK|TYPE)\b", RegexOptions.Multiline | RegexOptions.IgnoreCase)) return "SCL";
            if (Regex.IsMatch(text, @"^\s*(ORGANIZATION_BLOCK|FB|FC|OB|DB)\b", RegexOptions.Multiline | RegexOptions.IgnoreCase)) return "STL";
            return "Unknown";
        }

        /// <summary>
        /// Best-effort detection of UTF-8 with or without a byte order mark;
        /// Openness itself accepts either, and so does this reader.
        /// </summary>
        private static System.Text.Encoding DetectEncoding(string path)
        {
            byte[] head = new byte[3];
            using (FileStream stream = File.OpenRead(path))
            {
                int read = stream.Read(head, 0, 3);
                if (read == 3 && head[0] == 0xEF && head[1] == 0xBB && head[2] == 0xBF)
                {
                    return new System.Text.UTF8Encoding(true);
                }
            }
            return new System.Text.UTF8Encoding(false);
        }

        /// <summary>
        /// Finds the element that carries the exported object inside a
        /// <c>&lt;Document&gt;</c> wrapper, skipping TIA's metadata elements
        /// (<c>Engineering</c>, <c>DocumentInfo</c>, …).
        /// </summary>
        private static XElement SelectObjectElement(XElement document)
        {
            foreach (XElement child in document.Elements())
            {
                if (child.Name.LocalName.StartsWith("SW.", StringComparison.OrdinalIgnoreCase)) return child;
            }
            foreach (XElement child in document.Elements())
            {
                string local = child.Name.LocalName;
                if (string.Equals(local, "Engineering", StringComparison.OrdinalIgnoreCase)) continue;
                if (string.Equals(local, "DocumentInfo", StringComparison.OrdinalIgnoreCase)) continue;
                if (FindChild(child, "AttributeList") != null) return child;
            }
            return FirstElementChild(document);
        }

        private static XElement FirstElementChild(XElement parent)
        {
            foreach (XElement child in parent.Elements()) return child;
            return null;
        }

        private static XElement FindChild(XElement parent, string localName)
        {
            foreach (XElement child in parent.Elements())
            {
                if (string.Equals(child.Name.LocalName, localName, StringComparison.OrdinalIgnoreCase)) return child;
            }
            return null;
        }

        private static string ValueOf(XElement parent, string localName)
        {
            XElement child = FindChild(parent, localName);
            return child == null ? null : child.Value.Trim();
        }
    }
}
