import { useState, useCallback } from 'react'
import { Tldraw, type TLComponents, type Editor, useValue, createShapeId, type IndexKey } from 'tldraw'
import 'tldraw/tldraw.css'
import { Rider } from './game/Rider'
import { LEGEND } from './game/geometry'
import { playingAtom, followAtom, startPointAtom, statsAtom, scoreAtom, resetNonceAtom, mutedAtom, showCollisionsAtom, modeAtom } from './game/state'
import './App.css'

// How far above the viewport center to drop the sled when "set start" is hit,
// so it has room to fall onto the track below.
const START_DROP_ABOVE_CENTER = 150

// A default test ramp for side mode: a gentle up-ramp the character can launch
// off. Placed relative to the start point — it begins ON the ground (start.y) a
// bit AHEAD of the spawn so the auto-running snail meets it, and rises over a
// shallow run (~22°) for a satisfying hop rather than a wipeout. A native `line`
// shape (native-first contract), black = solid track.
const RAMP_AHEAD = 220 // px ahead of the start where the ramp begins
const RAMP_RUN = 320 // horizontal length of the ramp
const RAMP_RISE = 130 // how far it climbs (up = -y)

// The rider overlay renders on top of the canvas. Defined once at module scope
// (and reading its gameplay state from atoms) so its identity never changes —
// see the comment on the atoms above.
const components: TLComponents = {
	InFrontOfTheCanvas: () => <Rider />,
}

// A panel button that reflects an on/off state: gets the `lr-active` class and
// `aria-pressed` when `active`, with the title swapping to match. Collapses the
// handful of near-identical toggle buttons (follow / mute / collisions / legend)
// in the panel into one place.
function ToggleButton({
	active,
	onClick,
	title,
	children,
}: {
	active: boolean
	onClick: () => void
	title: string
	children: React.ReactNode
}) {
	return (
		<button
			className={active ? 'lr-btn lr-icon lr-active' : 'lr-btn lr-icon'}
			title={title}
			aria-pressed={active}
			onClick={onClick}
		>
			{children}
		</button>
	)
}

function App() {
	const [editor, setEditor] = useState<Editor | null>(null)
	const [showLegend, setShowLegend] = useState(false)

	// Mirror the atoms into React for the panel. useValue subscribes reactively
	// without making `components` depend on any of these.
	const playing = useValue('playing', () => playingAtom.get(), [])
	const mode = useValue('mode', () => modeAtom.get(), [])
	const follow = useValue('follow', () => followAtom.get(), [])
	const muted = useValue('muted', () => mutedAtom.get(), [])
	const showCollisions = useValue('showCollisions', () => showCollisionsAtom.get(), [])
	const stats = useValue('stats', () => statsAtom.get(), [])
	const score = useValue('score', () => scoreAtom.get(), [])

	const handleMount = useCallback((ed: Editor) => {
		setEditor(ed)
		ed.user.updateUserPreferences({ colorScheme: 'light' })
	}, [])

	// Toggle play/pause. While playing we lock editing (read-only) and clear
	// selection so the user can't mutate the track mid-ride; restore on pause.
	// Pausing then playing resumes the run where it left off (only Reset starts
	// over) — see RunController.sync. All native.
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

	// Drop a gentle test ramp ahead of the start point, then select + frame it so
	// it's obvious where it landed. A native `line` shape (black = solid track), so
	// it reads/collides exactly like a hand-drawn ramp — nothing custom. Handy for
	// trying side mode without drawing one by hand. The createShape is a normal
	// (undoable) edit like any drawn shape; only the select/zoom is history:'ignore'
	// (a camera/selection change must not land on the undo stack).
	const handleAddRamp = useCallback(() => {
		if (!editor) return
		const start = startPointAtom.get()
		const baseX = start.x + RAMP_AHEAD
		const baseY = start.y // ramp foot sits on the ground plane
		const id = createShapeId()
		editor.createShape({
			id,
			type: 'line',
			x: baseX,
			y: baseY,
			props: {
				color: 'black',
				spline: 'line',
				points: {
					a1: { id: 'a1', index: 'a1' as IndexKey, x: 0, y: 0 },
					a2: { id: 'a2', index: 'a2' as IndexKey, x: RAMP_RUN, y: -RAMP_RISE },
				},
			},
		})
		editor.run(
			() => {
				editor.select(id)
				editor.zoomToSelection()
			},
			{ history: 'ignore' }
		)
	}, [editor])

	return (
		<div className="lr-root">
			<Tldraw persistenceKey="line-rider" components={components} onMount={handleMount} />

			<div className="lr-panel">
				<button
					className={playing ? 'lr-btn lr-stop' : 'lr-btn lr-play'}
					onClick={togglePlay}
					title={playing ? 'Pause' : 'Play'}
				>
					{playing ? '❚❚' : '▶'}
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
					className={mode === 'side' ? 'lr-btn lr-icon lr-active' : 'lr-btn lr-icon'}
					disabled={playing}
					aria-pressed={mode === 'side'}
					title={mode === 'side' ? 'Mode: Side-rider (draw ramps above the ground)' : 'Mode: Line Rider'}
					onClick={() => modeAtom.update((m) => (m === 'side' ? 'line' : 'side'))}
				>
					{mode === 'side' ? '🏃' : '🎿'}
				</button>
				{mode === 'side' && (
					<button
						className="lr-btn lr-icon"
						disabled={playing}
						title="Add a test ramp ahead of the start"
						onClick={handleAddRamp}
					>
						⛰
					</button>
				)}
				<ToggleButton
					active={follow}
					title={follow ? 'Camera follow: on' : 'Camera follow: off'}
					onClick={() => followAtom.update((f) => !f)}
				>
					🎥
				</ToggleButton>
				<ToggleButton
					active={!muted}
					title={muted ? 'Sound: off' : 'Sound: on'}
					onClick={() => mutedAtom.update((m) => !m)}
				>
					{muted ? '🔇' : '🔊'}
				</ToggleButton>
				<ToggleButton
					active={showCollisions}
					title={showCollisions ? 'Hide collision shapes' : 'Show collision shapes'}
					onClick={() => showCollisionsAtom.update((s) => !s)}
				>
					◎
				</ToggleButton>
				<ToggleButton
					active={showLegend}
					title="Color legend"
					onClick={() => setShowLegend((s) => !s)}
				>
					?
				</ToggleButton>
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
