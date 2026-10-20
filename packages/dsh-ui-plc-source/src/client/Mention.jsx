/**
 * Inline chip for a cited block in a sent message.
 *
 * The transcript's user-text evaluator asks each registered rule for the next
 * match; this rule claims `@'NAME'` before the file grammar can, which is what
 * keeps a mention from rendering as a broken file chip (a path the viewer would
 * fail to open). The chip is deliberately not interactive: the block already has
 * a row in the tab, and a second navigation path would need its own failure UI.
 *
 * @module dsh-ui-plc-source/Mention
 */

/**
 * @param props - the resolved node (`data.name`) and the original spelling.
 * @returns a non-interactive chip carrying the object name.
 */
export function BlockMention({ node, raw }) {
  const name = typeof node?.data?.name === 'string' && node.data.name.length > 0 ? node.data.name : raw
  return (
    <span className="plps-mention" title={raw}>
      {name}
    </span>
  )
}
