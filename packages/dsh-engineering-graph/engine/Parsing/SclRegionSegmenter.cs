// ---------------------------------------------------------------------------
// New code (not vendored): SCL segmentation for the knowledge graph.
//
// Why this file exists: Openness exports a pure SCL block as ONE
// `<SW.Blocks.CompileUnit>` whose `<StructuredText>` holds the whole body — a
// single "network" of up to ~84,000 characters. Read that as one unit and the
// model gets a 6,000-character slice per call plus a read/write list mixing
// every variable of the block, so neither the tag list nor the chunk offset can
// tell it where the logic it wants actually is (docs/decisions.md D26 measured
// this; D27 is the fix).
//
// The fix is the user's: a REGION is the SCL equivalent of a LAD network, so it
// becomes the addressable unit. This file turns one CompileUnit into ordered
// segments, each carrying its region path, its own body text, and the enclosing
// control structures (41% of real regions open inside IF/CASE, so a segment body
// is often a syntactic fragment — the model has to be told).
//
// Three rules are deliberately more than "split at top-level REGION":
//   * regions nest (depth up to 3 in the reference project), so every depth is
//     split — top-level-only left a 56,801-character segment behind;
//   * code outside any region is its own `module` segment, so its accesses are
//     never lost;
//   * a segment still over `MaxSegmentChars` is cut at statement boundaries into
//     `part` segments (19 of 22 large SCL blocks in the reference project have
//     no REGION at all — without this rule they would not improve).
//
// Naming rule: docs/decisions.md D17.
using System.Text;
using System.Xml.Linq;

namespace EngineeringGraph.Engine;

/// <summary>
/// Renders the SCL `<StructuredText>` token stream to text.
/// </summary>
/// <remarks>
/// Moved out of <see cref="ProgramBlockLogicYamlWriter"/> so the segmenter and the
/// translator share ONE renderer: a second copy would let the segment text drift
/// from the network logic text, and the D27 acceptance check compares them.
/// The element handling is unchanged from the original translator.
/// </remarks>
public static class SclTextRenderer
{
    /// <summary>Renders a `<NetworkSource>` (or any element holding a `<StructuredText>`).</summary>
    public static string RenderNetworkSource(XElement networkSource)
    {
        if (networkSource == null)
        {
            return string.Empty;
        }

        var structuredText = networkSource
            .Descendants()
            .FirstOrDefault(element => element.Name.LocalName == "StructuredText");

        return structuredText == null ? string.Empty : RenderElements(structuredText.Elements());
    }

    /// <summary>Renders a sequence of SCL elements to trimmed text.</summary>
    public static string RenderElements(IEnumerable<XElement> elements)
    {
        var builder = new StringBuilder();
        foreach (var element in elements)
        {
            AppendElement(builder, element);
        }

        return Trim(builder.ToString());
    }

    /// <summary>Renders one element of an SCL element list to trimmed text.</summary>
    public static string RenderElement(XElement element)
    {
        var builder = new StringBuilder();
        AppendElement(builder, element);
        return Trim(builder.ToString());
    }

    /// <summary>Normalises line endings and indentation, then trims.</summary>
    public static string Trim(string source)
    {
        var lines = source
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n')
            .Split('\n')
            .Select(line => line.TrimEnd())
            .ToArray();

        return string.Join("\n", lines).Trim();
    }

    /// <summary>Characters the element renders to, before trimming.</summary>
    internal static int Measure(XElement element)
    {
        var builder = new StringBuilder();
        AppendElement(builder, element);
        return builder.Length;
    }

