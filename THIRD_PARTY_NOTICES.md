# 来源与许可

| 项目 | 固定版本 | 使用方式 |
| --- | --- | --- |
| https://github.com/hyl64/jlcmcp | 5e53ddaa07e1763de6c1b17a82aafa2cb1476d4b | MIT；保留官方桥接客户端与脚本，重建 MCP 执行层 |
| https://github.com/mixelpixx/KiCAD-MCP-Server | aa53d52c2e37a13cb3574a6e0acf2c728b4d6bfb | MIT；借鉴引脚语义、验证闭环和测试方法，未复制后端代码 |
| https://github.com/TigerBruce/lceda-operation-notes | cc2719797f646e753242e96a1265b63a8f368b49 | 未发现许可证；仅吸收方法，独立编写规则，未复制文档或第三方 PDF |

JLC 原始 MIT 声明保留在 LICENSE。新增代码依同一 MIT 许可提供。保留的 scripts/bridge-server.mjs 原有来源注释不变；底层官方 Run API Gateway 由用户按其原许可安装。

KiCAD 原始 MIT 声明见 [docs/licenses/KiCAD-MCP-MIT.txt](docs/licenses/KiCAD-MCP-MIT.txt)，从上述固定提交核对。

KiCAD 的旧工具隐藏架构已撤回，本项目不以其旧宣传作为实现依据。新的工具注册、schema 检索和受校验调用独立实现。

0.2.0 补充复查 KiCAD-MCP-Server 的 `ac716d1a8bfad325b4aa93a398222645b3f78fd7`（2026-09-20 检查），保留上表首版来源版本。直接工具、语义端点和局部编辑设计为独立实现，未复制新的上游代码；分析与固定源码链接见 [研究记录](docs/KICAD-STUDY-2026-09.md)。EasyEDA API 签名另以官方 `@jlceda/pro-api-types@0.4.25` 对照；方法存在不代表行为验收通过。

运行依赖的许可证以各包内 LICENSE 为准；精确安装版本由 package-lock.json 锁定。Node.js 与 EDA 不包含在本项目内。
