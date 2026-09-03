/**
 * Invariants for saved layouts and the panel model.
 *
 * The migration rules matter more than they look: an earlier release shipped a
 * migration that rewrote a user-entered value on load and silently destroyed a
 * working configuration. Everything below asserts that layout migration only
 * ever ADDS, and that the built-in layout is never modified.
 */
import {
  activeLayout,
  DEFAULT_LAYOUT_ID,
  DEFAULT_PANELS,
  DEFAULT_SETTINGS,
  ensureLayouts,
  isLayoutDirty,
  layoutLabel,
  layoutValuesOf,
  movePanel,
  placePanel,
  panelsIn,
  switchRegion,
  uniqueLayoutName,
  withPanel
} from '../src/shared/types'
import type { AppSettings, LayoutPreset, LayoutValues } from '../src/shared/types'

let failures = 0
const check = (label: string, pass: boolean, extra = '') => {
  if (!pass) failures++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? '   (' + extra + ')' : ''}`)
}

const builtIn = DEFAULT_SETTINGS.layouts[0]
const base = (): LayoutValues => layoutValuesOf(builtIn)

const mine: LayoutPreset = {
  id: 'layout-mine',
  name: 'Chat only',
  chatFontSize: 20,
  chatWidth: 700,
  panels: DEFAULT_PANELS.map((p) => ({ ...p, visible: p.id === 'chat' }))
}

// ---- unique names ----------------------------------------------------------
const layouts: LayoutPreset[] = [
  { ...builtIn },
  mine,
  { ...mine, id: 'layout-2', name: 'Chat only 2' }
]

check('a free name is kept as typed', uniqueLayoutName('Streaming', layouts) === 'Streaming')
check('a clash is suffixed, not rejected', uniqueLayoutName('Chat only', layouts) === 'Chat only 3')
check('clash check is case-insensitive', uniqueLayoutName('chat ONLY', layouts) === 'chat ONLY 3')
check(
  'renaming a layout to its own name is not a clash',
  uniqueLayoutName('Chat only', layouts, 'layout-mine') === 'Chat only'
)
check('a blank name still yields something usable', uniqueLayoutName('   ', layouts) === 'Layout')

// ---- panel moves -----------------------------------------------------------
const moved = movePanel(base(), 'destinations', -1)
check(
  'moving a panel up reorders its region',
  panelsIn(moved, 'left').map((p) => p.id).join(',') === 'destinations,preview',
  panelsIn(moved, 'left').map((p) => p.id).join(',')
)
check(
  'moving up at the top is a no-op',
  panelsIn(movePanel(base(), 'preview', -1), 'left').map((p) => p.id).join(',') ===
    'preview,destinations'
)
check(
  'moving down at the bottom is a no-op',
  panelsIn(movePanel(base(), 'destinations', 1), 'left').map((p) => p.id).join(',') ===
    'preview,destinations'
)
check(
  'orders stay contiguous after a move',
  panelsIn(moved, 'left').every((p, i) => p.order === i)
)

const switched = switchRegion(base(), 'chat')
check('switching region moves the panel across', panelsIn(switched, 'left').some((p) => p.id === 'chat'))
check('the panel lands last in its new region', panelsIn(switched, 'left').at(-1)?.id === 'chat')
check(
  'the vacated region renumbers from zero',
  panelsIn(switched, 'right').every((p, i) => p.order === i)
)

const hidden = withPanel(base(), 'preview', { visible: false })
check('a hidden panel drops out of its region', !panelsIn(hidden, 'left').some((p) => p.id === 'preview'))
check('hiding does not delete the panel', hidden.panels.some((p) => p.id === 'preview'))
check('editing returns a copy, not the original', hidden.panels !== base().panels)

// ---- drag and drop placement ----------------------------------------------
const dropped = placePanel(base(), 'chat', 'left', 0)
check(
  'a panel dropped at index 0 lands first in the target region',
  panelsIn(dropped, 'left').map((p) => p.id).join(',') === 'chat,preview,destinations',
  panelsIn(dropped, 'left').map((p) => p.id).join(',')
)
check('it leaves its old region', !panelsIn(dropped, 'right').some((p) => p.id === 'chat'))
check('the old region renumbers from zero', panelsIn(dropped, 'right').every((p, i) => p.order === i))

const middle = placePanel(base(), 'chat', 'left', 1)
check(
  'dropping between two panels inserts there',
  panelsIn(middle, 'left').map((p) => p.id).join(',') === 'preview,chat,destinations',
  panelsIn(middle, 'left').map((p) => p.id).join(',')
)

const past = placePanel(base(), 'chat', 'left', 99)
check(
  'an index past the end appends',
  panelsIn(past, 'left').at(-1)?.id === 'chat',
  panelsIn(past, 'left').map((p) => p.id).join(',')
)

const within = placePanel(base(), 'destinations', 'left', 0)
check(
  'reordering within a region works without a region change',
  panelsIn(within, 'left').map((p) => p.id).join(',') === 'destinations,preview'
)

// A hidden panel must keep its place rather than being shuffled by a drop it
// took no part in.
const withHidden = withPanel(base(), 'preview', { visible: false })
const overHidden = placePanel(withHidden, 'chat', 'left', 0)
check(
  'a hidden panel is not displaced by a drop',
  overHidden.panels.find((p) => p.id === 'preview')?.visible === false
)
check(
  'the drop still lands where the indicator pointed',
  panelsIn(overHidden, 'left').map((p) => p.id).join(',') === 'chat,destinations',
  panelsIn(overHidden, 'left').map((p) => p.id).join(',')
)

check(
  'dropping an unknown panel is a no-op',
  placePanel(base(), 'nope' as never, 'left', 0) === base() ||
    JSON.stringify(placePanel(base(), 'nope' as never, 'left', 0).panels) ===
      JSON.stringify(base().panels)
)

// ---- draft and dirty state -------------------------------------------------
const clean: AppSettings = { ...DEFAULT_SETTINGS, draftLayout: null }
check('a fresh config is clean', !isLayoutDirty(clean))
check('a clean label carries no marker', layoutLabel(clean) === 'Default', layoutLabel(clean))
check('a clean config shows the saved layout', activeLayout(clean).chatWidth === builtIn.chatWidth)

const dirty: AppSettings = { ...clean, draftLayout: { ...base(), chatWidth: 640 } }
check('a draft marks the config dirty', isLayoutDirty(dirty))
check('a dirty label is marked with (*)', layoutLabel(dirty) === 'Default (*)', layoutLabel(dirty))
check('a draft is what gets rendered', activeLayout(dirty).chatWidth === 640)
check(
  'the saved built-in is untouched by the draft',
  dirty.layouts[0].chatWidth === builtIn.chatWidth,
  String(dirty.layouts[0].chatWidth)
)

// ---- migration is additive -------------------------------------------------
const withoutBuiltIn = ensureLayouts({
  ...DEFAULT_SETTINGS,
  layouts: [mine],
  activeLayoutId: 'layout-mine'
} as AppSettings)

check('the built-in is restored when missing', withoutBuiltIn.layouts.some((l) => l.id === DEFAULT_LAYOUT_ID))
check(
  'the built-in is restored to its shipped values',
  JSON.stringify(withoutBuiltIn.layouts.find((l) => l.id === DEFAULT_LAYOUT_ID)) ===
    JSON.stringify(builtIn)
)
check('a user layout survives migration', withoutBuiltIn.layouts.some((l) => l.id === 'layout-mine'))
check(
  'a user layout keeps its own values',
  withoutBuiltIn.layouts.find((l) => l.id === 'layout-mine')?.chatWidth === 700
)
check(
  'a user layout keeps its hidden panels hidden',
  withoutBuiltIn.layouts
    .find((l) => l.id === 'layout-mine')!
    .panels.filter((p) => p.visible)
    .map((p) => p.id)
    .join(',') === 'chat'
)
check('a valid active id is preserved', withoutBuiltIn.activeLayoutId === 'layout-mine')

const partial = ensureLayouts({
  ...DEFAULT_SETTINGS,
  layouts: [
    { ...builtIn },
    // A layout saved before the activity panel existed.
    { id: 'old', name: 'Old', chatFontSize: 14, chatWidth: 400, panels: [DEFAULT_PANELS[0]] }
  ]
} as AppSettings)
const old = partial.layouts.find((l) => l.id === 'old')!
check('a layout missing panels is filled from the defaults', old.panels.length === DEFAULT_PANELS.length)
check('the panel it did have is preserved', old.panels.some((p) => p.id === 'preview'))

const dangling = ensureLayouts({
  ...DEFAULT_SETTINGS,
  activeLayoutId: 'deleted-long-ago'
} as AppSettings)
check('a dangling active id falls back to the built-in', dangling.activeLayoutId === DEFAULT_LAYOUT_ID)

const empty = ensureLayouts({ ...DEFAULT_SETTINGS, layouts: [] } as AppSettings)
check('an empty list is repopulated', empty.layouts.length === 1)

const missing = ensureLayouts({
  ...DEFAULT_SETTINGS,
  layouts: undefined as unknown as LayoutPreset[]
} as AppSettings)
check('a config predating layouts is handled', missing.layouts.length === 1)

const twice = ensureLayouts(ensureLayouts(withoutBuiltIn))
check(
  'migration is idempotent',
  twice.layouts.filter((l) => l.id === DEFAULT_LAYOUT_ID).length === 1 &&
    twice.layouts.length === withoutBuiltIn.layouts.length
)

// ---- the built-in is protected --------------------------------------------
check('the built-in layout is named Default', builtIn.name === 'Default')
check('the built-in layout is flagged so the UI can protect it', builtIn.builtIn === true)
check('every default panel starts visible', DEFAULT_PANELS.every((p) => p.visible))
check('the activity panel exists by default', DEFAULT_PANELS.some((p) => p.id === 'activity'))

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
