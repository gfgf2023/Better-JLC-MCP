import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';

for(const mode of ['full','compact'])test(`real stdio MCP ${mode} discovery, schema, routing policy, prompts and resources`, async () => {
  const client = new Client({ name: 'easyeda-regression', version: '1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/server.js')], env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), EASYEDA_TOOL_MODE:mode, AUTO_SPAWN_BRIDGE: 'false', EASYEDA_COMPAT: '0', EASYEDA_ALLOW_RAW_CODE: '0', EASYEDA_EXPERIMENTAL_ROUTING: '0' }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.some(t => t.name === 'pcb_apply_route'));
    for (const name of ['sch_connect_pins','pcb_get_edit_context','pcb_update_copper','pcb_update_pad','pcb_replace_outline','pcb_rebuild_pours']) assert.equal(tools.some(t=>t.name===name),mode==='full',name);
    assert.ok(!tools.some(t => /auto_route|experimental|debug_execute|pcb_agent/.test(t.name)));
    const found: any = await client.callTool({ name: 'eda_find_tools', arguments: { query: 'schematic' } });
    assert.ok(found.structuredContent.data.some((t: any) => t.name === 'sch_connect_pins'));
    const schema: any = await client.callTool({ name: 'eda_tool_schema', arguments: { name: 'sch_connect_pins' } });
    assert.equal(schema.structuredContent.data.inputSchema.properties.from.properties.pin.type, 'string');
    const blocked: any = await client.callTool({ name: 'eda_invoke', arguments: { name: 'pcb_auto_route_nets', arguments: {} } });
    assert.equal(blocked.isError, true);
    const recursive: any = await client.callTool({ name: 'eda_invoke', arguments: { name: 'eda_invoke', arguments: {} } });
    assert.equal(recursive.isError, true);
    const prompt = await client.getPrompt({ name: 'easyeda_design_stage', arguments: { stage: 'routing', constraints: 'TEST-CONSTRAINT-42' } });
    assert.ok(JSON.stringify(prompt).includes('TEST-CONSTRAINT-42'));
    assert.ok(!JSON.stringify(prompt).includes('{{'));
    const resources = await client.listResources();
    assert.equal(resources.resources.length, 7);
    const editing:any=await client.callTool({name:'eda_workflow',arguments:{stage:'pcb_editing'}});
    assert.match(editing.structuredContent.data.instructions,/pcb_update_pad/);
    const read = await client.readResource({ uri: 'easyeda://workflow/placement' });
    assert.ok(JSON.stringify(read).includes('connector'));
  } finally { await client.close(); await transport.close(); }
});
