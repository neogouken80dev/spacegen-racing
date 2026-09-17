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
 *
 * ---------------------------------------------------------------------------
 * A PAGE CAN ALSO NOT EXIST RIGHT NOW. See setPresent().
 *
 * Circuit Mode needs a Circuit standings page that must be completely absent
 * in single-race mode -- absent, not present-and-empty, because an empty page
 * is a promise the screen cannot keep. The naive version is to hide the button
 * with `hidden` and leave it in the specs, which produces a tablist that
 * announces "3 of 4" with three tabs in it and whose arrow keys stop on a tab
 * nobody can see. So absence is a first-class state here: the button leaves the
 * DOM entirely, the panel is hidden, and the keyboard walk and Home/End only
 * ever consider the tabs that are actually there.
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
  /**
   * Add or remove a page at runtime, keeping its position in the strip.
   *
   * An absent tab's button is detached from the tablist, so a screen reader
   * counts and announces only what is there, and its panel is hidden, so
   * nothing inside it is focusable. If the absent tab was the selected one,
   * the first present tab is selected instead -- there is no valid state in
   * which nothing is selected.
   *
   * Every page starts present; a caller that never touches this gets exactly
   * the behaviour it had before this existed.
   */
  setPresent(id: string, present: boolean): void
  /** Whether a page currently exists. */
  isPresent(id: string): boolean
  onSelect: (id: string) => void
  /**
   * Fired ONLY when a human moved the selection -- a click, or an arrow /
   * Home / End keypress. A programmatic select() does not fire it.
   *
   * The results screen needs the distinction to keep its auto-switch honest: a
   * player who has chosen a page must not have it changed under them a moment
   * later, and "did the player choose this" cannot be answered by onSelect,
   * which fires for both.
   */
  onUserSelect: (id: string) => void
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
  const present = new Set<string>(specs.map((s) => s.id))
  let selected = specs.length > 0 ? specs[0].id : ''

  /** The ids that exist right now, in strip order. */
  const live = (): string[] => specs.map((s) => s.id).filter((id) => present.has(id))

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
      if (!buttons.has(id) || !present.has(id)) return
      selected = id
      for (const [key, btn] of buttons) {
        const on = key === id
        btn.setAttribute('aria-selected', on ? 'true' : 'false')
        // Only the selected tab is tabbable; the arrows move between them.
        btn.tabIndex = on ? 0 : -1
        btn.classList.toggle('is-on', on)
        const body = bodies.get(key)
        // An absent page stays hidden whatever the selection is doing.
        if (body) body.hidden = !on || !present.has(key)
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
    isPresent(id) { return present.has(id) },
    setPresent(id, on) {
      const btn = buttons.get(id)
      const body = bodies.get(id)
      if (!btn || !body) return
      if (present.has(id) === on) return
      if (on) {
        present.add(id)
        // Back into its ORIGINAL place in the strip, not onto the end: the
        // pages have a reading order and a tab that moves when it reappears
        // is a tab the player has to find again.
        const ids = specs.map((s) => s.id)
        const after = ids.slice(ids.indexOf(id) + 1).find((k) => present.has(k))
        const ref = after ? buttons.get(after) ?? null : null
        root.insertBefore(btn, ref)
      } else {
        present.delete(id)
        btn.remove()
        body.hidden = true
        delete btn.dataset.mark
      }
      // Never leave nothing selected, and never leave an absent page selected.
      if (!present.has(selected)) {
        const first = live()[0]
        if (first) strip.select(first)
      } else {
        // Re-run the attribute sweep so the reinstated panel picks up its
        // hidden state from the current selection rather than from before.
        strip.select(selected)
      }
    },
    onSelect: () => {},
    onUserSelect: () => {},
    dispose() {
      root.remove()
      panels.remove()
    },
  }

  /** A selection the player made. Fires both callbacks; select() fires one. */
  const userSelect = (id: string): void => {
    if (!present.has(id)) return
    strip.select(id)
    strip.onUserSelect(id)
  }

  const move = (from: string, delta: number): void => {
    const ids = live()
    const i = ids.indexOf(from)
    if (i < 0 || ids.length === 0) return
    const next = ids[(i + delta + ids.length) % ids.length]
    userSelect(next)
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
    btn.addEventListener('click', () => userSelect(spec.id))
    btn.addEventListener('keydown', (e) => {
      // Home and End walk what EXISTS, so they cannot land on an absent page.
      const ids = live()
      if (ids.length === 0) return
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(spec.id, 1) }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(spec.id, -1) }
      else if (e.key === 'Home') { e.preventDefault(); userSelect(ids[0]); buttons.get(ids[0])?.focus() }
      else if (e.key === 'End') {
        e.preventDefault()
        const last = ids[ids.length - 1]
        userSelect(last); buttons.get(last)?.focus()
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
