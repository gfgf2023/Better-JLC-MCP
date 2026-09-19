import { z } from 'zod';
import { createHash } from 'node:crypto';

export const finite = z.number().finite();
export const pointSchema = z.object({ x: finite, y: finite }).strict();
export const unitSchema = z.enum(['mm', 'mil']).default('mm');
export const layerSchema = z.enum(['top', 'bottom']);
export const targetSchema = z.object({ windowId: z.string().min(1), projectId: z.string().min(1), documentId: z.string().min(1), domain: z.enum(['pcb', 'schematic']) }).strict();
export type Target = z.infer<typeof targetSchema>;
export type Point = z.infer<typeof pointSchema>;
export type Layer = z.infer<typeof layerSchema>;
export type Unit = z.infer<typeof unitSchema>;
export type Status = 'success' | 'partial' | 'failed' | 'unknown';
export interface Result { status: Status; target?: Target; data?: any; changes: any[]; evidence: any; next: string[]; error?: string; }
export const result = (data: any, target?: Target): Result => ({ status: 'success', target, data, changes: [], evidence: {}, next: [] });
export function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function toMm(n: number, unit: Unit): number { return unit === 'mil' ? n * 0.0254 : n; }
export function native(n: number, domain: Target['domain']): number { return n / (domain === 'pcb' ? 0.0254 : 0.254); }
export const mmPoint = (p: Point, unit: Unit): Point => ({ x: toMm(p.x, unit), y: toMm(p.y, unit) });
// Values verified against the official EPCB_LayerId and EDMT_EditorDocumentType references.
export const layers = { top: 1, bottom: 2, outline: 11, multi: 12 } as const;
export const documentTypes = { schematic: 1, pcb: 3 } as const;
export interface Pad extends Point { id: string; net: string; number: string; component?: string; layers: Layer[]; shape: 'circle' | 'rectangle' | 'oblong' | 'unknown'; width: number; height: number; rotation: number; cornerRadius?: number; plated?: boolean; }
export interface Track { id: string; net: string; layer: Layer; start: Point; end: Point; width: number; }
export interface Via extends Point { id: string; net: string; diameter: number; drill: number; layers: Layer[]; }
export interface Component extends Point { id: string; designator: string; name: string; value?: string; supplierId?: string; rotation: number; locked: boolean; footprint?: any; pads?: any[]; }
export interface Board { unit: 'mm'; revision: string; components: Component[]; pads: Pad[]; tracks: Track[]; vias: Via[]; outline: Point[]; outlinePaths?: import('./polygon.js').PathSource[]; copper?: { id: string; net: string; layer: Layer; source: import('./polygon.js').PathSource | import('./polygon.js').PathSource[] }[]; keepouts: { id: string; layers: Layer[]; polygon: Point[]; source?: import('./polygon.js').PathSource }[]; unknown: string[]; }
export const endpointSchema = z.object({ padId: z.string().min(1) }).strict();
export const routeSchema = z.object({
  net: z.string().min(1), from: endpointSchema, to: endpointSchema, unit: unitSchema,
  segments: z.array(z.object({ layer: layerSchema, width: finite.positive(), points: z.array(pointSchema).min(2).max(100) }).strict()).min(1).max(50),
  vias: z.array(z.object({ ...pointSchema.shape, diameter: finite.positive(), drill: finite.positive() }).strict()).max(50).default([]),
  clearance: finite.nonnegative().default(0.2),
}).strict();
export type Route = z.infer<typeof routeSchema>;
export function normalizeRoute(input: Route): Route {
  const unit = input.unit;
  return { ...input, unit: 'mm', clearance: toMm(input.clearance, unit), segments: input.segments.map(s => ({ ...s, width: toMm(s.width, unit), points: s.points.map(p => mmPoint(p, unit)) })), vias: input.vias.map(v => ({ ...mmPoint(v, unit), drill: toMm(v.drill, unit), diameter: toMm(v.diameter, unit) })) };
}