    internal static void AppendElement(StringBuilder builder, XElement element)
    {
        switch (element.Name.LocalName)
        {
            case "Blank":
                builder.Append(' ');
                return;
            case "NewLine":
                builder.AppendLine();
                return;
            case "Token":
                builder.Append(((string?)element.Attribute("Text")) ?? element.Value);
                return;
            case "LineComment":
                // Openness keeps a commented-out SCL line in a LineComment element
                // whose <Text> is the raw line. The comment marker itself exists
                // only as the element name, so emitting the text verbatim made the
                // "comment stripper" (SplitSclStatements/StripSclComments) treat it
                // as executable code. Restore the marker, then the stripper sees a
                // comment exactly as it would in a real // line.
                AppendCommentedLines(builder, element.Value);
                return;
            case "Comment":
            case "BlockComment":
                builder.AppendLine("/*");
                AppendCommentedLines(builder, element.Value);
                builder.AppendLine("*/");
                return;
            case "Component":
                builder.Append(FormatComponentName(element));
                foreach (var child in element.Elements())
                {
                    AppendElement(builder, child);
                }

                return;
            case "Instruction":
                builder.Append(((string?)element.Attribute("Name")) ?? element.Value);
                foreach (var child in element.Elements())
                {
                    AppendElement(builder, child);
                }

                return;
            case "Parameter":
                builder.Append(((string?)element.Attribute("Name")) ?? element.Value);
                foreach (var child in element.Elements())
                {
                    AppendElement(builder, child);
                }

                return;
            case "ConstantValue":
                builder.Append(element.Value);
                return;
            case "Constant":
                // Openness writes a named constant (`ZERO`, `ZERO_TIME`) as
                // `<Constant Name="ZERO"/>` with no text at all. Rendering nothing
                // turned `IF frequency <= ZERO THEN` into `IF frequency <=  THEN`,
                // which reads like broken code; the name is the expression.
                builder.Append(((string?)element.Attribute("Name"))?.Trim() ?? string.Empty);
                foreach (var child in element.Elements())
                {
                    AppendElement(builder, child);
                }

                return;
            case "PredefinedVariable":
                // `ENO := TRUE;` renders as ` := TRUE;` without this: the name lives
                // on the element, not in its text (same class of defect as Constant).
                builder.Append(((string?)element.Attribute("Name"))?.Trim() ?? element.Value);
                return;
            default:
                foreach (var child in element.Elements())
                {
                    AppendElement(builder, child);
                }

                if (!element.Elements().Any() && !string.IsNullOrWhiteSpace(element.Value))
                {
                    builder.Append(element.Value.Trim());
                }

                return;
        }
    }

    /// <summary>
    /// Appends a commented-out block line by line, prefixing each line with `//`.
    /// </summary>
    /// <remarks>
    /// Openness stores a commented-out SCL statement as a `LineComment` element
    /// whose `<Text>` can span several lines. Prefixing only the first one would
    /// leave the rest looking like executable code, which is exactly the defect this
    /// fixes (docs/decisions.md D25), so every line gets the marker.
    /// </remarks>
    internal static void AppendCommentedLines(StringBuilder builder, string? text)
    {
        foreach (var line in (text ?? string.Empty)
                     .Replace("\r\n", "\n", StringComparison.Ordinal)
                     .Replace('\r', '\n')
                     .Split('\n'))
        {
            builder.Append("// ").Append(line.Trim()).AppendLine();
        }
    }

    internal static string FormatComponentName(XElement component)
    {
        var name = ((string?)component.Attribute("Name"))?.Trim() ?? component.Value ?? string.Empty;
        var slice = ((string?)component.Attribute("SliceAccessModifier"))?.Trim();
        if (string.IsNullOrWhiteSpace(slice))
        {
            return name;
        }

        return $"{name}.%{slice!.ToUpperInvariant()}";
    }
}

/// <summary>One addressable SCL segment: a REGION, a run of unregioned code, or a part of one.</summary>
public sealed class SclSegment
{
    internal SclSegment(
        int index,
        string compileUnitId,
        int tiaNetworkIndex,
        string kind,
        string title,
        string regionPath,
        string regionName,
        int regionDepth,
        string enclosingControl,
        string text,
        IReadOnlyList<XElement> elements)
    {
        Index = index;
        CompileUnitId = compileUnitId;
        TiaNetworkIndex = tiaNetworkIndex;
        Kind = kind;
        Title = title;
        RegionPath = regionPath;
        RegionName = regionName;
        RegionDepth = regionDepth;
        EnclosingControl = enclosingControl;
        Text = text;
        Elements = elements;
    }

    /// <summary>1-based segment index inside the block; this is the `networkIndex` the tools read.</summary>
    public int Index { get; }

    /// <summary>The Openness CompileUnit this segment came from.</summary>
    public string CompileUnitId { get; }

    /// <summary>1-based CompileUnit ordinal in the block — the TIA network number.</summary>
    public int TiaNetworkIndex { get; }

    /// <summary>`region`, `module` (code outside every region) or `part` (a cut of an oversized segment).</summary>
    public string Kind { get; }

    /// <summary>What the model sees as the segment title: the region path, or the network title.</summary>
    public string Title { get; }

