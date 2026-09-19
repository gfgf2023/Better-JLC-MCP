import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { result, type Result } from './model.js';

export interface Tool { name: string; category: string; description: string; schema: z.AnyZodObject; mutates?: boolean; direct?: boolean; experimental?: boolean; raw?: boolean; handler(input: any): Promise<Result>; }
export const blockedLegacy = new Set(['pcb_auto_route_nets', 'pcb_auto_fanout_and_route', 'pcb_route_differential_pairs', 'pcb_auto_place_components', 'pcb_agent', 'pcb_execute_code']);
export class Registry {
  tools = new Map<string, Tool>();
  constructor(public experimental = process.env.EASYEDA_EXPERIMENTAL_ROUTING === '1', public raw = process.env.EASYEDA_ALLOW_RAW_CODE === '1') {}
  add(tool: Tool) { if (this.tools.has(tool.name)) throw new Error(`Duplicate tool ${tool.name}`); this.tools.set(tool.name, tool); }
  available(t: Tool) { return (!t.experimental || this.experimental) && (!t.raw || this.raw); }
  describe(t: Tool) { return { name: t.name, category: t.category, description: t.description, readOnly: !t.mutates, inputSchema: zodToJsonSchema(t.schema, { target: 'jsonSchema7' }) }; }
  async call(name: string, input: unknown): Promise<Result> {
    try {
      const tool = this.tools.get(name);
      if (blockedLegacy.has(name) || !tool || !this.available(tool)) throw new Error(`TOOL_DISABLED_OR_UNKNOWN: ${name}`);
      return await tool.handler(tool.schema.parse(input));
    } catch (e: any) { return { ...result(null), status: 'failed', error: e.message, next: ['Read eda_tool_schema and correct the request.'] }; }
  }
  install(server: McpServer) {
    const register = (tool: Tool) => server.registerTool(tool.name, {
      description: tool.description, inputSchema: tool.schema,
      annotations: { readOnlyHint: !tool.mutates, destructiveHint: !!tool.mutates, idempotentHint: !tool.mutates, openWorldHint: true },
    }, async (args: any) => toMcp(await this.call(tool.name, args)));
    this.add({ name: 'eda_find_tools', category: 'discovery', description: 'Search available tools by name, category or purpose. Returns typed tool names; inspect eda_tool_schema before invoking.', direct: true, schema: z.object({ query: z.string().default('') }).strict(), handler: async ({ query }) => result([...this.tools.values()].filter(t => this.available(t) && `${t.name} ${t.category} ${t.description}`.toLowerCase().includes(query.toLowerCase())).map(t => ({ name: t.name, category: t.category, description: t.description }))) });
    this.add({ name: 'eda_tool_schema', category: 'discovery', description: 'Return complete JSON Schema, purpose and read/write semantics for one tool.', direct: true, schema: z.object({ name: z.string() }).strict(), handler: async ({ name }) => { const t = this.tools.get(name); if (!t || !this.available(t)) throw new Error('Tool unavailable'); return result(this.describe(t)); } });
    this.add({ name: 'eda_invoke', category: 'discovery', description: 'Execute a discovered tool using its complete schema. Same validation, policy and write checks as direct calls.', direct: true, mutates: true, schema: z.object({ name: z.string(), arguments: z.record(z.unknown()) }).strict(), handler: async ({ name, arguments: args }) => { if (['eda_invoke', 'eda_find_tools', 'eda_tool_schema'].includes(name)) throw new Error('Recursive discovery invocation prohibited'); return this.call(name, args); } });
    // Full typed schemas prevent schema hallucinations behind generic invocation.
    // Compact exposure remains an explicit option for clients with tight tool budgets.
    for (const tool of this.tools.values()) if (this.available(tool) && (process.env.EASYEDA_TOOL_MODE !== 'compact' || tool.direct)) register(tool);
  }
}
export function toMcp(output: Result): any {
  const { image, ...data } = output.data ?? {};
  const safe = image ? { ...output, data } : output;
  const content: any[] = [{ type: 'text', text: JSON.stringify(safe) }];
  if (image) content.push({ type: 'image', data: image.base64, mimeType: image.mimeType });
  return { content, structuredContent: safe, ...(output.status !== 'success' ? { isError: true } : {}) };
}
