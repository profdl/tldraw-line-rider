import { getPointsFromDrawSegment, type Editor, type TLShape, type TLDrawShape, type Vec } from 'tldraw'
import type { Segment, Vec2 } from './physics'

// The "kind" of a track line, derived from a native shape's color. This keeps
// us fully on tldraw's native stack — users draw with the native pencil/geo
// tools and pick a color; we interpret the color as gameplay behavior.
export type LineKind = 'solid' | 'accelerate' | 'oneway' | 'scenery'

// Map native tldraw colors -> gameplay line kinds.
const COLOR_TO_KIND: Record<string, LineKind> = {
	black: 'solid',
	grey: 'solid',
	red: 'accelerate',
	'light-red': 'accelerate',
	blue: 'oneway',
	'light-blue': 'oneway',
	green: 'scenery',
	'light-green': 'scenery',
}

/** A page-space collision segment plus the gameplay kind it came from. */
export interface TrackSegment extends Segment {
	kind: LineKind
}

function kindOf(shape: TLShape): LineKind {
	// Most drawable shapes carry a `color` prop; default to solid otherwise.
	const color = (shape.props as { color?: string }).color
	if (color && color in COLOR_TO_KIND) return COLOR_TO_KIND[color]
	return 'solid'
}

/**
 * Convert every shape on the current page into page-space collision segments.
 *
 * For each shape we ask tldraw for its geometry (LOCAL coords), read the
 * outline `vertices`, and transform them to page space with the shape's page
 * transform. Consecutive vertices become segments. This works uniformly for
 * native draw strokes, geo shapes, lines, arrows, etc. — no custom shape type.
 *
 * Scenery-colored shapes are excluded (decorative, non-collidable).
 */
export function collectSegments(editor: Editor): TrackSegment[] {
	// Read geometry inside a transaction so tldraw's reactive computed caches
	// (getShapePageTransform / getShapeGeometry) recompute against the current
	// store epoch. Read cold from a bare rAF callback, those caches can return
	// values from before a shape was moved — which silently breaks collision
	// the next time you play after dragging a shape.
	let result: TrackSegment[] = []
	editor.run(() => {
		result = collectSegmentsNow(editor)
	}, { history: 'ignore' })
	return result
}

function collectSegmentsNow(editor: Editor): TrackSegment[] {
	const segments: TrackSegment[] = []

	for (const shape of editor.getCurrentPageShapes()) {
		const kind = kindOf(shape)
		if (kind === 'scenery') continue

		// Use the shape id so the transform/geometry caches resolve against the
		// live record, not the enumerated snapshot object.
		const transform = editor.getShapePageTransform(shape.id)

		// Draw (pencil) shapes can contain multiple strokes separated by
		// pen-lifts. Their flattened geometry would bridge the gaps with a
		// phantom line, so decode each stroke separately and never connect
		// across strokes.
		if (shape.type === 'draw') {
			const draw = shape as TLDrawShape
			const scale = draw.props.scale
			for (const seg of draw.props.segments) {
				const localPts = getPointsFromDrawSegment(seg, scale, scale)
				pushPolyline(segments, transform.applyToPoints(localPts), kind, false)
			}
			// A closed freehand loop: connect the very last point to the first.
			if (draw.props.isClosed) {
				const all = transform.applyToPoints(
					draw.props.segments.flatMap((s) => getPointsFromDrawSegment(s, scale, scale))
				)
				if (all.length > 2) segments.push(makeSeg(all[all.length - 1], all[0], kind))
			}
			continue
		}

		// Everything else: use tldraw's geometry outline (local) -> page space.
		const geometry = editor.getShapeGeometry(shape)
		const localVerts = geometry.vertices
		if (!localVerts || localVerts.length < 2) continue
		const verts = transform.applyToPoints(localVerts)
		pushPolyline(segments, verts, kind, geometry.isClosed)
	}

	return segments
}

/** Emit segments between consecutive points; optionally close the loop. */
function pushPolyline(out: TrackSegment[], pts: Vec[], kind: LineKind, closed: boolean) {
	for (let i = 0; i < pts.length - 1; i++) {
		out.push(makeSeg(pts[i], pts[i + 1], kind))
	}
	if (closed && pts.length > 2) {
		out.push(makeSeg(pts[pts.length - 1], pts[0], kind))
	}
}

function makeSeg(a: Vec2, b: Vec2, kind: LineKind): TrackSegment {
	return { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, kind }
}