    /// <summary>Names of the enclosing regions, innermost last; empty outside every region.</summary>
    public string RegionPath { get; }

    public string RegionName { get; }

    public int RegionDepth { get; }

    /// <summary>The control structures open where this segment starts, e.g. `IF tempEnable THEN`.</summary>
    public string EnclosingControl { get; }

    /// <summary>The segment's own body, rendered and trimmed (no REGION/END_REGION lines).</summary>
    public string Text { get; }

    /// <summary>The direct `<StructuredText>` children that make up this segment.</summary>
    internal IReadOnlyList<XElement> Elements { get; }

    /// <summary>The key the logic translator and the importer use to join logic to a segment.</summary>
    public string Key => $"{CompileUnitId}#{Index}";

    /// <summary>Descendants of this segment's elements with the given local name.</summary>
    public int CountDescendants(string localName)
    {
        return Elements
            .SelectMany(element => element.DescendantsAndSelf())
            .Count(element => element.Name.LocalName == localName);
    }
}

/// <summary>The segments of one CompileUnit, plus the element-to-segment map the reference parser needs.</summary>
public sealed class SclSegmentation
{
    private readonly IReadOnlyDictionary<XElement, int> _segmentByElement;

    internal SclSegmentation(IReadOnlyList<SclSegment> segments, IReadOnlyDictionary<XElement, int> segmentByElement)
    {
        Segments = segments;
        _segmentByElement = segmentByElement;
    }

    public IReadOnlyList<SclSegment> Segments { get; }

    /// <summary>The segment an element belongs to, or 0 when it belongs to none (region tokens, headers).</summary>
    public int SegmentOf(XElement element)
    {
        return _segmentByElement.TryGetValue(element, out var index) ? index : 0;
    }
}

/// <summary>
/// Turns one SCL CompileUnit into ordered segments (docs/decisions.md D27).
/// </summary>
public static class SclRegionSegmenter
{
    /// <summary>Characters above which a segment is cut into parts, matching the tool's hard read cap.</summary>
    public const int MaxSegmentChars = 6000;

    /// <summary>Characters a part aims for when a segment has to be cut.</summary>
    public const int TargetPartChars = 4500;

    private const int MaxHeaderChars = 140;
    private const int MaxContextChars = 240;

