import { useState, useCallback, useMemo } from 'react'
import { Tldraw, type TLComponents, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'
import { Rider } from './game/Rider'
import type { Vec2 } from './game/physics'
import './App.css'

// How far above the viewport center to drop the sled when "set start" is hit,
// so it has room to fall onto the track below.
const START_DROP_ABOVE_CENTER = 150

// Legend: what each draw color does, grouped by behavior. Swatch colors are
// approximate tldraw v5 palette values (light/dark theme aside) — they only
// need to read as "that color" next to its name. Source of truth for the
// mapping itself is COLOR_TO_KIND in game/geometry.ts; keep these in sync.
const LEGEND: { label: string; desc: string; swatches: string[] }[] = [
	{ label: 'Solid', desc: 'Basic track', swatches: ['#1d1d1d', '#9fa8b2'] },
	{ label: 'Accelerate', desc: 'Speeds you up', swatches: ['#e03131', '#ff8787'] },
	{ label: 'Brake', desc: 'Slows you down', swatches: ['#f76707'] },
	{ label: 'Bounce', desc: 'Springy', swatches: ['#ffc034'] },
	{ label: 'Sticky', desc: 'High grip', swatches: ['#ae3ec9', '#e599f7'] },
	{ label: 'Ice', desc: 'Frictionless', swatches: ['#e8eef2'] },
	{ label: 'One-way', desc: 'Front side only', swatches: ['#4263eb', '#74c0fc'] },
	{ label: 'Scenery', desc: 'Non-collidable', swatches: ['#2f9e44', '#8ce99a'] },
]

function App() {
	const [editor, setEditor] = useState<Editor | null>(null)
	const [playing, setPlaying] = useState(false)
	const [follow, setFollow] = useState(true)
	const [showLegend, setShowLegend] = useState(false)
	const [startPoint, setStartPoint] = useState<Vec2>({ x: 200, y: 100 })
	const [stats, setStats] = useState({ distance: 0, speed: 0 })

	const handleMount = useCallback((ed: Editor) => {
		setEditor(ed)
		ed.user.updateUserPreferences({ colorScheme: 'light' })
	}, [])

	const onStats = useCallback((distance: number, speed: number) => {
		setStats({ distance, speed })
	}, [])

	// Toggle play. While playing we lock editing (read-only) and clear selection
	// so the user can't mutate the track mid-ride; restore on stop. All native.
	const togglePlay = useCallback(() => {
		const next = !playing
		if (editor) {
			editor.run(
				() => {
					editor.selectNone()
					editor.updateInstanceState({ isReadonly: next })
				},
				{ history: 'ignore' }
			)
		}
		setPlaying(next)
	}, [editor, playing])

	// The rider overlay renders on top of the canvas.
	const components: TLComponents = useMemo(
		() => ({
			InFrontOfTheCanvas: () => (
				<Rider playing={playing} follow={follow} startPoint={startPoint} onStats={onStats} />
			),
		}),
		[playing, follow, startPoint, onStats]
	)

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
					disabled={playing}
					title="Set start here"
					onClick={() => {
						if (!editor) return
						const c = editor.getViewportPageBounds().center
						setStartPoint({ x: c.x, y: c.y - START_DROP_ABOVE_CENTER })
					}}
				>
					⌖
				</button>
				<button
					className={follow ? 'lr-btn lr-icon lr-active' : 'lr-btn lr-icon'}
					title={follow ? 'Camera follow: on' : 'Camera follow: off'}
					aria-pressed={follow}
					onClick={() => setFollow((f) => !f)}
				>
					🎥
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
				</div>
			)}
		</div>
	)
}

export default App
