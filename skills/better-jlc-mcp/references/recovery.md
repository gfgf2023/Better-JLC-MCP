# Recovery And Versioned Observations

For a timeout, disconnect, HTTP 500 or partial result, load `eda_workflow` stage `recovery`. Preserve the exact operation ID, input, target and returned changes. Read the local operation evidence and actual schematic/PCB before any corrective write. Automatic backup is not proof that a failed mutation was undone.

- If the intended change exists and verifies, continue from that state; do not submit it under a fresh ID.
- If only part exists, identify what actually changed and correct only the remaining or incorrect part with a fresh ID.
- If state remains unknown, pause dependent writes and report the specific missing observation. Never interpret elapsed time as evidence of failure or success.
- Use a schema-discovered recovery tool only for identified objects owned by the source operation. `sch_remove_created_objects` requires `sourceOperationId` and explicit primitive IDs. Do not assume arbitrary document undo or a PCB deletion capability exists.
- Review ownership when EDA merges copper: the new returned ID can disappear while its physical path remains. A merged primitive may contain earlier work and must not be deleted as if it belongs solely to the latest operation.
- Full backup restoration requires a deliberately selected recovery procedure that accounts for edits since the backup. Do not overwrite an entire document as a routine single-operation rollback.

## Recorded Evidence, Not Universal Rules

The following observations came from the project's 2026-09-07 validation on EasyEDA 3.2.149 and MCP 0.1.0. Recheck behavior on other versions. Source: `reports/VALIDATION.md` and `reports/live-design.json` in Better-JLC-MCP commit `5b9e0dc0d35cd56958a3d73b6236fb3b14f5638f`.

| Observation | Appropriate response |
| --- | --- |
| Local-mode createProject failed. | Inspect for partial project creation; use a user-selected test project if creation remains unavailable. Do not assume an arbitrary empty project is disposable. |
| importChanges returned true before components appeared. | Inspect pending UI confirmation and then read actual references/pad nets before routing. |
| Wire creation succeeded before a later pin read failed. | Read the real netlist and skip already completed connections. |
| Via diameter/drill were rounded to native mil increments. | Compare actual sizes. 0.6096/0.3048 mm worked in that test; these are not universal design defaults. |
| EDA merged track IDs. | Verify physical path coverage, layer and net as well as object identifiers. |
| Save/reopen rounded some coordinates by about 0.000001 mm. | The adapter uses a 0.00001 numeric tolerance while retaining structure/net/layer comparisons. Do not increase tolerances to hide meaningful changes. |
| Schematic font-size behavior differed from ordinary typography. | Use the editor default font and supported attribute layout tools, then inspect images. |
| Native schematic DRC returned one warning category without detail. | Retain the warning as unresolved; lack of visible errors does not erase the API result. |