    /// <summary>
    /// Segments one SCL CompileUnit.
    /// </summary>
    /// <param name="compileUnit">The `SW.Blocks.CompileUnit` element.</param>
    /// <param name="compileUnitId">Its `ID` attribute (may be empty).</param>
    /// <param name="tiaNetworkIndex">Its 1-based ordinal in the block.</param>
    /// <param name="compileUnitTitle">Its multilingual Title, used when code sits outside every region.</param>
    public static SclSegmentation Segment(
        XElement compileUnit,
        string compileUnitId,
        int tiaNetworkIndex,
        string compileUnitTitle)
    {
        ArgumentNullException.ThrowIfNull(compileUnit);

        var structuredText = compileUnit
            .Descendants()
            .FirstOrDefault(element => element.Name.LocalName == "StructuredText");
        var children = structuredText?.Elements().ToArray() ?? Array.Empty<XElement>();

        var builders = new List<SegmentBuilder>();
        var stack = new List<string>();
        var control = new ControlTracker();
        var current = new SegmentBuilder(stack, control.Snapshot());

        void Flush()
        {
            if (current.Elements.Count > 0)
            {
                builders.Add(current);
            }
        }

        for (var index = 0; index < children.Length; index++)
        {
            var child = children[index];

            if (IsRegionToken(child, "REGION"))
            {
                Flush();
                var name = RegionName(children, index);
                stack.Add(name);
                index = SkipRegionHeader(children, index);
                current = new SegmentBuilder(stack, control.Snapshot());
                continue;
            }

            if (IsRegionToken(child, "END_REGION"))
            {
                Flush();
                if (stack.Count > 0)
                {
                    stack.RemoveAt(stack.Count - 1);
                }

                // Openness repeats the region name after END_REGION
                // (`END_REGION`, `Blank`, `Text<name>`, `NewLine`). Leaving it in the
                // following segment made a run of unregioned code read as
                // "Block info header" — the name of the region that just closed.
                index = SkipRegionHeader(children, index);
                current = new SegmentBuilder(stack, control.Snapshot());
                continue;
            }

            current.Elements.Add(child);
            control.Observe(child);
        }

        Flush();

        var moduleTitle = string.IsNullOrWhiteSpace(compileUnitTitle)
            ? $"Network {tiaNetworkIndex}"
            : compileUnitTitle.Trim();
        var moduleRun = 0;

        var segments = new List<SclSegment>();
        foreach (var builder in builders)
        {
            var text = SclTextRenderer.RenderElements(builder.Elements);
            if (string.IsNullOrWhiteSpace(text))
            {
                continue;
            }

            var isRegion = builder.Path.Count > 0;
            if (!isRegion && !HasMeaningfulText(text))
            {
                // A run of code outside every region that renders to `;` or nothing is
                // the gap between two REGIONs, not a segment: listing it would put a
                // 1-character "Network 1" row between real regions on every block.
                continue;
            }

            string title;
            if (isRegion)
            {
                title = string.Join(" / ", builder.Path);
            }
            else
            {
                moduleRun++;
                title = moduleRun == 1 ? moduleTitle : $"{moduleTitle} (block level {moduleRun})";
            }

            var regionPath = isRegion ? string.Join(" / ", builder.Path) : string.Empty;
            var regionName = isRegion ? builder.Path[builder.Path.Count - 1] : string.Empty;

            if (text.Length <= MaxSegmentChars)
            {
                segments.Add(new SclSegment(
                    segments.Count + 1,
                    compileUnitId,
                    tiaNetworkIndex,
                    isRegion ? SegmentKinds.Region : SegmentKinds.Module,
                    title,
                    regionPath,
                    regionName,
                    builder.Path.Count,
                    builder.EnclosingControl,
                    text,
                    builder.Elements));
                continue;
            }

            var parts = SplitParts(builder.Elements);
            for (var part = 0; part < parts.Count; part++)
            {
                var partElements = parts[part];
                var partText = SclTextRenderer.RenderElements(partElements);
                if (string.IsNullOrWhiteSpace(partText))
                {
                    continue;
                }

                segments.Add(new SclSegment(
                    segments.Count + 1,
                    compileUnitId,
                    tiaNetworkIndex,
                    SegmentKinds.Part,
                    $"{title} (part {part + 1}/{parts.Count})",
                    regionPath,
                    regionName,
                    builder.Path.Count,
                    builder.EnclosingControl,
                    partText,
                    partElements));
            }
        }

        var ownerByElement = new Dictionary<XElement, int>();
        foreach (var segment in segments)
        {
            foreach (var element in segment.Elements)
            {
                foreach (var descendant in element.DescendantsAndSelf())
                {
                    ownerByElement[descendant] = segment.Index;
                }
            }
        }

        return new SclSegmentation(segments, ownerByElement);
    }

