# KiCAD MCP 工作模式复查与改进依据

检查日期：2026-09-20。参考仓库固定于 [`ac716d1a8bfad325b4aa93a398222645b3f78fd7`](https://github.com/mixelpixx/KiCAD-MCP-Server/tree/ac716d1a8bfad325b4aa93a398222645b3f78fd7)。本次读取源码、测试和文档；没有在同一模型/预算下运行效果对照，因此以下是能力和机制分析，不是胜率结论。实现为独立编写，没有移植其 Python 后端或自动路由算法。

## 先解释实际受阻原因

Better-JLC-MCP 0.1.0 的三处缺口是实现限制：

- 没有固定填充、覆铜边框和焊盘的公开编辑接口。
- `pcb_create_outline` 只处理空白板框；旧读取器仅拼接直线图元，读不到由折线和圆弧组成的已有板框。
- 读取器把所有 Fill、Pour、Region、Polyline 都记为 unknown，检查器随后阻止布线。安全判定本身不应取消，应补齐对象表示和独立编辑能力。

实际只读检查的 1300 MHz 对数周期天线板有 7 个焊盘、0 段普通铜线。新读取器解析出 10 个板框折线对象（含圆弧）、2 个固定铜形状及 1 个禁止走线区域。它不是适合用普通 MCU“铺地＋逐网连线”模板处理的例子：固定铜形状本身就是射频结构。支持修改图形也不代表支持天线电磁性能验收。

## KiCAD 的有效工作模式

| 模式 | 具体工具/实现 | 改善模型工作的原因 | 本项目采取的方式 |
| --- | --- | --- | --- |
| 直接暴露带类型工具 | `src/tools/router.ts`、`docs/ROUTER_ARCHITECTURE.md` | 避免额外调用通用入口时猜错嵌套参数；检索仅辅助发现 | 默认暴露所有启用工具；`EASYEDA_TOOL_MODE=compact` 保留精简模式，受控调用入口仍保留 |
| 以真实语义对象作为操作端点 | `get_pads`、`get_net_pads`、`get_pad_position`、`get_symbol_pins`、`connect_to_net` | 模型不用手算封装旋转后的引脚位置，也不靠截图猜坐标 | 新增 `pcb_get_pads`、`pcb_resolve_pad_pair`；路径顶点和过孔仍由模型明确指定 |
| 小改动可以完成闭环 | `list_graphics`、`update_graphic`、`replace_board_outline`、`query_traces`、`modify_trace`、`query_zones`、`refill_zones` | 模型能修已有设计，不必从空白开始，也无需用任意代码补洞 | 新增板框局部编辑/替换、固定铜/覆铜增改删、焊盘增改及官方重铺接口 |
| 批量构建子电路 | `batch_add_components`、`batch_connect`、`batch_add_and_connect`、`batch_set_schematic_property_positions` | 减少往返和多次文件读写；统一处理标签方向、栅格和文本位置 | 下一阶段重点；现有原理图接口仍逐项操作，不声称已具备同等批量性能 |
| 把不同布局问题分开反馈 | `get_component_geometry`、`check_placement_clearance`、`check_courtyard_overlaps` | 区分器件本体、焊盘、courtyard、丝印、文本的冲突，不拿原点距离代替实际间距 | 本次补齐铜与板框实际几何；完整 courtyard/body/text 分类还未实现 |
| 先建议，后应用 | `suggest_placement` 的 `apply=false` 默认行为；`hierarchical_place` | 可锁定连接器/RF器件，查看线长与重叠变化，再决定是否接受 | 保留模型布局；拟增加约束驱动布局评估，不复制对当前天线不适用的弹簧布局 |
| 视觉与机械、电气证据并行 | `get_board_2d_view`、`get_schematic_view`、`snapshot_project`、ERC/DRC | 模型可以看到文本/空间问题，配合电气检查修正 | 已有原生图片、网表、保存重开；阶段规则补充编辑对象和 RF 特殊流程 |
| 丰富的回归反例 | pin 世界坐标、label 朝向、保留导线移动、netclass 持久化、PCB/SCH 同步测试 | 防止接口“调用成功”但破坏语义；真实 pcbnew 测试有单独开关 | 新增生成代码执行测试、静默修改失败、板框替换失败、曲线/孔洞/孤岛反例 |

### 工具隐藏机制的真实状态

上游 [`router.ts`](https://github.com/mixelpixx/KiCAD-MCP-Server/blob/ac716d1a8bfad325b4aa93a398222645b3f78fd7/src/tools/router.ts) 明确写明：间接执行导致模型幻觉参数，gating 在 `3d9497e` 撤回，`execute_tool` 在 `963a39c` 删除。所有工具直接注册。其 [工具清单](https://github.com/mixelpixx/KiCAD-MCP-Server/blob/ac716d1a8bfad325b4aa93a398222645b3f78fd7/docs/TOOL_INVENTORY.md) 声明 233 个注册工具、173 个被检索索引覆盖、60 个未索引；这是仓库清单数字，不是本次运行时测量。

本项目不再把“隐藏更多工具”作为默认优化。直接 schema 更易调用是否优于精简模式，仍要用同一模型实测；两种模式在执行策略上完全一致。

### 不应照搬的部分

1. [`route_pad_to_pad`](https://github.com/mixelpixx/KiCAD-MCP-Server/blob/ac716d1a8bfad325b4aa93a398222645b3f78fd7/python/commands/routing.py) 自动查引脚是优点，但同层默认调用直线 `route_trace`；异层由固定启发式选过孔点，而且成功判断没有包含 `add_via` 返回值。这不是完整避障或连通证据。本项目只迁移语义端点解析。
2. [`replace_board_outline`](https://github.com/mixelpixx/KiCAD-MCP-Server/blob/ac716d1a8bfad325b4aa93a398222645b3f78fd7/python/commands/board/outline.py) 先清除旧板框再创建新板框。本项目先校验新轮廓、创建并读回，再删除显式选中的旧对象；部分失败仍可能留下两个轮廓，必须报告恢复证据，不宣称事务回滚。
3. [`routing.ts` 提示模板](https://github.com/mixelpixx/KiCAD-MCP-Server/blob/ac716d1a8bfad325b4aa93a398222645b3f78fd7/src/prompts/routing.ts) 有通用地分割建议，回调也保留 `{{board_info}}` 文字而未插入实参。不能将其归因为“提示词一定更好”；本项目按实际约束注入阶段提示，不把地分割固化为规则。
4. 自动布线/Freerouting 是上游的一条可选工作流，不是本项目默认路线。重铺铜是原生覆铜计算，和自动全网布线是不同操作。默认禁用全网路由、差分自动路径和任意代码的执行策略继续有效。
5. 本次源码检索发现了完善的焊盘查询与封装操作，但没有通用 `update_pad` 或 `edit_pad` 工具；本项目新增焊盘编辑是针对用户缺口的独立扩展，不能标成复制了上游已有功能。
6. [`test_real_pcbnew_matrix.py`](https://github.com/mixelpixx/KiCAD-MCP-Server/blob/ac716d1a8bfad325b4aa93a398222645b3f78fd7/tests/test_real_pcbnew_matrix.py) 依赖显式启用真实后端。测试文件多不等于本次版本已在全部系统完成真实验收。

## 接下来优先补的能力

1. **真实重铺铜结果标定**：本机读到的 PourFills.path 与边框数据约有 10 倍尺度差异。在没有版本化实测前，禁止自动乘 10 后宣称连通；还需验证负片/孔洞、热焊、孤岛和刷新时机。
2. **原理图批量事务与视觉 lint**：组件/连网/文本为单个可读计划，执行部分失败保留精确操作记录。引脚栅格与 label 文本检查以实际 EDA 坐标为准。
3. **完整布局对象几何与 DRC 差异**：真实焊盘到焊盘距离、器件本体/courtyard、锁定 RF/连接器，以及新旧 DRC 的增加/消除；不用单一分数掩盖结构问题。
4. **设计规则语义化**：线宽、孔径、净距按网类持久化并读回，再用于上下文提示与检查。
5. **同模型对照**：原版 JLC、仅提示增强、当前版，以相同初始工程和预算各重复三次。加入“修改已有非矩形 RF 铜图形”任务，但天线指标需另有仿真或实测判据；目前未运行。

## 补充源码入口

- [批量原理图实现](https://github.com/mixelpixx/KiCAD-MCP-Server/blob/ac716d1a8bfad325b4aa93a398222645b3f78fd7/python/commands/schematic_batch.py)
- [器件几何与分类冲突](https://github.com/mixelpixx/KiCAD-MCP-Server/blob/ac716d1a8bfad325b4aa93a398222645b3f78fd7/python/commands/component.py)
- [建议布局实现](https://github.com/mixelpixx/KiCAD-MCP-Server/blob/ac716d1a8bfad325b4aa93a398222645b3f78fd7/python/commands/placement_optimizer.py)
- [视觉反馈与 IPC/SWIG 区别](https://github.com/mixelpixx/KiCAD-MCP-Server/blob/ac716d1a8bfad325b4aa93a398222645b3f78fd7/docs/VISUAL_FEEDBACK.md)
