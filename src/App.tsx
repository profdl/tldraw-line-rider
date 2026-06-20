import { useState, useCallback, useMemo } from 'react'
import { Tldraw, type TLComponents, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'
import { Rider } from './game/Rider'
import type { Vec2 } from './game/physics'
import './App.css'

function App() {
	const [editor, setEditor] = useState<Editor | null>(null)
	const [playing, setPlaying] = useState(false)
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
				<Rider playing={playing} startPoint={startPoint} onStats={onStats} />
			),
		}),
		[playing, startPoint, onStats]
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
						setStartPoint({ x: c.x, y: c.y - 150 })
					}}
				>
					⌖
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
		</div>
	)
}

export default App
