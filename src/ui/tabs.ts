/**
 * SpaceGen Racing — a tab strip.
 * ---------------------------------------------------------------------------
 * Built as its own module, and general, because the brief was explicit that
 * more pages will be added later. The whole of adding one is appending an entry
 * to the array passed in here and filling the element handed back:
 *
 *     const tabs = createTabs(host, [
 *       { id: 'results', label: 'Results' },
 *       { id: 'records', label: 'Records' },
 *       { id: 'stats',   label: 'Stats'   },   // <- the future one
 *     ])
 *     buildStatsInto(tabs.panel('stats'))
 *
 * Nothing about the count is hard-coded: the strip lays out with flex and wrap,
 * the keyboard walks whatever exists, and the panels are created from the specs.
 *
 * IT IS A REAL TABLIST, NOT BUTTONS THAT HIDE THINGS.
 *
 * role=tablist / role=tab / role=tabpanel, `aria-selected`, `aria-controls` and
 * `aria-labelledby` wired up, arrow keys and Home/End moving between tabs, and
 * only the selected tab in the focus order -- which is the actual ARIA pattern
 * and the reason a screen reader announces "Records, tab, 2 of 2" rather than
 * reading two unlabelled buttons. It costs about fifteen lines over a pair of
 * divs and it is the difference between a control and a shape.
 *
 * HIDING IS `hidden`, NOT display:none in a stylesheet, so a panel that is off
 * is out of the accessibility tree and its inputs are out of the tab order --
 * a name field on a hidden panel that can still be focused is a real trap.
 */

export interface TabSpec {
  id: string
  label: string
}

export interface TabStrip {
  /** The tablist element. Insert it wherever the tabs should appear. */
  readonly root: HTMLElement
  /** The container holding every panel. */
  readonly panels: HTMLElement
  /** The panel element for a tab, to build content into. */
  panel(id: string): HTMLElement
  select(id: string): void
  readonly selected: string
  /**
   * Put a marker on a tab -- something new is in there.
   *
   * The records tab is the reason this exists: a player who never clicks it
   * never learns they took a record, and a tab that has never been opened is
   * the easiest thing in a UI to not notice.
   */
  setMarked(id: string, marked: boolean): void
  onSelect: (id: string) => void
  dispose(): void
}

let seq = 0

export function createTabs(host: HTMLElement, specs: readonly TabSpec[]): TabStrip {
  const uid = `sgt${++seq}`
  const root = document.createElement('div')
  root.className = 'sg-tabs'
  root.setAttribute('role', 'tablist')

  const panels = document.createElement('div')
  panels.className = 'sg-tabpanels'

  const buttons = new Map<string, HTMLButtonElement>()
  const bodies = new Map<string, HTMLElement>()
  let selected = specs.length > 0 ? specs[0].id : ''

  const strip: TabStrip = {
    root,
    panels,
    panel(id) {
      const p = bodies.get(id)
      if (!p) throw new Error(`no tab panel "${id}"`)
      return p
    },
    get selected() { return selected },
    select(id) {
      if (!buttons.has(id)) return
      selected = id
      for (const [key, btn] of buttons) {
        const on = key === id
        btn.setAttribute('aria-selected', on ? 'true' : 'false')
        // Only the selected tab is tabbable; the arrows move between them.
        btn.tabIndex = on ? 0 : -1
        btn.classList.toggle('is-on', on)
        const body = bodies.get(key)
        if (body) body.hidden = !on
      }
      // Opening a tab is the acknowledgement -- the marker has done its job.
      strip.setMarked(id, false)
      strip.onSelect(id)
    },
    setMarked(id, marked) {
      const btn = buttons.get(id)
      if (!btn) return
      if (marked) btn.dataset.mark = '1'
      else delete btn.dataset.mark
    },
    onSelect: () => {},
    dispose() {
      root.remove()
      panels.remove()
    },
  }

  const move = (from: string, delta: number): void => {
    const ids = specs.map((s) => s.id)
    const i = ids.indexOf(from)
    if (i < 0) return
    const next = ids[(i + delta + ids.length) % ids.length]
    strip.select(next)
    buttons.get(next)?.focus()
  }

  for (const spec of specs) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'sg-tab'
    btn.id = `${uid}-tab-${spec.id}`
    btn.setAttribute('role', 'tab')
    btn.setAttribute('aria-controls', `${uid}-panel-${spec.id}`)
    btn.textContent = spec.label
    btn.addEventListener('click', () => strip.select(spec.id))
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(spec.id, 1) }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(spec.id, -1) }
      else if (e.key === 'Home') { e.preventDefault(); strip.select(specs[0].id); buttons.get(specs[0].id)?.focus() }
      else if (e.key === 'End') {
        e.preventDefault()
        const last = specs[specs.length - 1].id
        strip.select(last); buttons.get(last)?.focus()
      } else return
      // The results screen binds arrows and Enter to its own buttons; without
      // this, walking the tabs also drives whatever that navigation does.
      e.stopPropagation()
    })
    root.appendChild(btn)
    buttons.set(spec.id, btn)

    const body = document.createElement('div')
    body.className = 'sg-tabpanel'
    body.id = `${uid}-panel-${spec.id}`
    body.setAttribute('role', 'tabpanel')
    body.setAttribute('aria-labelledby', btn.id)
    body.hidden = true
    panels.appendChild(body)
    bodies.set(spec.id, body)
  }

  host.appendChild(root)
  host.appendChild(panels)
  if (selected) strip.select(selected)
  return strip
}