    private static bool IsRegionToken(XElement element, string keyword)
    {
        return element.Name.LocalName == "Token" &&
            string.Equals(((string?)element.Attribute("Text"))?.Trim(), keyword, StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsBlank(XElement element) => element.Name.LocalName == "Blank";

    private static bool IsNewLine(XElement element) => element.Name.LocalName == "NewLine";

    /// <summary>The region name follows the REGION token as `Blank`, `Text`, `NewLine`.</summary>
    private static string RegionName(IReadOnlyList<XElement> children, int regionIndex)
    {
        var index = regionIndex + 1;
        while (index < children.Count && IsBlank(children[index]))
        {
            index++;
        }

        if (index < children.Count && children[index].Name.LocalName == "Text")
        {
            var name = children[index].Value.Trim();
            if (name.Length > 0)
            {
                return name;
            }
        }

        return "(unnamed region)";
    }

    /// <summary>
    /// Consumes a region name header (`Blank`, name `Text`, `NewLine`) after a
    /// REGION or END_REGION token. When no `Text` follows, nothing is consumed —
    /// the blanks and newlines then belong to the next segment's body.
    /// </summary>
    private static int SkipRegionHeader(IReadOnlyList<XElement> children, int regionIndex)
    {
        var index = regionIndex + 1;
        while (index < children.Count && IsBlank(children[index]))
        {
            index++;
        }

        if (index >= children.Count || children[index].Name.LocalName != "Text")
        {
            return regionIndex;
        }

        index++;
        while (index < children.Count && (IsBlank(children[index]) || IsNewLine(children[index])))
        {
            index++;
        }

        return index - 1;
    }

    /// <summary>
    /// Cuts an oversized element list at statement boundaries.
    /// </summary>
    /// <remarks>
    /// A cut before element <c>i</c> is allowed when element <c>i-1</c> is the `;` that
    /// closes a statement; it is *preferred* when no control structure is open there,
    /// because then each part is a run of complete statements. When no boundary comes
    /// up before twice the cap, the list is cut anyway: an artificially broken
    /// statement is easier to read than a 60,000-character part.
    /// </remarks>
    private static IReadOnlyList<IReadOnlyList<XElement>> SplitParts(IReadOnlyList<XElement> elements)
    {
        var lengths = new int[elements.Count];
        for (var index = 0; index < elements.Count; index++)
        {
            lengths[index] = SclTextRenderer.Measure(elements[index]);
        }

        var cuts = new bool[elements.Count + 1];
        var preferred = new bool[elements.Count + 1];
        var controlDepth = 0;
        for (var index = 0; index < elements.Count; index++)
        {
            if (index > 0 && IsStatementEnd(elements[index - 1]))
            {
                cuts[index] = true;
                preferred[index] = controlDepth == 0;
            }

            controlDepth += ControlDelta(elements[index]);
            if (controlDepth < 0)
            {
                controlDepth = 0;
            }
        }

        var parts = new List<IReadOnlyList<XElement>>();
        var start = 0;
        long accumulated = 0;
        var lastCut = -1;
        var lastPreferred = -1;

        for (var index = 0; index < elements.Count; index++)
        {
            accumulated += lengths[index];

            var next = index + 1;
            if (next < elements.Count + 1)
            {
                if (cuts[next])
                {
                    lastCut = next;
                }

                if (preferred[next])
                {
                    lastPreferred = next;
                }
            }

            int cut;
            if (accumulated >= MaxSegmentChars * 2)
            {
                cut = lastPreferred > start ? lastPreferred : (lastCut > start ? lastCut : next);
            }
            else if (accumulated >= MaxSegmentChars)
            {
                cut = lastPreferred > start ? lastPreferred : (lastCut > start ? lastCut : -1);
            }
            else if (accumulated >= TargetPartChars && lastPreferred > start)
            {
                cut = lastPreferred;
            }
            else
            {
                cut = -1;
            }

            if (cut <= start || cut > elements.Count)
            {
                continue;
            }

            parts.Add(Slice(elements, start, cut - start));
            start = cut;
            accumulated = 0;
            lastCut = -1;
            lastPreferred = -1;
            index = cut - 1;
        }

        if (start < elements.Count)
        {
            parts.Add(Slice(elements, start, elements.Count - start));
        }

        return parts;
    }

    private static IReadOnlyList<XElement> Slice(IReadOnlyList<XElement> elements, int start, int count)
    {
        var slice = new XElement[count];
        for (var index = 0; index < count; index++)
        {
            slice[index] = elements[start + index];
        }

        return slice;
    }

    private static bool IsStatementEnd(XElement element)
    {
        return element.Name.LocalName == "Token" &&
            string.Equals(((string?)element.Attribute("Text"))?.Trim(), ";", StringComparison.Ordinal);
    }

    /// <summary>
    /// Whether rendered text carries anything beyond punctuation, whitespace and
    /// comment markers.
    /// </summary>
    /// <remarks>
    /// Used to drop `module` runs that are only the `;` between two regions or a
    /// `//-----` separator line: they would add a one-line "Network 1" row per gap.
    /// Comment-only runs that say something are kept, so documentation outside a
    /// region is not lost.
    /// </remarks>
    private static bool HasMeaningfulText(string text)
    {
        foreach (var rawLine in text.Split('\n'))
        {
            var line = rawLine.Trim();
            if (line.StartsWith("//", StringComparison.Ordinal))
            {
                line = line.Substring(2);
            }

            line = line.Replace("/*", string.Empty, StringComparison.Ordinal)
                .Replace("*/", string.Empty, StringComparison.Ordinal);

            if (line.Any(character =>
                    char.IsLetterOrDigit(character) || character is '_' or '\'' or '"' or '#' or '%'))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>How an element changes the open-control depth: +1 open, -1 close, 0 neither.</summary>
    private static int ControlDelta(XElement element)
    {
        if (element.Name.LocalName != "Token")
        {
            return 0;
        }

        var token = ((string?)element.Attribute("Text"))?.Trim().ToUpperInvariant();
        return token switch
        {
            "IF" or "FOR" or "WHILE" or "CASE" or "REPEAT" => 1,
            "END_IF" or "END_FOR" or "END_WHILE" or "END_CASE" or "UNTIL" => -1,
            _ => 0,
        };
    }

    /// <summary>Known values of <see cref="SclSegment.Kind"/>.</summary>
    public static class SegmentKinds
    {
        public const string Region = "region";
        public const string Module = "module";
        public const string Part = "part";
        public const string Network = "network";
    }

    private sealed class SegmentBuilder
    {
        public SegmentBuilder(IReadOnlyList<string> path, string enclosingControl)
        {
            Path = path.ToArray();
            EnclosingControl = enclosingControl;
            Elements = new List<XElement>();
        }

        public IReadOnlyList<string> Path { get; }

        public string EnclosingControl { get; }

        public List<XElement> Elements { get; }
    }

    /// <summary>
    /// Tracks the IF/FOR/WHILE/CASE/REPEAT structures open at any point of the token stream.
    /// </summary>
    /// <remarks>
    /// The header text is captured until the structure's own keyword (`THEN`, `OF`,
    /// `DO`), so a segment that starts inside a structure can say *which* structure —
    /// "inside IF NOT tempEnable AND statEnableOld THEN" is the difference between a
    /// readable fragment and a misleading one.
    /// </remarks>
    private sealed class ControlTracker
    {
        private readonly List<string> _headers = new();
        private readonly StringBuilder _capturing = new();
        private string? _terminator;

        public void Observe(XElement element)
        {
            if (element.Name.LocalName == "Token")
            {
                var token = ((string?)element.Attribute("Text"))?.Trim().ToUpperInvariant() ?? string.Empty;

                if (_terminator != null)
                {
                    Append(element);
                    if (string.Equals(token, _terminator, StringComparison.Ordinal))
                    {
                        FinishCapture();
                    }

                    return;
                }

                switch (token)
                {
                    case "IF":
                        StartCapture("IF", "THEN");
                        return;
                    case "CASE":
                        StartCapture("CASE", "OF");
                        return;
                    case "FOR":
                    case "WHILE":
                        StartCapture(token, "DO");
                        return;
                    case "REPEAT":
                        Push("REPEAT");
                        return;
                    case "END_IF":
                    case "END_FOR":
                    case "END_WHILE":
                    case "END_CASE":
                    case "UNTIL":
                        Pop();
                        return;
                }

                return;
            }

            if (_terminator != null)
            {
                Append(element);
            }
        }

        public string Snapshot()
        {
            if (_headers.Count == 0)
            {
                return string.Empty;
            }

            var text = string.Join(" / ", _headers);
            return text.Length <= MaxContextChars ? text : text.Substring(0, MaxContextChars).TrimEnd();
        }

        private void StartCapture(string keyword, string terminator)
        {
            _capturing.Clear();
            _capturing.Append(keyword);
            _terminator = terminator;
        }

        private void FinishCapture()
        {
            Push(_capturing.ToString());
            _capturing.Clear();
            _terminator = null;
        }

        private void Push(string header)
        {
            var text = CollapseWhitespace(header);
            if (text.Length > MaxHeaderChars)
            {
                text = text.Substring(0, MaxHeaderChars).TrimEnd();
            }

            _headers.Add(text);
        }

        private void Pop()
        {
            if (_headers.Count > 0)
            {
                _headers.RemoveAt(_headers.Count - 1);
            }
        }

        private void Append(XElement element)
        {
            if (_capturing.Length > MaxHeaderChars)
            {
                FinishCapture();
                return;
            }

            if (element.Name.LocalName == "Blank")
            {
                _capturing.Append(' ');
                return;
            }

            if (element.Name.LocalName == "NewLine")
            {
                _capturing.Append(' ');
                return;
            }

            _capturing.Append(SclTextRenderer.RenderElement(element)).Append(' ');
        }

        private static string CollapseWhitespace(string value)
        {
            var builder = new StringBuilder(value.Length);
            var pendingSpace = false;
            foreach (var character in value)
            {
                if (char.IsWhiteSpace(character))
                {
                    pendingSpace = builder.Length > 0;
                    continue;
                }

                if (pendingSpace)
                {
                    builder.Append(' ');
                    pendingSpace = false;
                }

                builder.Append(character);
            }

            return builder.ToString().Trim();
        }
    }
}
