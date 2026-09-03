/**
 * Invariants for saved layouts.
 *
 * The migration rules here matter more than they look: a previous release
 * shipped a migration that rewrote a user-entered value on load and silently
 * destroyed a working configuration. Everything below asserts that layout
 * migration only ever ADDS.
 */
import {
  DEFAULT_LAYOUT_ID,
  DEFAULT_SETTINGS,
  ensureLayouts,
  layoutValuesOf,
  uniqueLayoutName
} from '../src/shared/types'
import type { AppSettings, LayoutPreset } from '../src/shared/types'

let failures = 0
const check = (label: string, pass: boolean, extra = '') => {
  if (!pass) failures++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? '   (' + extra + ')' : ''}`)
}

const mine: LayoutPreset = {
  id: 'layout-mine',
  name: 'Chat only',
  chatFontSize: 20,
  chatWidth: 700,
  showPreview: false
}

// ---- unique names ----------------------------------------------------------
const layouts: LayoutPreset[] = [
  { ...DEFAULT_SETTINGS.layouts[0] },
  mine,
  { ...mine, id: 'layout-2', name: 'Chat only 2' }
]

check('a free name is kept as typed', uniqueLayoutName('Streaming', layouts) === 'Streaming')
check(
  'a clash is suffixed rather than rejected',
  uniqueLayoutName('Chat only', layouts) === 'Chat only 3',
  uniqueLayoutName('Chat only', layouts)
)
check(
  'clash check is case-insensitive',
  uniqueLayoutName('chat ONLY', layouts) === 'chat ONLY 3',
  uniqueLayoutName('chat ONLY', layouts)
)
check(
  'renaming a layout to its own name is not a clash',
  uniqueLayoutName('Chat only', layouts, 'layout-mine') === 'Chat only'
)
check('a blank name still yields something usable', uniqueLayoutName('   ', layouts) === 'Layout')

// ---- migration is additive -------------------------------------------------
const withoutBuiltIn = { ...DEFAULT_SETTINGS, layouts: [mine], activeLayoutId: 'layout-mine' }
const fixed = ensureLayouts(withoutBuiltIn as AppSettings)

check('the built-in layout is restored when missing', fixed.layouts.some((l) => l.id === DEFAULT_LAYOUT_ID))
check('the built-in is marked as such', !!fixed.layouts.find((l) => l.id === DEFAULT_LAYOUT_ID)?.builtIn)
check('a user layout survives migration', fixed.layouts.some((l) => l.id === 'layout-mine'))
check(
  'a user layout is not modified by migration',
  JSON.stringify(fixed.layouts.find((l) => l.id === 'layout-mine')) === JSON.stringify(mine)
)
check('a valid active id is preserved', fixed.activeLayoutId === 'layout-mine')

const dangling = ensureLayouts({
  ...DEFAULT_SETTINGS,
  layouts: [{ ...DEFAULT_SETTINGS.layouts[0] }, mine],
  activeLayoutId: 'deleted-long-ago'
} as AppSettings)
check('a dangling active id falls back to the built-in', dangling.activeLayoutId === DEFAULT_LAYOUT_ID)
check('the fallback does not drop layouts', dangling.layouts.length === 2)

const empty = ensureLayouts({ ...DEFAULT_SETTINGS, layouts: [] } as AppSettings)
check('an empty list is repopulated', empty.layouts.length === 1)

const missing = ensureLayouts({
  ...DEFAULT_SETTINGS,
  layouts: undefined as unknown as LayoutPreset[]
} as AppSettings)
check('a config predating layouts is handled', missing.layouts.length === 1)

// Running twice must not accumulate duplicates.
const twice = ensureLayouts(ensureLayouts(withoutBuiltIn as AppSettings))
check(
  'migration is idempotent',
  twice.layouts.filter((l) => l.id === DEFAULT_LAYOUT_ID).length === 1,
  `${twice.layouts.length} layouts`
)

// ---- value copying ---------------------------------------------------------
const picked = layoutValuesOf(mine)
check(
  'layoutValuesOf takes only the layout-owned fields',
  JSON.stringify(Object.keys(picked).sort()) ===
    JSON.stringify(['chatFontSize', 'chatWidth', 'showPreview'])
)
check(
  'layoutValuesOf reads settings as readily as a preset',
  layoutValuesOf(DEFAULT_SETTINGS).chatWidth === DEFAULT_SETTINGS.chatWidth
)

// ---- the built-in is protected --------------------------------------------
const builtIn = DEFAULT_SETTINGS.layouts.find((l) => l.id === DEFAULT_LAYOUT_ID)!
check('the built-in layout is named Default', builtIn.name === 'Default')
check('the built-in layout is flagged, so the UI can withhold delete', builtIn.builtIn === true)

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
