using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Web.Script.Serialization;

namespace TiaOpennessV17Min.Controller
{
    /// <summary>
    /// Insertion-ordered JSON object. Responses keep a stable key order so that
    /// humans reading the raw NDJSON stream see the same shape every time.
    /// </summary>
    internal sealed class JsonObject : IEnumerable<KeyValuePair<string, object>>
    {
        private readonly List<KeyValuePair<string, object>> _items = new List<KeyValuePair<string, object>>();

        public JsonObject Add(string key, object value)
        {
            _items.Add(new KeyValuePair<string, object>(key, value));
            return this;
        }

        /// <summary>Adds the pair only when the value is neither null nor an empty string.</summary>
        public JsonObject AddIfPresent(string key, string value)
        {
            if (!string.IsNullOrEmpty(value)) Add(key, value);
            return this;
        }

        /// <summary>Inserts a pair at the given position, keeping a stable key order.</summary>
        public JsonObject Insert(int index, string key, object value)
        {
            int position = index < 0 ? 0 : (index > _items.Count ? _items.Count : index);
            _items.Insert(position, new KeyValuePair<string, object>(key, value));
            return this;
        }

        /// <summary>Adds the pair only when the value is not null (an empty string is kept).</summary>
        public JsonObject AddIfPresent(string key, object value)
        {
            if (!(value is string)) { if (value != null) Add(key, value); return this; }
            return AddIfPresent(key, (string)value);
        }

        public int Count { get { return _items.Count; } }

        /// <summary>Returns the stored value, or null when the key is absent.</summary>
        public object this[string key]
        {
            get
            {
                for (int i = 0; i < _items.Count; i++)
                {
                    if (string.Equals(_items[i].Key, key, StringComparison.Ordinal)) return _items[i].Value;
                }
                return null;
            }
        }

        public IEnumerator<KeyValuePair<string, object>> GetEnumerator() { return _items.GetEnumerator(); }

        IEnumerator IEnumerable.GetEnumerator() { return _items.GetEnumerator(); }

        // Readers used by callers that hold an already-built object (for example a
        // projection from OpennessHost.DescribeSession) without a JsonArgs wrapper.

        public static string ReadString(JsonObject source, string key, string fallback)
        {
            if (source == null) return fallback;
            object value = source[key];
            return value == null ? fallback : System.Convert.ToString(value, CultureInfo.InvariantCulture);
        }

        public static bool ReadBool(JsonObject source, string key, bool fallback)
        {
            if (source == null) return fallback;
            object value = source[key];
            if (value is bool) return (bool)value;
            if (value == null) return fallback;
            bool parsed;
            return bool.TryParse(System.Convert.ToString(value, CultureInfo.InvariantCulture), out parsed) ? parsed : fallback;
        }

        public static int ReadInt(JsonObject source, string key, int fallback)
        {
            if (source == null) return fallback;
            object value = source[key];
            if (value is int) return (int)value;
            if (value == null) return fallback;
            int parsed;
            return int.TryParse(System.Convert.ToString(value, CultureInfo.InvariantCulture), NumberStyles.Integer,
                CultureInfo.InvariantCulture, out parsed) ? parsed : fallback;
        }

        /// <summary>Builds an object from alternating key/value arguments.</summary>
        public static JsonObject Of(params object[] keyValuePairs)
        {
            if (keyValuePairs == null) return new JsonObject();
            if (keyValuePairs.Length % 2 != 0) throw new ArgumentException("An even number of arguments is required.");
            JsonObject result = new JsonObject();
            for (int i = 0; i < keyValuePairs.Length; i += 2)
            {
                result.Add(System.Convert.ToString(keyValuePairs[i], CultureInfo.InvariantCulture), keyValuePairs[i + 1]);
            }
            return result;
        }
    }

    /// <summary>
    /// Minimal JSON writer for the subset the controller emits. Every value the
    /// controller produces is built from <see cref="JsonObject"/>, IDictionary,
    /// IList/IEnumerable, primitives and strings, so the writer stays small and
    /// has no dependency on a serializer package.
    /// </summary>
    internal static class JsonWriter
    {
        public static string Write(object value, bool pretty)
        {
            StringBuilder sb = new StringBuilder(512);
            WriteValue(sb, value, pretty, 0);
            return sb.ToString();
        }

