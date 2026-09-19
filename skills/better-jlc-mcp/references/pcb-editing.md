# Existing PCB And RF Geometry

Read `pcb_get_edit_context` with the current target. Its editing revision differs from the routing revision. Returned raw `properties` use **mil**; reuse source arrays with explicit `unit: "mil"`. Other PCB state/pad queries use mm. Preserve exact arcs and mechanical dimensions.

Choose the operation by the object and intent:

- `pcb_update_pad`: board pad override, preserving unspecified fields and library bindings. `pcb_create_pad`: standalone pad. Actual IDs come from context or `pcb_get_pads`; `pcb_resolve_pad_pair` maps reference/pin pairs without choosing paths.
- `pcb_create_copper` / `pcb_update_copper`: `kind: "fill"` for fixed conductive shapes, `kind: "pour"` for refillable boundaries. Fixed RF radiators are intentional copper, not placeholders for GND zones.
- `pcb_rebuild_pours`: official refill of selected boundaries. This does not route nets. Filled path units are uncalibrated; successful refill cannot establish connectivity, islands or returns.
- `pcb_update_outline_primitive`: selected line/arc/polyline. `pcb_replace_outline`: complete observed outline ID set, stage new contour before removing old. Follow partial edits with whole-contour review.
- `pcb_delete_objects`: explicit fixed fills, pours or standalone pads. Component pad deletion and locked objects are refused.

Apply narrow patches using unique operation IDs and fresh revisions. Read back requested and unchanged fields, DRC and images. Native edits may replace IDs while returning obsolete ones; use the tool's verified `data.primitive.id`. Ambiguous replacements remain partial. Rounding that changes requested dimensions is reported, not silently accepted.

Native `hole:null` modification can create an unintended default drill. Existing drill removal is blocked; a redundant null for an already undrilled pad is omitted. An undrilled pad's hole rotation/offset is non-applicable and listed as such; drilled pad orientation remains checked. Pour priority is explicitly preserved during unrelated edits.

Keep RF feed, radiator dimensions, pad nets, keepouts and curved outline under the actual design constraints. Do not delete unknown graphics to force a passing check, or reshape antennas using generic MCU placement/ground heuristics. Shape edits and DRC cannot establish gain, impedance or frequency response.

Use `eda_reopen_and_verify` for final persistence evidence, including original editable primitives, then inspect a fresh screenshot. It compares unknown pour data for persistence only, not electrical validity. If the tool is absent from a previously connected client, check the server version and reload the MCP connection before reverting to old capability claims.
