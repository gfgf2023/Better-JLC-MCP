import { point, segment, arc, vector, Polygon, Circle, Box, PlanarSet } from '@flatten-js/core';
import { type Board, type Point, type Pad, type Track, type Via, type Layer, type Route, normalizeRoute } from './model.js';
import { polygonIslands, joinOutline } from './polygon.js';

const EPS = 1e-7;
const p = (v: Point) => point(v.x, v.y);
const line = (a: Point, b: Point) => segment(p(a), p(b));
const distance = (a: Point, b: Point) => p(a).distanceTo(p(b))[0];
const polygon = (points: Point[]) => new Polygon(points.map(p));
type Body = { id: string; net: string; layers: Layer[]; shape: Polygon | Circle | ReturnType<typeof segment>; radius: number };

function padBody(pad: Pad): Body | undefined {
  if (pad.shape === 'unknown' || pad.width <= 0 || pad.height <= 0 || !pad.layers.length) return;
  const angle = pad.rotation * Math.PI / 180;
  const rotate = (x: number, y: number) => ({ x: pad.x + x * Math.cos(angle) - y * Math.sin(angle), y: pad.y + x * Math.sin(angle) + y * Math.cos(angle) });
  let shape: Body['shape'];
  let radius = 0;
  if (pad.shape === 'circle') { shape = p(pad) as any; radius = pad.width / 2; }
  else if (pad.shape === 'oblong') {
    radius = Math.min(pad.width, pad.height) / 2;
    const dx = (pad.width / 2 - radius), dy = (pad.height / 2 - radius);
    shape = line(rotate(-dx, -dy), rotate(dx, dy));
  } else if (pad.cornerRadius && pad.cornerRadius > 0) {
    const x = pad.width / 2, y = pad.height / 2, r = Math.min(pad.cornerRadius, x, y);
    const edges: any[] = [];
    const addLine = (a: Point, b: Point) => { if (distance(a, b) > EPS) edges.push(line(a, b)); };
    addLine({ x: -x + r, y: -y }, { x: x - r, y: -y });
    edges.push(arc(point(x - r, -y + r), r, -Math.PI / 2, 0, true));
    addLine({ x, y: -y + r }, { x, y: y - r });
    edges.push(arc(point(x - r, y - r), r, 0, Math.PI / 2, true));
    addLine({ x: x - r, y }, { x: -x + r, y });
    edges.push(arc(point(-x + r, y - r), r, Math.PI / 2, Math.PI, true));
    addLine({ x: -x, y: y - r }, { x: -x, y: -y + r });
    edges.push(arc(point(-x + r, -y + r), r, Math.PI, 3 * Math.PI / 2, true));
    shape = new Polygon(edges).rotate(angle).translate(vector(pad.x, pad.y));
  } else {
    shape = polygon([rotate(-pad.width / 2, -pad.height / 2), rotate(pad.width / 2, -pad.height / 2), rotate(pad.width / 2, pad.height / 2), rotate(-pad.width / 2, pad.height / 2)]);
  }
  return { id: pad.id, net: pad.net, layers: pad.layers, shape, radius };
}
function trackBody(t: Track): Body { return { id: t.id, net: t.net, layers: [t.layer], shape: line(t.start, t.end), radius: t.width / 2 }; }
function viaBody(v: Via): Body { return { id: v.id, net: v.net, layers: v.layers, shape: p(v) as any, radius: v.diameter / 2 }; }
function gap(a: Body, b: Body): number {
  // Flatten distanceTo measures boundaries; containment must count as contact.
  if (a.shape instanceof Polygon && a.shape.contains(b.shape)) return -a.radius - b.radius;
  if (b.shape instanceof Polygon && b.shape.contains(a.shape)) return -a.radius - b.radius;
  return a.shape.distanceTo(b.shape)[0] - a.radius - b.radius;
}
const sharesLayer = (a: Body, b: Body) => a.layers.some(l => b.layers.includes(l));
function bodies(board: Board): Body[] { return [...board.pads.map(padBody).filter((b): b is Body => !!b), ...board.tracks.map(trackBody), ...board.vias.map(viaBody), ...(board.copper??[]).flatMap(c=>polygonIslands(c.source).map((shape,i)=>({id:`${c.id}:island:${i}`,net:c.net,layers:[c.layer],shape,radius:0})))]; }
function expandedBox(body: Body, margin = 0) { const box = body.shape.box, radius = body.radius + margin; return new Box(box.xmin - radius, box.ymin - radius, box.xmax + radius, box.ymax + radius); }
function spatialIndex(items: Body[]) {
  const index = new PlanarSet(), lookup = new Map<any, Body>();
  for (const body of items) { index.add({ key: expandedBox(body), value: body.shape }); lookup.set(body.shape, body); }
  return (body: Body, margin = 0) => index.search(expandedBox(body, margin)).map(shape => lookup.get(shape)!);
}

