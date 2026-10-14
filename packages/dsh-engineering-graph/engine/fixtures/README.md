# Engine fixtures

Seven **trimmed real TIA Portal V17 exports**, used by `--self-test` and by the
parser tests. They are committed on purpose: plugin family 3 is defined as pure
text parsing, so it must be developable and testable **offline**, with no TIA
Portal installation and no Windows dependency (see `docs/roadmap.md` §4, the
"离线可 CI" acceptance criterion, and `docs/decisions.md` D15).

| File | Simatic ML root | What it covers |
|---|---|---|
| `Main [OB1].xml` | `SW.Blocks.OB` | organisation block, multiple networks |
| `FC_LAD_SimulateCylinder_Call [FC1].xml` | `SW.Blocks.FC` | LAD (FlgNet) with a block call, symbol reads/writes |
| `SclAssign [FC10].xml` | `SW.Blocks.FC` | SCL (`<StructuredText>`) statement path |
| `GlobalData [DB1].xml` | `SW.Blocks.GlobalDB` | global data block member tree |
| `MotorFbInstance [DB2].xml` | `SW.Blocks.InstanceDB` | instance DB -> `INSTANCE_OF` edge |
| `IO_CC_Cav_A.xml` | `SW.Tags.PlcTagTable` | tag table, tag -> I/O address links |
| `CAB.xml` | `SW.Types.PlcStruct` | UDT, first-level members only |

Current self-test result over this directory (crawl mode, no `metadata.json`):

```
filesFound=7 filesImported=7 nodes=72 edges=153
by kind: DB Member=7, Data Type=5, FB=1, FC=2, Global DB=1, IO Address=10,
         Instance DB=1, Instruction=1, Network=11, OB=1, PLC Tag=10,
         Project=1, UDT=1, UDT Member=1, Variable=19
```

## Origin

Copied verbatim on 2026-10-15 from
`C:\Users\Ansel\orca\projects\AgentAssistPlcDev\tests\Mcp.Knowledge.Tests\Fixtures\`
(another repository of the same author). They were already trimmed there; nothing
was re-trimmed or edited here. Byte sizes are unchanged.

Note the filenames contain spaces and square brackets (`Main [OB1].xml`). In
PowerShell that matters: `Test-Path`, `Get-Content` and `Get-Item` treat `[...]`
as a wildcard character class, so use `-LiteralPath`. This is a recorded pitfall
in the sibling plugin as well
(`packages/dsh-tia-openness-v17-min/docs/EXPORT-COMPARISON.md` §6).
