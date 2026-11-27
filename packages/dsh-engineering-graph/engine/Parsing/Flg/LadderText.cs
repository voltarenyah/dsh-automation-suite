// Renders a network's rungs as text a reader (human or model) can follow.
//
// WHY TEXT AND NOT A PICTURE
// --------------------------
// A model reads text far more reliably than ASCII art, and an ASCII ladder drawing falls apart on
// networks with 34 contacts in series (a real shape in this project). The layout below keeps the
// two facts that make LAD readable — which coil is written, and which combination of conditions
// reaches it — and states them once per path, so nothing depends on column alignment:
//
//   NW 4  "Step 11 : Open VOC Door"
//     (S) G.%X2   <-  Disable_VocDoorFunction
//     (S) G.%X2   <-  Mvt_VocDoor_DN.FullOpen AND NOT Manu_Loading
//     (R) G.%X11  <-  Mvt_VocDoor_DN.FullOpen
//
// Several lines for one coil mean the conditions are alternatives (OR), which is exactly how a
// parallel branch behaves and how the resolver in SeriesParallelReducer discovered them.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Xml.Linq;

namespace EngineeringGraph.Engine;

internal static class LadderText
{
    /// <summary>Rung text for every network of a block, keyed by CompileUnit id.</summary>
    internal static IReadOnlyDictionary<string, string> GetByCompileUnitId(string xml)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrWhiteSpace(xml))
        {
            return result;
        }

        XDocument document;
        try
        {
            document = XDocument.Parse(xml);
        }
        catch
        {
            return result;
        }

        foreach (XElement unit in document.Descendants().Where(element => element.Name.LocalName == "SW.Blocks.CompileUnit"))
        {
            XElement? flgNet = unit.Descendants().FirstOrDefault(element => element.Name.LocalName == "FlgNet");
            if (flgNet == null)
            {
                continue;
            }

            string compileUnitId = unit.Attribute("ID")?.Value?.Trim() ?? string.Empty;
            if (compileUnitId.Length == 0)
            {
                continue;
            }

            FlgNetworkGraph graph = FlgNetworkGraph.Build(flgNet);
            string text = Render(graph, SeriesParallelReducer.Reduce(graph));
            if (text.Length > 0)
            {
                result[compileUnitId] = text;
            }
        }

        return result;
    }

    /// <summary>Renders one network. Empty when the network has neither a coil nor a path.</summary>
    internal static string Render(FlgNetworkGraph graph, RungModel rung)
    {
        if (!rung.IsStructured)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();

        foreach (RungCoil coil in rung.Coils)
        {
            string target = coil.Operand ?? coil.ElementId;
            string marker = Marker(coil.Kind, coil.Negated);
            foreach (RungPath path in coil.Paths)
            {
                builder.Append("  ").Append(marker).Append(' ').Append(target)
                    .Append("   <-  ").Append(RungModel.ConditionOf(path))
                    .Append('\n');
            }
        }

        // Paths that end without a coil: EN chains, alarm wiring, empty branches. They are part of
        // the network's meaning, so they are listed rather than dropped.
        foreach (RungPath path in rung.OpenEnds)
        {
            builder.Append("  --").Append(" (no coil)   <-  ").Append(RungModel.ConditionOf(path)).Append('\n');
        }

        return builder.ToString().TrimEnd('\n');
    }

    private static string Marker(FlgElementKind kind, bool negated)
    {
        string marker = kind switch
        {
            FlgElementKind.SetCoil => "(S)",
            FlgElementKind.ResetCoil => "(R)",
            _ => "(=)"
        };

        return negated ? "(/)" + marker : marker;
    }
}
