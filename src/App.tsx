import { useState, useCallback } from 'react'
import { Tldraw, type TLComponents, type Editor, useValue } from 'tldraw'
import 'tldraw/tldraw.css'
import { Rider } from './game/Rider'
import { playingAtom, followAtom, startPointAtom, statsAtom, scoreAtom, resetNonceAtom, mutedAtom, showCollisionsAtom } from './game/state'
import './App.css'

// How far above the viewport center to drop the sled when "set start" is hit,
// so it has room to fall onto the track below.
const START_DROP_ABOVE_CENTER = 150

// Legend: what each draw color does, grouped by behavior. Swatch colors are
// approximate tldraw v5 palette values (light/dark theme aside) — they only
// need to read as "that color" next to its name. Source of truth for the
// mapping itself is COLOR_TO_KIND in game/geometry.ts; keep these in sync.
const LEGEND: { label: string; desc: string; swatches: string[] }[] = [
	{ label: 'Solid', desc: 'Basic track', swatches: ['#1d1d1d'] },
	{ label: 'Accelerate', desc: 'Speeds you up', swatches: ['#e03131', '#ff8787'] },
	{ label: 'Brake', desc: 'Slows you down', swatches: ['#f76707'] },
	{ label: 'Bounce', desc: 'Springy', swatches: ['#ffc034'] },
	{ label: 'Sticky', desc: 'High grip', swatches: ['#ae3ec9', '#e599f7'] },
	{ label: 'Ice', desc: 'Frictionless', swatches: ['#9fa8b2'] },
	{ label: 'One-way', desc: 'Blocks from above', swatches: ['#4263eb'] },
	{ label: 'One-way ↑', desc: 'Blocks from below', swatches: ['#74c0fc'] },
	{ label: 'Scenery', desc: 'Non-collidable', swatches: ['#2f9e44', '#8ce99a'] },
]

// The rider overlay renders on top of the canvas. Defined once at module scope
// (and reading its gameplay state from atoms) so its identity never changes —
// see the comment on the atoms above.
const components: TLComponents = {
	InFrontOfTheCanvas: () => <Rider />,
}

function App() {
	const [editor, setEditor] = useState<Editor | null>(null)
	const [showLegend, setShowLegend] = useState(false)

	// Mirror the atoms into React for the panel. useValue subscribes reactively
	// without making `components` depend on any of these.
	const playing = useValue('playing', () => playingAtom.get(), [])
	const follow = useValue('follow', () => followAtom.get(), [])
	const muted = useValue('muted', () => mutedAtom.get(), [])
	const showCollisions = useValue('showCollisions', () => showCollisionsAtom.get(), [])
	const stats = useValue('stats', () => statsAtom.get(), [])
	const score = useValue('score', () => scoreAtom.get(), [])

	const handleMount = useCallback((ed: Editor) => {
		setEditor(ed)
		ed.user.updateUserPreferences({ colorScheme: 'light' })
	}, [])

	// Toggle play. While playing we lock editing (read-only) and clear selection
	// so the user can't mutate the track mid-ride; restore on stop. All native.
	const togglePlay = useCallback(() => {
		if (!editor) return
		const next = !playingAtom.get()
		editor.run(
			() => {
				editor.selectNone()
				editor.updateInstanceState({ isReadonly: next })
			},
			{ history: 'ignore' }
		)
		playingAtom.set(next)
	}, [editor])

	// Reset: stop any in-progress run (restoring editing), re-seat the sled at the
	// start point, and recenter the camera there. Bumping the nonce makes the rider
	// rebuild its body even though the start point itself didn't move.
	const handleReset = useCallback(() => {
		if (editor) {
			editor.run(
				() => {
					if (playingAtom.get()) editor.updateInstanceState({ isReadonly: false })
					editor.centerOnPoint(startPointAtom.get())
				},
				{ history: 'ignore' }
			)
		}
		playingAtom.set(false)
		resetNonceAtom.update((n) => n + 1)
	}, [editor])

	return (
		<div className="lr-root">
			<Tldraw persistenceKey="line-rider" components={components} onMount={handleMount} />

			<div className="lr-panel">
				<button
					className={playing ? 'lr-btn lr-stop' : 'lr-btn lr-play'}
					onClick={togglePlay}
					title={playing ? 'Stop' : 'Play'}
				>
					{playing ? '■' : '▶'}
				</button>
				<button
					className="lr-btn lr-icon"
					title="Reset to start"
					onClick={handleReset}
				>
					↺
				</button>
				<button
					className="lr-btn lr-icon"
					disabled={playing}
					title="Set start here"
					onClick={() => {
						if (!editor) return
						const c = editor.getViewportPageBounds().center
						startPointAtom.set({ x: c.x, y: c.y - START_DROP_ABOVE_CENTER })
					}}
				>
					⌖
				</button>
				<button
					className={follow ? 'lr-btn lr-icon lr-active' : 'lr-btn lr-icon'}
					title={follow ? 'Camera follow: on' : 'Camera follow: off'}
					aria-pressed={follow}
					onClick={() => followAtom.update((f) => !f)}
				>
					🎥
				</button>
				<button
					className="lr-btn lr-icon"
					title={muted ? 'Sound: off' : 'Sound: on'}
					aria-pressed={!muted}
					onClick={() => mutedAtom.update((m) => !m)}
				>
					{muted ? '🔇' : '🔊'}
				</button>
				<button
					className={showCollisions ? 'lr-btn lr-icon lr-active' : 'lr-btn lr-icon'}
					title={showCollisions ? 'Hide collision shapes' : 'Show collision shapes'}
					aria-pressed={showCollisions}
					onClick={() => showCollisionsAtom.update((s) => !s)}
				>
					◎
				</button>
				<button
					className={showLegend ? 'lr-btn lr-icon lr-active' : 'lr-btn lr-icon'}
					title="Color legend"
					aria-pressed={showLegend}
					onClick={() => setShowLegend((s) => !s)}
				>
					?
				</button>
				<span className="lr-stat">
					<b>{Math.round(stats.distance)}</b>
					<small>dist</small>
				</span>
				<span className="lr-stat">
					<b>{Math.round(stats.speed)}</b>
					<small>speed</small>
				</span>
				{score.total > 0 && (
					<span className="lr-stat">
						<b>
							{score.collected}/{score.total}
						</b>
						<small>flags</small>
					</span>
				)}
			</div>

			{showLegend && (
				<div className="lr-legend">
					<div className="lr-legend-title">Draw with a color to set its behavior</div>
					{LEGEND.map((row) => (
						<div className="lr-legend-row" key={row.label}>
							<span className="lr-legend-swatches">
								{row.swatches.map((c) => (
									<span className="lr-legend-swatch" key={c} style={{ background: c }} />
								))}
							</span>
							<b>{row.label}</b>
							<small>{row.desc}</small>
						</div>
					))}
					<div className="lr-legend-note">
						Drop a sticky note as a flag — collect them all on your run.
					</div>
				</div>
			)}
		</div>
	)
}

export default App
