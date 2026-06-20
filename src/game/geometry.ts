import { getPointsFromDrawSegment, type Editor, type TLShape, type TLDrawShape, type Vec } from 'tldraw'
import type { LineKind, Segment, Vec2 } from './physics'

// The "kind" of a track line is derived from a native shape's color. This keeps
// us fully on tldraw's native stack — users draw with the native pencil/geo
// tools and pick a color; we interpret the color as gameplay behavior.
// `LineKind` is defined in physics.ts (the consumer); we map colors onto it.

// Map native tldraw colors -> gameplay line kinds. Each entry carries a
// `strength` (0..1) so a "light-" color can reuse its base kind at a weaker
// magnitude (per PLANNING.md's "same kind, tuned constant" decision). Strength
// is a no-op for kinds that don't read it (solid/oneway/scenery).
interface KindSpec {
	kind: LineKind
	strength: number
}

const COLOR_TO_KIND: Record<string, KindSpec> = {
	black: { kind: 'solid', strength: 1 },
	grey: { kind: 'solid', strength: 1 },
	red: { kind: 'accelerate', strength: 1 },
	'light-red': { kind: 'accelerate', strength: 0.5 },
	orange: { kind: 'brake', strength: 1 },
	yellow: { kind: 'bounce', strength: 1 },
	blue: { kind: 'oneway', strength: 1 },
	'light-blue': { kind: 'oneway', strength: 1 },
	violet: { kind: 'sticky', strength: 1 },
	'light-violet': { kind: 'sticky', strength: 0.5 },
	white: { kind: 'ice', strength: 1 },
	green: { kind: 'scenery', strength: 1 },
	'light-green': { kind: 'scenery', strength: 1 },
}

const DEFAULT_SPEC: KindSpec = { kind: 'solid', strength: 1 }

// Only these native shape types become collision track. Everything else (text,
// image, video, frame, embed, bookmark, note, highlight, …) is treated as
// scenery — it would otherwise act as an invisible solid wall, since those
// shapes carry no track-meaningful color. An allowlist (not a denylist) means a
// future tldraw shape type is non-collidable by default rather than a surprise
// wall. These four are the shapes whose geometry reads as a ridable line/path.
const COLLIDABLE_TYPES = new Set(['draw', 'line', 'geo', 'arrow'])

/** A page-space collision segment with a definite gameplay kind. */
export interface TrackSegment extends Segment {
	kind: LineKind
}

function specOf(shape: TLShape): KindSpec {
	// Most drawable shapes carry a `color` prop; default to solid otherwise.
	const color = (shape.props as { color?: string }).color
	if (color && color in COLOR_TO_KIND) return COLOR_TO_KIND[color]
	return DEFAULT_SPEC
}

/**
 * Convert collidable shapes on the current page into page-space collision
 * segments.
 *
 * For each shape we ask tldraw for its geometry (LOCAL coords), read the
 * outline `vertices`, and transform them to page space with the shape's page
 * transform. Consecutive vertices become segments. This works uniformly for
 * native draw strokes, geo shapes, lines, arrows, etc. — no custom shape type.
 *
 * Skipped: non-track shape types (see COLLIDABLE_TYPES) and scenery-colored
 * shapes — both decorative / non-collidable.
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
		// Skip non-track shape types (text/image/frame/…) so they don't act as
		// invisible walls, independent of color.
		if (!COLLIDABLE_TYPES.has(shape.type)) continue

		const { kind, strength } = specOf(shape)
		if (kind === 'scenery') continue

		// Use the shape id so the transform/geometry caches resolve against the
		// live record, not the enumerated snapshot object.
		const transform = editor.getShapePageTransform(shape.id)
		if (!transform) continue

		// Draw (pencil) shapes can contain multiple strokes separated by
		// pen-lifts. Their flattened geometry would bridge the gaps with a
		// phantom line, so decode each stroke separately and never connect
		// across strokes.
		if (shape.type === 'draw') {
			const draw = shape as TLDrawShape
			const scale = draw.props.scale
			const strokes = draw.props.segments
			let firstPt: Vec | undefined
			let lastPt: Vec | undefined
			let totalPts = 0
			for (const stroke of strokes) {
				const localPts = getPointsFromDrawSegment(stroke, scale, scale)
				const pts = transform.applyToPoints(localPts)
				if (pts.length === 0) continue
				// Push each stroke on its own so we never bridge a pen-lift gap
				// with a phantom line between strokes.
				pushPolyline(segments, pts, kind, strength, false)
				if (!firstPt) firstPt = pts[0]
				lastPt = pts[pts.length - 1]
				totalPts += pts.length
			}
			// A closed freehand loop connects the overall last point back to the
			// overall first point. Guard on the total point count (not the final
			// stroke's) so a closed loop ending in a degenerate tap still closes.
			if (draw.props.isClosed && firstPt && lastPt && totalPts > 2) {
				segments.push(makeSeg(lastPt, firstPt, kind, strength))
			}
			continue
		}

		// Everything else: use tldraw's geometry outline (local) -> page space.
		const geometry = editor.getShapeGeometry(shape)
		const localVerts = geometry.vertices
		if (!localVerts || localVerts.length < 2) continue
		const verts = transform.applyToPoints(localVerts)
		pushPolyline(segments, verts, kind, strength, geometry.isClosed)
	}

	return segments
}

/** Emit segments between consecutive points; optionally close the loop. */
function pushPolyline(out: TrackSegment[], pts: Vec[], kind: LineKind, strength: number, closed: boolean) {
	for (let i = 0; i < pts.length - 1; i++) {
		out.push(makeSeg(pts[i], pts[i + 1], kind, strength))
	}
	if (closed && pts.length > 2) {
		out.push(makeSeg(pts[pts.length - 1], pts[0], kind, strength))
	}
}

function makeSeg(a: Vec2, b: Vec2, kind: LineKind, strength: number): TrackSegment {
	return { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, kind, strength }
}
