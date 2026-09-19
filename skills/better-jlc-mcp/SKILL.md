---
name: better-jlc-mcp
description: Design, edit, route, or verify EasyEDA (嘉立创EDA) schematics and two-layer PCBs using Better-JLC-MCP, including existing copper shapes, pads and board outlines. Use for model-directed circuit design with the official Run API Gateway and for this MCP's local setup or troubleshooting.
---

# Better-JLC-MCP

Use the typed execution layer from https://github.com/gfgf2023/Better-JLC-MCP. The client model supplies design decisions and explicit geometry; the server validates and applies them. Start at the user's current design stage, preserving existing work and authorized scope.

## Start And Discover

1. Call `eda_session` and inspect the actual window, project and document. Bind subsequent requests to its returned `target` (windowId, projectId, documentId, domain). An old test project's authorization or UUID is not authorization for a new project.
2. Call `eda_workflow` with the current stage: `start`, `schematic`, `placement`, `routing`, `pcb_editing`, `review`, or `recovery`. Read `eda_memory` and capabilities when needed. Method existence alone does not prove behavior.
3. Version 0.2.0 directly exposes all enabled typed tools. Use the actual client namespace and full schema. Discovery through `eda_find_tools` / `eda_tool_schema` is also available; in opt-in compact mode use `eda_invoke` with `{name, arguments}`. Literal search terms such as `pcb_editing`, `schematic`, or `routing` work better than natural-language questions.
4. Read only the relevant reference: [PCB editing](references/pcb-editing.md) for copper/pads/existing outline or RF geometry; [design workflow](references/design.md) for schematic/layout/routing/review; [recovery](references/recovery.md) for uncertain outcomes; [local setup](references/local-setup.md) when the MCP or bridge is unavailable.

Runtime schemas and actual observations take precedence over examples. Do not invent a missing tool or bypass the execution layer with direct Gateway code to complete a design operation.

## Execution Rules

- Read real pins, pads, library bindings and geometry before choosing coordinates. Default to explicit `unit: "mm"`; semantic copper layers are `top` and `bottom`. PCB native units are mil and schematic native units are 10mil; the new adapter handles conversions. Do not convert twice or copy old native-unit examples into new requests.
- Give each new document mutation a unique `operationId`. Reuse an ID only to retrieve the result of the identical request. Serialize operations targeting one window. After changing tabs, obtain and verify the new target.
- Interpret `status`, `changes`, `evidence`, and the tool's actual check results together. `status: success` can mean a read/check executed successfully while `data.passed` is false. `partial`, `failed`, and `unknown` never prove completion; they may still have changed the document.
- The model specifies net, endpoint pads, vertices, width, layers and vias. Use `pcb_get_routing_context`, `pcb_check_route`, and `pcb_apply_route`. Do not select automatic routing merely because the user says "route the board" or "finish automatically".
- Default routing/debug flags remain disabled. Do not enable them to work around a conflict or missing capability. An explicit request to change experimental configuration is a separate task; candidate generation is read-only and arbitrary code disables the routing guarantee.
- A visible line, coincident endpoints, successful API call, valid image or empty DRC result is insufficient by itself to establish electrical correctness. Unsupported copper geometry is an unresolved validation limit.
- Check `pcb_get_edit_context` before concluding copper, pad or outline edits are unavailable. Fixed Fill, refillable Pour and actual Poured islands are different objects. A routing check returning unknown does not disable supported editing. Preserve RF radiator/feed geometry and follow the user's design constraints.

## Memory And Completion

Use `eda_memory` and `eda_update_memory` for project constraints, component/layout decisions, unresolved issues, and versioned API observations. The update replaces memory: read first and preserve still-relevant entries. Project constraints outrank heuristics. Observations need version, reproduction, evidence and verified status; do not promote an unverified observation to a general rule.

Report actual changes, pin/net verification, connectivity/shorts, DRC, screenshots, save/reopen evidence and outstanding limits appropriate to the requested scope. Keep private UUIDs, operation logs and backups out of public examples. A narrow edit does not require rebuilding the entire design or claiming full acceptance.

The 0.1.0 example board was partly accepted on EasyEDA 3.2.149; its PCB passed connectivity and DRC, but schematic warning detail, manufacturing review and comparative model evaluation remain incomplete. It is evidence of tested operations, not proof that future boards or this tool outperform alternatives.

Version 0.2.0 separately tested pad, fixed copper, pour and existing-outline editing in an authorized isolated PCB. Actual poured path units, drill removal and complete RF acceptance remain unsupported or unverified; consult returned evidence instead of transferring test-board acceptance to the current design.