export function connectivity(board: Board, net?: string) {
  const all = bodies(board);
  const unknown = [...board.unknown, ...board.pads.filter(p => !padBody(p)).map(p => `Unsupported pad ${p.id}`)];
  const nets = [...new Set(board.pads.map(p => p.net).filter(Boolean))].filter(n => !net || n === net);
  const reports = nets.map(name => {
    const items = all.filter(b => b.net === name), parent = items.map((_, i) => i);
    const root = (i: number): number => parent[i] === i ? i : (parent[i] = root(parent[i]));
    const index = spatialIndex(items), positions = new Map(items.map((body, i) => [body, i]));
    for (let i = 0; i < items.length; i++) for (const other of index(items[i], EPS)) {
      const j = positions.get(other)!;
      if (j > i && sharesLayer(items[i], other) && gap(items[i], other) <= EPS) parent[root(j)] = root(i);
    }
    const padIds = new Set(board.pads.filter(p => p.net === name).map(p => p.id));
    const groups = new Map<number, string[]>();
    items.forEach((b, i) => { const group = groups.get(root(i)) ?? []; group.push(b.id); groups.set(root(i), group); });
    const islands = [...groups.values()].filter(g => g.some(id => padIds.has(id)));
    const missingPads = [...padIds].filter(id => !items.some(b => b.id === id));
    const status = unknown.length || missingPads.length ? 'unknown' : padIds.size < 2 ? 'single_pad' : islands.length === 1 ? 'connected' : 'disconnected';
    return { net: name, status, padCount: padIds.size, islands, missingPads, danglingCopper: [...groups.values()].filter(g => !g.some(id => padIds.has(id))) };
  });
  const shorts: { a: string; b: string; nets: string[] }[] = [];
  const index = spatialIndex(all), positions = new Map(all.map((body, i) => [body, i]));
  for (let i = 0; i < all.length; i++) for (const other of index(all[i], EPS)) {
    if (positions.get(other)! > i && all[i].net !== other.net && sharesLayer(all[i], other) && gap(all[i], other) <= EPS) shorts.push({ a: all[i].id, b: other.id, nets: [all[i].net, other.net] });
  }
  return { nets: reports, shorts, unknown, passed: reports.length > 0 && !unknown.length && !shorts.length && reports.every(r => r.status === 'connected' || r.status === 'single_pad') };
}

