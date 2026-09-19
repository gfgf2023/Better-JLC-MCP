import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Runtime } from './runtime.js';
import { buildToolkit } from './toolkit.js';
import { instructions, workflows } from './workflows.js';

const server = new McpServer({ name: 'easyeda-mcp', version: '0.2.0' }, { instructions });
const registry = buildToolkit(new Runtime());
registry.install(server);
for (const [stage, text] of Object.entries(workflows)) {
  const uri = `easyeda://workflow/${stage}`;
  server.resource(`workflow-${stage}`, uri, { description: `Design workflow: ${stage}`, mimeType: 'text/plain' }, async () => ({ contents: [{ uri, mimeType: 'text/plain', text }] }));
}
server.registerPrompt('easyeda_design_stage', { description: 'Apply a workflow to the supplied design constraints.', argsSchema: { stage: z.enum(['start', 'schematic', 'placement', 'routing', 'review', 'recovery', 'pcb_editing']), constraints: z.string() } }, async ({ stage, constraints }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `${workflows[stage]}\n\nDesign constraints:\n${constraints}` } }] }));
await server.connect(new StdioServerTransport());
process.stderr.write(`[easyeda-mcp] Ready. Explicit model routing; ${registry.tools.size} registered tools.\n`);
