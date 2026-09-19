import { point, segment, arc, vector, Polygon, type Segment, type Arc } from '@flatten-js/core';

/** EasyEDA polygon tokens. Coordinates/radii use the declared unit; angles are degrees. */
export type PathSource = (number | 'L' | 'ARC' | 'CARC' | 'CIRCLE' | 'R')[];
export type Edge = Segment | Arc;
const EPS = 1e-7;
export function sourceEdges(source: unknown, scale = 1, close = true): Edge[] {
  if (!Array.isArray(source) || !source.length) throw new Error('Empty polygon source');
  let i = 0;
  const num = () => { const n = source[i++]; if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error('Invalid polygon number'); return n; };
  const pt = () => point(num() * scale, num() * scale);
  if (source[0] === 'CIRCLE') {
    i++; const center = pt(), r = num() * scale;
    if (r <= 0 || i !== source.length) throw new Error('Invalid circle');
    return [arc(center, r, 0, Math.PI * 2, true)];
  }
  if (source[0] === 'R') {
    i++; const origin = pt(), w = num() * scale, h = num() * scale, rotation = num(), r = num() * scale;
    if (w <= 0 || h <= 0 || r < 0 || r > Math.min(w, h) / 2 || i !== source.length) throw new Error('Invalid rectangle');
    // EasyEDA PCB Y increases upwards: R stores the top-left corner.
    const raw: PathSource = r ? [r, 0, 'L', w-r, 0, 'ARC', -90, w, -r, 'L', w, -h+r, 'ARC', -90, w-r, -h, 'L', r, -h, 'ARC', -90, 0, -h+r, 'L', 0, -r, 'ARC', -90, r, 0]
      : [0, 0, 'L', w, 0, w, -h, 0, -h, 0, 0];
    return sourceEdges(raw).map(e => e.rotate(rotation * Math.PI / 180).translate(vector(origin.x, origin.y)));
  }
  let current = pt(); const first = current, edges: Edge[] = [];
  while (i < source.length) {
    const token = source[i];
    if (token === 'L') { i++; if (i === source.length) throw new Error('Empty line command'); continue; }
    if (token === 'ARC' || token === 'CARC') {
      i++; const degrees = num(), end = pt(), theta = degrees * Math.PI / 180;
      const dx = end.x-current.x, dy = end.y-current.y;
      if (Math.abs(degrees) < 1e-8 || Math.abs(degrees) >= 360 || Math.hypot(dx,dy) < EPS) throw new Error('Invalid arc');
      const k = 1 / (2 * Math.tan(theta / 2));
      const center = point((current.x+end.x)/2-dy*k, (current.y+end.y)/2+dx*k);
      const start = Math.atan2(current.y-center.y, current.x-center.x);
      edges.push(arc(center, Math.hypot(current.x-center.x,current.y-center.y), start, start+theta, theta > 0)); current = end;
    } else if (typeof token === 'number') {
      const end = pt(); if (!current.equalTo(end)) edges.push(segment(current, end)); current = end;
    } else throw new Error(`Unsupported polygon command: ${String(token)}`);
  }
  if (close && !current.equalTo(first)) edges.push(segment(current, first));
  if (!edges.length) throw new Error('Degenerate path');
  return edges;
}

export function scaleSource(source: PathSource, factor: number): PathSource {
  sourceEdges(source); // Validate all arities before scaling.
  if (source[0] === 'CIRCLE') return ['CIRCLE', ...source.slice(1).map(n => Number(n)*factor)];
  if (source[0] === 'R') return ['R', Number(source[1])*factor, Number(source[2])*factor, Number(source[3])*factor, Number(source[4])*factor, source[5], Number(source[6])*factor];
  let angle = false;
  return source.map(v => { if (typeof v === 'string') { angle = v === 'ARC' || v === 'CARC'; return v; } if (angle) { angle = false; return v; } return v * factor; });
}

/** Each outer contour becomes a separate island; nested holes never bridge islands. */
export function polygonIslands(source: unknown, scale = 1): Polygon[] {
  const paths = Array.isArray(source) && Array.isArray(source[0]) ? source : [source];
  const polys = paths.map(s => new Polygon(sourceEdges(s, scale)));
  if (polys.some(p => !p.isValid() || p.area() < EPS)) throw new Error('Invalid polygon');
  for (let i=0;i<polys.length;i++) for(let j=i+1;j<polys.length;j++) {
    if (polys[i].intersect(polys[j]).length) throw new Error('Touching or intersecting contours');
  }
  const parents = polys.map((p,i) => polys.map((q,j)=>({q,j})).filter(({q,j})=>j!==i && q.contains([...p.edges][0].start)).sort((a,b)=>a.q.area()-b.q.area())[0]?.j);
  const depth = (i:number):number => parents[i] === undefined ? 0 : 1+depth(parents[i]!);
  return polys.flatMap((poly,i) => {
    if (depth(i)%2) return [];
    const island = poly.clone(), face = [...island.faces][0];
    polys.forEach((hole,j) => { if (parents[j]===i) { const h=[...hole.clone().faces][0]; if(h.orientation()===face.orientation())h.reverse(); island.addFace([...h.edges].map(e=>e.shape)); } });
    return [island];
  });
}

export function joinOutline(paths: PathSource[]): Polygon {
  const remaining = paths.flatMap(s => sourceEdges(s, 1, false));
  const contours: Edge[][] = [];
  while (remaining.length) {
    const edges = [remaining.shift()!];
    while (!edges.at(-1)!.end.equalTo(edges[0].start)) {
      const end = edges.at(-1)!.end;
      const matches = remaining.map((e,i)=>({e,i})).filter(({e})=>e.start.equalTo(end)||e.end.equalTo(end));
      if(matches.length!==1) throw new Error('Open or branching board outline');
      const {e,i}=matches[0]; remaining.splice(i,1); edges.push(e.start.equalTo(end)?e:e.reverse());
    }
    contours.push(edges);
  }
  if(!contours.length)throw new Error('Missing board outline');
  // Outline cutouts must be nested within exactly one outer boundary.
  const outer = contours.map(e=>new Polygon(e)).sort((a,b)=>b.area()-a.area());
  const result=outer.shift()!, orientation=[...result.faces][0].orientation();
  for(const hole of outer){
    if(result.intersect(hole).length || !result.contains([...hole.edges][0].start))throw new Error('Disjoint/overlapping outline contours');
    const face=[...hole.faces][0]; if(face.orientation()===orientation)face.reverse();result.addFace([...face.edges].map(e=>e.shape));
  }
  if(!result.isValid())throw new Error('Invalid board outline');
  return result;
}
