# EasyEDA MCP

面向客户端大模型的嘉立创EDA设计工具。使用官方 Run API Gateway；由模型选择器件、布局并提交明确的逐网路径，服务端负责参数校验、目标绑定、备份、几何检查和读回。无需 Anthropic API Key。

当前为 0.2.0 工程验证版，新增已有 PCB 铜皮、焊盘和板框编辑。见 [编辑指南](docs/PCB-EDITING.md)、[真实编辑验收](reports/PCB-EDITING-VALIDATION.md)及[首版设计测试报告](reports/VALIDATION.md)。尚未完成三组效果对照，不能宣称优于原版。

## 启动

需要 Node.js 22 或更新版本、嘉立创EDA专业版和官方 Run API Gateway 扩展。

```sh
npm ci
npm run build
npm test
npm run start:bridge
```

在嘉立创EDA扩展中连接 Gateway，然后通过 MCP 客户端启动 `node <项目绝对路径>/dist/server.js`。MCP 使用标准输入输出；日志写入 stderr。客户端示例见 [examples](examples)。

先调用 `eda_session`，随后调用 `eda_workflow` 的对应阶段。所有设计操作携带返回的 target；写入同时需要唯一 operationId。默认直接暴露所有启用工具的完整参数；`eda_find_tools`、`eda_tool_schema` 辅助发现。客户端工具预算有限时可设置 `EASYEDA_TOOL_MODE=compact`，再通过 `eda_invoke` 受校验调用；两种模式共用执行策略。

## 配套 Skill

仓库包含可本地安装的 [better-jlc-mcp skill](skills/better-jlc-mcp/SKILL.md)，提供按阶段加载的原理图、布局、模型逐网布线、验证及故障恢复指导。

在仓库根目录执行以下 PowerShell 命令可安装到 Codex 技能目录。已有同名技能时停止，先比较本地定制内容再更新。

```powershell
$skillRoot = if ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME 'skills' } else { Join-Path $env:USERPROFILE '.codex/skills' }
$skillTarget = Join-Path $skillRoot 'better-jlc-mcp'
if (Test-Path -LiteralPath $skillTarget) { throw 'Skill already exists; compare before updating.' }
New-Item -ItemType Directory -Path $skillRoot -Force | Out-Null
Copy-Item -LiteralPath './skills/better-jlc-mcp' -Destination $skillTarget -Recurse
```

调用示例：`$better-jlc-mcp 检查当前工程，继续原理图与 PCB 设计`。Skill 支持自动匹配，也可显式调用；它提供操作指导，MCP 服务与官方桥接仍需按上方说明配置。安装后若当前会话未列出技能，请在新会话中使用。

## 设计闭环

1. 官方器件库搜索、读取实际符号与绑定，按位号和引脚号连接；网络端口通过导线连接，不能仅重叠端点。
2. 导出真实网表并检查预期连接；保留 DRC 的布尔值或分类计数，不伪造错误明细。
3. 官方 importChanges 同步到 PCB，读回封装、焊盘网络和坐标。
4. 模型明确安排器件位置，读取 `pcb_get_routing_context`，调用 `pcb_check_route`、`pcb_apply_route` 提交实际路径。
5. 每批操作后检查真实几何、连通分量、DRC 和截图，保存证据。

修改已有 PCB 时加载 `eda_workflow: pcb_editing`，读取 `pcb_get_edit_context` 的编辑 revision。用 `pcb_update_pad` 修改板上焊盘，`pcb_create_copper` / `pcb_update_copper` 编辑固定铜或覆铜边框，`pcb_update_outline_primitive` 局部修改板框，或 `pcb_replace_outline` 替换完整轮廓。`pcb_rebuild_pours` 是官方重铺铜，不是自动布线。RF 铜形状是电路结构，不套用普通 MCU 铺地模板。

默认单位为 mm，可显式指定 mil；PCB 原生单位为 mil，原理图为 10mil。层名称使用 top/bottom。

## 策略与限制

默认执行层拒绝全网自动布线、自动差分布线和组合流水线，兼容入口也不能绕过。`EASYEDA_EXPERIMENTAL_ROUTING=1` 仅开放经校验的单网候选路径查询，不自动落线。任意代码默认关闭；`EASYEDA_ALLOW_RAW_CODE=1` 是独立调试开关，启用后不再具有禁止自动布线的保证。

几何支持双面铜线、常用焊盘、通孔过孔、曲线板框、顶底层实心固定铜的孔洞/孤岛及明确禁止走线区域。可编辑并重铺 Pour，但真实填充路径单位尚未可靠标定；内层、部分特殊图元和未知几何仍阻止完整路由验证。支持编辑不等于完整电气验收；不编辑封装库，不包含 KiCAD 后端或全板路由器。

深入复查 KiCAD 当前源码后的工作模式、可借鉴工具及未完成项见 [研究记录](docs/KICAD-STUDY-2026-09.md)。本次采用直接类型工具、语义端点定位和局部编辑闭环；批量原理图、courtyard/文本分类检查及规则持久化仍待实现。

操作记录、文档备份、工程备份与截图存放于 `.easyeda-mcp/`，不应公开。超时后读回并返回 unknown，禁止盲目重试；回退仅删除该操作明确创建的指定图元。连接成功、API 返回 true、存在一段走线均不能代替设计验收。

设置 `EASYEDA_COMPAT=1` 开启有限旧名称适配，详见 [兼容说明](docs/COMPATIBILITY.md)。旧 JLC 源文件作为来源参考保留，新入口仅构建新的执行层；旧 Agent 已移除。

交付 ZIP 仅包含新执行层和官方桥接，不包含工作区中的旧参考目录。所有客户端应将 EASYEDA_STATE_DIR 设置为同一个绝对路径，以共享操作记录和跨进程窗口锁。更多说明见 [架构](docs/ARCHITECTURE.md)。

来源版本、许可及独立实现说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