export function checkRoute(board: Board, input: Route) {
  const route = normalizeRoute(input);
  const conflicts: { kind: string; object: string; at?: Point; gap?: number }[] = [];
  const unknown = [...board.unknown];
  const from = board.pads.find(p => p.id === route.from.padId), to = board.pads.find(p => p.id === route.to.padId);
  if (!from || !to || from.id === to.id || from.net !== route.net || to.net !== route.net) conflicts.push({ kind: 'invalid_endpoints', object: route.net });
  const tracks: Track[] = [], vias: Via[] = [];
  route.segments.forEach((s, si) => {
    for (let i = 1; i < s.points.length; i++) {
      if (distance(s.points[i - 1], s.points[i]) <= EPS) conflicts.push({ kind: 'zero_length', object: `segment:${si}:${i}` });
      else tracks.push({ id: `candidate:track:${si}:${i}`, net: route.net, layer: s.layer, width: s.width, start: s.points[i - 1], end: s.points[i] });
    }
  });
  route.vias.forEach((v, i) => {
    if (v.drill >= v.diameter) conflicts.push({ kind: 'invalid_via', object: `via:${i}` });
    vias.push({ ...v, id: `candidate:via:${i}`, net: route.net, layers: ['top', 'bottom'] });
  });
  const candidates = [...tracks.map(trackBody), ...vias.map(viaBody)];
  const obstacles = bodies(board);
  const nearby = spatialIndex(obstacles);
  for (const pad of board.pads) if (!padBody(pad)) unknown.push(`Unsupported pad ${pad.id}`);
  let outline: Polygon | undefined;
  try { outline = board.outlinePaths?.length ? joinOutline(board.outlinePaths) : board.outline.length >= 3 ? polygon(board.outline) : undefined; } catch { unknown.push('Invalid board outline geometry'); }
  if (!outline || !outline.isValid()) unknown.push('Missing or invalid board outline');
  for (const c of candidates) {
    for (const o of nearby(c, route.clearance)) {
      if (o.net === c.net || !sharesLayer(c, o)) continue;
      const d = gap(c, o);
      if (d < route.clearance - EPS) conflicts.push({ kind: 'copper_clearance', object: o.id, gap: d });
    }
    for (const k of board.keepouts) {
      if (!c.layers.some(l => k.layers.includes(l))) continue;
      const shapes=k.source?polygonIslands(k.source):[polygon(k.polygon)];
      const d = Math.min(...shapes.map(shape=>gap(c, { id: k.id, net: '', layers: k.layers, shape, radius: 0 })));
      if (d < route.clearance - EPS) conflicts.push({ kind: 'keepout', object: k.id, gap: d });
    }
    if (outline && outline.isValid()) {
      if (!outline.contains(c.shape)) conflicts.push({ kind: 'outside_board', object: c.id });
      for (const edge of outline.edges) {
        const d = c.shape.distanceTo(edge.shape)[0] - c.radius;
        if (d < route.clearance - EPS) conflicts.push({ kind: 'board_edge_clearance', object: c.id, gap: d });
      }
    }
  }
  const first = route.segments[0], last = route.segments.at(-1)!;
  if (from && (distance(from, first.points[0]) > EPS || !from.layers.includes(first.layer))) conflicts.push({ kind: 'start_not_on_pad', object: from.id });
  if (to && (distance(to, last.points.at(-1)!) > EPS || !to.layers.includes(last.layer))) conflicts.push({ kind: 'end_not_on_pad', object: to.id });
  for (let i = 1; i < route.segments.length; i++) {
    const a = route.segments[i - 1], b = route.segments[i], joint = a.points.at(-1)!;
    if (distance(joint, b.points[0]) > EPS) conflicts.push({ kind: 'discontinuous_path', object: `segment:${i}` });
    if (a.layer !== b.layer && !vias.some(v => distance(v, joint) < EPS) && !board.vias.some(v => distance(v, joint) < EPS && v.net === route.net && v.layers.includes(a.layer) && v.layers.includes(b.layer))) conflicts.push({ kind: 'missing_layer_transition', object: `segment:${i}`, at: joint });
  }
  const after = connectivity({ ...board, tracks: [...board.tracks, ...tracks], vias: [...board.vias, ...vias] }, route.net);
  const connectedEndpoints = after.nets.some(n => n.islands.some(g => g.includes(route.from.padId) && g.includes(route.to.padId)));
  if (!connectedEndpoints) conflicts.push({ kind: 'endpoints_disconnected', object: route.net });
  return { passed: !conflicts.length && !unknown.length, conflicts, unknown: [...new Set(unknown)], route, tracks, vias, predictedConnectivity: after };
}

export function assembleOutline(lines: { start: Point; end: Point }[]): Point[] {
  if (!lines.length) return [];
  const remaining = lines.slice(1), points = [lines[0].start, lines[0].end];
  while (remaining.length) {
    const end = points.at(-1)!;
    const index = remaining.findIndex(l => distance(l.start, end) < EPS || distance(l.end, end) < EPS);
    if (index < 0) return [];
    const [l] = remaining.splice(index, 1);
    points.push(distance(l.start, end) < EPS ? l.end : l.start);
  }
  return distance(points[0], points.at(-1)!) < EPS ? points.slice(0, -1) : [];
}

export function routeCoverage(board: Board, input: Route) {
  const route = normalizeRoute(input), tolerance = 0.00001;
  const uncovered: string[] = [];
  route.segments.forEach((s, si) => {
    for (let i = 1; i < s.points.length; i++) {
      const a = s.points[i - 1], b = s.points[i], dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
      const project = (p: Point) => ((p.x - a.x) * dx + (p.y - a.y) * dy) / length;
      const offset = (p: Point) => Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / length;
      const spans = board.tracks.filter(t => t.net === route.net && t.layer === s.layer && Math.abs(t.width - s.width) < tolerance && offset(t.start) < tolerance && offset(t.end) < tolerance)
        .map(t => [Math.min(project(t.start), project(t.end)), Math.max(project(t.start), project(t.end))]).sort((a, b) => a[0] - b[0]);
      let covered = 0;
      for (const [start, end] of spans) { if (start > covered + tolerance) break; covered = Math.max(covered, end); }
      if (covered < length - tolerance) uncovered.push(`segment:${si}:${i}`);
    }
  });
  route.vias.forEach((v, i) => {
    if (!board.vias.some(actual => actual.net === route.net && distance(actual, v) < tolerance && Math.abs(actual.diameter - v.diameter) < tolerance && Math.abs(actual.drill - v.drill) < tolerance && actual.layers.includes('top') && actual.layers.includes('bottom'))) uncovered.push(`via:${i}`);
  });
  return { passed: !uncovered.length, uncovered };
}