        private static void WriteValue(StringBuilder sb, object value, bool pretty, int depth)
        {
            if (value == null) { sb.Append("null"); return; }

            if (value is string) { WriteString(sb, (string)value); return; }
            if (value is bool) { sb.Append(((bool)value) ? "true" : "false"); return; }
            if (value is char) { WriteString(sb, value.ToString()); return; }

            if (value is double)
            {
                double d = (double)value;
                if (double.IsNaN(d) || double.IsInfinity(d)) { sb.Append("null"); return; }
                sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
                return;
            }
            if (value is float)
            {
                float f = (float)value;
                if (float.IsNaN(f) || float.IsInfinity(f)) { sb.Append("null"); return; }
                sb.Append(f.ToString("R", CultureInfo.InvariantCulture));
                return;
            }
            if (value is decimal)
            {
                sb.Append(((decimal)value).ToString(CultureInfo.InvariantCulture));
                return;
            }
            if (IsInteger(value))
            {
                sb.Append(System.Convert.ToString(value, CultureInfo.InvariantCulture));
                return;
            }
            if (value is DateTime)
            {
                WriteString(sb, ((DateTime)value).ToUniversalTime()
                    .ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture));
                return;
            }
            if (value is TimeSpan)
            {
                sb.Append(((TimeSpan)value).TotalMilliseconds.ToString("R", CultureInfo.InvariantCulture));
                return;
            }
            if (value is Enum)
            {
                WriteString(sb, value.ToString());
                return;
            }
            if (value is Uri)
            {
                WriteString(sb, value.ToString());
                return;
            }

            JsonObject jsonObject = value as JsonObject;
            if (jsonObject != null) { WriteObject(sb, jsonObject, pretty, depth); return; }

            IDictionary dictionary = value as IDictionary;
            if (dictionary != null) { WriteDictionary(sb, dictionary, pretty, depth); return; }

            IEnumerable enumerable = value as IEnumerable;
            if (enumerable != null) { WriteArray(sb, enumerable, pretty, depth); return; }

            WriteString(sb, System.Convert.ToString(value, CultureInfo.InvariantCulture));
        }

        private static void WriteObject(StringBuilder sb, JsonObject value, bool pretty, int depth)
        {
            sb.Append('{');
            bool first = true;
            foreach (KeyValuePair<string, object> pair in value)
            {
                if (!first) sb.Append(',');
                first = false;
                NewLine(sb, pretty, depth + 1);
                WriteString(sb, pair.Key);
                sb.Append(':');
                if (pretty) sb.Append(' ');
                WriteValue(sb, pair.Value, pretty, depth + 1);
            }
            if (!first) NewLine(sb, pretty, depth);
            sb.Append('}');
        }

        private static void WriteDictionary(StringBuilder sb, IDictionary value, bool pretty, int depth)
        {
            sb.Append('{');
            bool first = true;
            foreach (DictionaryEntry entry in value)
            {
                if (!first) sb.Append(',');
                first = false;
                NewLine(sb, pretty, depth + 1);
                WriteString(sb, System.Convert.ToString(entry.Key, CultureInfo.InvariantCulture));
                sb.Append(':');
                if (pretty) sb.Append(' ');
                WriteValue(sb, entry.Value, pretty, depth + 1);
            }
            if (!first) NewLine(sb, pretty, depth);
            sb.Append('}');
        }

        private static void WriteArray(StringBuilder sb, IEnumerable value, bool pretty, int depth)
        {
            sb.Append('[');
            bool first = true;
            foreach (object item in value)
            {
                if (!first) sb.Append(',');
                first = false;
                NewLine(sb, pretty, depth + 1);
                WriteValue(sb, item, pretty, depth + 1);
            }
            if (!first) NewLine(sb, pretty, depth);
            sb.Append(']');
        }

        private static void NewLine(StringBuilder sb, bool pretty, int depth)
        {
            if (!pretty) return;
            sb.Append('\n');
            sb.Append(' ', depth * 2);
        }

        private static bool IsInteger(object value)
        {
            return value is byte || value is sbyte || value is short || value is ushort
                || value is int || value is uint || value is long || value is ulong;
        }

