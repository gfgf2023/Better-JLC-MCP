# 兼容说明

`EASYEDA_COMPAT=1` 开启有限兼容，并非原版全部工具的无缝替代。

| 旧名称 | 新执行层 |
| --- | --- |
| pcb_bridge_status / pcb_list_eda_windows | eda_session |
| pcb_run_drc / sch_run_drc | eda_run_drc |
| pcb_screenshot | eda_screenshot |
| pcb_get_feature_support | eda_capabilities |
| pcb_route_track | pcb_apply_route，保留 mil 与 1/2 层号 |

原名称 `sch_get_state`、`pcb_get_state`、`pcb_net_connectivity_check` 等在新接口中仍存在，但新参数包含显式 target。写操作还需要 operationId；逐网写入还需要最新 revision。兼容适配拒绝无法解析到实际焊盘中心的端点。

pcb_auto_route_nets、pcb_auto_fanout_and_route、pcb_route_differential_pairs、pcb_auto_place_components、pcb_agent、pcb_execute_code 始终拒绝。实验模式仅提供独立的只读候选工具，不恢复旧自动布线实现。任意代码调试需单独开启。

旧目录 src/tools、src/codegen、legacy-jlc-bridge 为上游参考，不由 tsconfig 的入口导入。不要手动启动旧工具服务器。新入口为 src/index.ts 或 src/server.ts。

结果包含 status、target、changes、evidence、next；status 为 success、partial、failed 或 unknown。非 success 设置 MCP isError。读取检查成功表示已取得证据，仍需检查 data 内的 passed 字段。
