# Design Workflow

Load the matching `eda_workflow` stage before operating. Read live tool schemas instead of reconstructing arguments from prose.

## Schematic

Record voltage/current requirements, interfaces, intended reference/pin-to-net contracts and mechanical constraints before dependent choices. Resolve consequential unknowns; avoid making the old ATtiny validation board a default circuit.

Use `lib_search_devices` with keywords or LCSC part numbers. Use actual library/device UUIDs and existing symbol/footprint bindings in `sch_place_component`. Read `sch_get_state` after placement/rotation for real world pin coordinates. Check power pin semantics and datasheet requirements; pin names alone are not sufficient.

Connect reference and pin number through `sch_connect_pins`, supplying deliberate intermediate vertices as needed. For named connections use `sch_add_net_label`; its wire stub connects the pin. Placing a net port directly on a pin without a wire can leave coincident unconnected endpoints. Verify the exported netlist, not label proximity.

Run `sch_get_netlist` and `sch_verify` with explicit expected pin contracts. Check missing and extra connections, duplicate wire/label effects, real component values and supplier/footprint bindings. A warning about properties differing from the library calls for inspection; do not standardize away an intentional component choice just to silence DRC. `sch_restore_device_metadata` is applicable only after checking the current schema and real source device.

Arrange functional groups and signal flow, with readable labels, sensible page divisions and visible power relationships. `sch_add_annotation` and `sch_arrange_attributes` provide non-electrical presentation edits. Compare electrical hashes before and after visual changes. Use fresh overall and local `eda_screenshot` images to inspect text, wire junctions and labels.

## Sync And Placement

`pcb_import_schematic` takes the parent schematic UUID, not the page UUID. Activate the exact PCB document with `eda_open_document`, use its new target, then import with expected references. Read actual components, footprint bindings, pads and pad nets afterward. If the editor awaits import confirmation, complete that UI step within the authorized task, then read back; do not keep re-importing.

Read `pcb_get_state` for revision, board outline, copper and unsupported geometry. Determine connector positions/orientations from mechanical constraints. Place functional groups with short decoupling, regulator feedback and other sensitive loops according to datasheets. Preserve necessary return paths; do not invent universal analog/digital ground splitting rules.

Supply explicit positions to `pcb_move_components` using the current revision. Refresh actual pads after every batch. Use `pcb_review_layout` for explicit distance/orientation constraints and inspect images. Resolve `STALE_REVISION` by reading and replanning. Do not move routed components without accounting for their copper and re-verifying connectivity.

## Model-Directed Routing

1. Read `pcb_get_routing_context` for one net, including real pad IDs, conductive components, obstacles, outline and revision. Inspect the area image. Choose which disconnected components to connect next.
2. Choose an explicit path with adequate width/clearance and supported layers. Respect all pad shapes and existing copper. Each layer transition needs a physically valid conductive connection, normally a via or supported plated through-hole pad.
3. Send the full route to `pcb_check_route`. Examine its check result and `unknown`/conflicts, not only the outer execution status. Revise vertices, layers or placement when blocked. No straight-through-obstacle fallback is acceptable.
4. Call `pcb_apply_route` with the checked route, current revision and fresh operation ID. Read actual changes, path coverage, net connectivity and DRC. Refresh context before the next path.
5. Continue until every required pad belongs to one conductive component, then check shorts and native DRC. One completed endpoint path may leave other pads disconnected.

Route structure in version 0.1.0: `net`, `from: {padId}`, `to: {padId}`, `unit`, `segments: [{layer, width, points: [{x,y}, ...]}]`, `vias: [{x,y,diameter,drill}]`, and `clearance`. Read the live schema before constructing a request. Set clearance explicitly in the chosen unit, especially for mil; do not rely on the numeric default.

Unsupported pours, regions, special pads or inner layers prevent a complete geometry check. Report the missing coverage and resolve supported alternatives within design constraints. Do not discard unknown objects just to get a passing result.

## Review

Read `pcb_design_health_report`, actual connectivity and `eda_run_drc`. Its `electricalChecksPassed` and `designAccepted` are different fields; the report itself does not accept a board. Compare schematic pin contracts to PCB pad nets, check opens/shorts, dimensions and required return paths. A GND pour's presence does not verify islands, necks or current return quality.

Use `eda_save` and, for final verification, `eda_reopen_and_verify`; inspect fresh screenshots afterward. Export the actual netlist and `pcb_bom_export`. Preserve raw DRC facts: a boolean or category count supplies no issue details. Report an unresolved warning when its detail is unavailable, even if the user sees no visible error.

Separate passing electrical checks from visual review, datasheet compliance, mechanical fit and manufacturing acceptance. Include only acceptance claims supported by evidence collected on the current design.