        private static void WriteString(StringBuilder sb, string value)
        {
            if (value == null) { sb.Append("null"); return; }
            sb.Append('"');
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ' || c == '\u007f' || c == '\u2028' || c == '\u2029')
                        {
                            sb.Append("\\u");
                            sb.Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            sb.Append(c);
                        }
                        break;
                }
            }
            sb.Append('"');
        }
    }

    /// <summary>
    /// Typed reader over one request's parameter object. Every accessor reports a
    /// wrong type or a missing required field as an <c>invalid_params</c>
    /// <see cref="ControllerException"/> instead of throwing a raw cast error, so
    /// the caller always receives a structured failure.
    /// </summary>
    internal sealed class JsonArgs
    {
        private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer
        {
            MaxJsonLength = int.MaxValue,
            RecursionLimit = 128,
        };

        private readonly Dictionary<string, object> _values;

        private JsonArgs(Dictionary<string, object> values)
        {
            _values = values ?? new Dictionary<string, object>(StringComparer.Ordinal);
        }

        public static JsonArgs Empty { get { return new JsonArgs(null); } }

        /// <summary>Parses a JSON object; a null, empty or whitespace body yields an empty argument set.</summary>
        public static JsonArgs Parse(string json)
        {
            if (string.IsNullOrWhiteSpace(json)) return Empty;
            object parsed;
            try
            {
                parsed = Serializer.DeserializeObject(json);
            }
            catch (Exception ex)
            {
                throw new ControllerException("invalid_params", "The parameter body is not valid JSON: " + ex.Message);
            }
            return FromValue(parsed, "parameters");
        }

        public static JsonArgs FromValue(object parsed, string location)
        {
            if (parsed == null) return Empty;
            Dictionary<string, object> dictionary = parsed as Dictionary<string, object>;
            if (dictionary == null)
            {
                throw new ControllerException("invalid_params", location + " must be a JSON object.");
            }
            return new JsonArgs(dictionary);
        }

        public IEnumerable<string> Keys { get { return _values.Keys; } }

        public bool Has(string name) { return _values.ContainsKey(name) && _values[name] != null; }

        public object Raw(string name)
        {
            object value;
            return _values.TryGetValue(name, out value) ? value : null;
        }

        public JsonArgs Object(string name)
        {
            if (!Has(name)) return Empty;
            return FromValue(_values[name], "'" + name + "'");
        }

        /// <summary>
        /// Reads an array of JSON objects; a single object is accepted as a one
        /// element list, and a missing value yields an empty list. Used by the
        /// parameters that describe one write per object (<c>tags</c>,
        /// <c>constants</c>).
        /// </summary>
        public List<JsonArgs> ObjectList(string name)
        {
            object value = Raw(name);
            List<JsonArgs> result = new List<JsonArgs>();
            if (value == null) return result;

            Dictionary<string, object> single = value as Dictionary<string, object>;
            if (single != null)
            {
                result.Add(FromValue(single, "'" + name + "'"));
                return result;
            }

            IEnumerable items = value as IEnumerable;
            if (items == null)
            {
                throw new ControllerException("invalid_params", "'" + name + "' must be an object or an array of objects.");
            }
            int index = 0;
            foreach (object item in items)
            {
                Dictionary<string, object> entry = item as Dictionary<string, object>;
                if (entry == null)
                {
                    throw new ControllerException("invalid_params",
                        "'" + name + "[" + index + "]' must be a JSON object.");
                }
                result.Add(FromValue(entry, "'" + name + "[" + index + "]'"));
                index++;
            }
            return result;
        }

        /// <summary>True when at least one of the named parameters is present and non-null.</summary>
        public bool HasAny(params string[] names)
        {
            foreach (string name in names)
            {
                if (Has(name)) return true;
            }
            return false;
        }

        public string String(string name, string fallback)
        {
            object value = Raw(name);
            if (value == null) return fallback;
            string text = value as string;
            if (text != null) return text;
            throw new ControllerException("invalid_params", "'" + name + "' must be a string.");
        }

        public string RequiredString(string name)
        {
            string text = String(name, null);
            if (string.IsNullOrWhiteSpace(text))
            {
                throw new ControllerException("invalid_params", "'" + name + "' is required and must be a non-empty string.");
            }
            return text;
        }

        public bool Bool(string name, bool fallback)
        {
            object value = Raw(name);
            if (value == null) return fallback;
            if (value is bool) return (bool)value;
            string text = value as string;
            if (text != null)
            {
                bool parsed;
                if (bool.TryParse(text, out parsed)) return parsed;
            }
            throw new ControllerException("invalid_params", "'" + name + "' must be a boolean.");
        }

        public int Int(string name, int fallback)
        {
            object value = Raw(name);
            if (value == null) return fallback;
            if (value is int) return (int)value;
            if (value is long) return checked((int)(long)value);
            if (value is decimal) return decimal.ToInt32((decimal)value);
            string text = value as string;
            int parsed;
            if (text != null && int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) return parsed;
            throw new ControllerException("invalid_params", "'" + name + "' must be an integer.");
        }

        /// <summary>Reads a string list; a single string is accepted as a one-element list.</summary>
        public List<string> StringList(string name)
        {
            object value = Raw(name);
            List<string> result = new List<string>();
            if (value == null) return result;

            string single = value as string;
            if (single != null)
            {
                if (!string.IsNullOrWhiteSpace(single)) result.Add(single);
                return result;
            }

            IEnumerable items = value as IEnumerable;
            if (items == null)
            {
                throw new ControllerException("invalid_params", "'" + name + "' must be a string or an array of strings.");
            }
            foreach (object item in items)
            {
                string text = item as string;
                if (text == null)
                {
                    throw new ControllerException("invalid_params", "'" + name + "' must contain only strings.");
                }
                if (!string.IsNullOrWhiteSpace(text)) result.Add(text);
            }
            return result;
        }

        /// <summary>Reads an enum-like string list and validates every member against <paramref name="allowed"/>.</summary>
        public List<string> EnumList(string name, IList<string> allowed)
        {
            List<string> values = StringList(name);
            List<string> result = new List<string>();
            foreach (string value in values)
            {
                string match = MatchEnum(value, allowed);
                if (match == null)
                {
                    throw new ControllerException(
                        "invalid_params",
                        "'" + name + "' contains the unknown value '" + value + "'. Allowed values: " + string.Join(", ", ToArray(allowed)) + ".");
                }
                if (!result.Contains(match)) result.Add(match);
            }
            return result;
        }

        public string Enum(string name, IList<string> allowed, string fallback)
        {
            string value = String(name, fallback);
            if (value == null) return null;
            string match = MatchEnum(value, allowed);
            if (match == null)
            {
                throw new ControllerException(
                    "invalid_params",
                    "'" + name + "' has the unknown value '" + value + "'. Allowed values: " + string.Join(", ", ToArray(allowed)) + ".");
            }
            return match;
        }

        /// <summary>Reads a mandatory enum-like string.</summary>
        public string RequiredEnum(string name, IList<string> allowed)
        {
            if (!Has(name))
            {
                throw new ControllerException("invalid_params",
                    "'" + name + "' is required. Allowed values: " + string.Join(", ", ToArray(allowed)) + ".");
            }
            return Enum(name, allowed, null);
        }

        private static string[] ToArray(IList<string> values)
        {
            string[] array = new string[values.Count];
            values.CopyTo(array, 0);
            return array;
        }

        private static string MatchEnum(string value, IList<string> allowed)
        {
            foreach (string candidate in allowed)
            {
                if (string.Equals(candidate, value, StringComparison.OrdinalIgnoreCase)) return candidate;
            }
            return null;
        }
    }

    /// <summary>
    /// Converts a JSON scalar into the CLR value an Openness attribute expects.
    ///
    /// JSON alone is not enough: <c>SetAttribute("Priority", 14)</c> wants an
    /// <see cref="System.Int32"/> while the TIA Portal setting
    /// <c>UserInterfaceLanguage</c> wants a <see cref="CultureInfo"/>. The caller
    /// therefore names the target type, and <c>auto</c> keeps what JSON produced.
    /// </summary>
    internal static class Values
    {
        /// <summary>Accepted <c>value_type</c> names, in documentation order.</summary>
        public static readonly string[] TypeNames = { "auto", "string", "boolean", "integer", "culture" };

        public static object Convert(object raw, string valueType, string parameterName)
        {
            string type = string.IsNullOrEmpty(valueType) ? "auto" : valueType.ToLowerInvariant();
            switch (type)
            {
                case "auto":
                    return raw;
                case "string":
                    return System.Convert.ToString(raw, CultureInfo.InvariantCulture);
                case "boolean":
                    if (raw is bool) return raw;
                    {
                        bool parsed;
                        string text = System.Convert.ToString(raw, CultureInfo.InvariantCulture);
                        if (bool.TryParse(text, out parsed)) return parsed;
                        throw new ControllerException("invalid_params",
                            "'" + parameterName + "' is not a boolean: " + Text.Quote(text));
                    }
                case "integer":
                    if (raw is int) return raw;
                    if (raw is long) return (int)(long)raw;
                    if (raw is decimal) return decimal.ToInt32((decimal)raw);
                    {
                        int parsed;
                        string text = System.Convert.ToString(raw, CultureInfo.InvariantCulture);
                        if (int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) return parsed;
                        throw new ControllerException("invalid_params",
                            "'" + parameterName + "' is not an integer: " + Text.Quote(text));
                    }
                case "culture":
                    {
                        string text = System.Convert.ToString(raw, CultureInfo.InvariantCulture);
                        try
                        {
                            return CultureInfo.GetCultureInfo(text);
                        }
                        catch (Exception ex)
                        {
                            throw new ControllerException("invalid_params",
                                "'" + parameterName + "' is not a known culture name: " + Text.Quote(text) + " (" + ex.Message + ").");
                        }
                    }
                default:
                    throw new ControllerException("invalid_params",
                        "'" + parameterName + "' has the unknown value " + Text.Quote(type)
                            + ". Allowed: " + string.Join(", ", TypeNames) + ".");
            }
        }

        /// <summary>Renders any Openness attribute value for the JSON payload.</summary>
        public static object Printable(object value)
        {
            if (value == null) return null;
            if (value is CultureInfo) return ((CultureInfo)value).Name;
            if (value is DateTime) return value;
            if (value is bool || value is string || value is int || value is long || value is double || value is decimal)
            {
                return value;
            }
            if (value is Enum) return value.ToString();
            return System.Convert.ToString(value, CultureInfo.InvariantCulture);
        }
    }
}
