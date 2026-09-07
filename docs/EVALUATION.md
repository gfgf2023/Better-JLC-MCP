# 效果对照协议

尚未执行原版 JLC / 仅提示增强 / 融合版的三组对照。此次真实测试板由当前模型逐网给出明确路径，只能证明接口闭环可运行，不能证明模型任务完成率优于原版。

每个任务使用相同模型、相同初始工程 SHA-256 和调用预算；每组重复三次，分别记录完成率、误报成功、自动布线误选和实际执行次数、未解释 DRC、工具调用数和耗时。原版与提示增强组也必须保留原始调用与 EDA 证据。重试、人工确认、上下文重置必须计入实验记录。

`src/evaluation.ts` 定义严格记录 schema。`npm run evaluate -- <记录文件>` 检查缺组、重复轮次、模型/工程/预算不一致和超出预算，再输出描述性汇总。空记录显式返回 not_run；汇总器不会自动宣称优越。

```json
{
  "task": "mcu-sensor-two-layer",
  "variant": "fusion",
  "repeat": 1,
  "model": "实际完整模型标识",
  "initialProjectHash": "64位十六进制工程哈希",
  "callBudget": 100,
  "completed": false,
  "falseSuccesses": 0,
  "autorouteSelections": 0,
  "autorouteExecutions": 0,
  "unexplainedDrc": 0,
  "calls": 0,
  "elapsedSeconds": 0,
  "evidence": ["本地证据文件路径"]
}
```

上例仅解释字段，不是有效实验记录。公开报告需脱敏；原始工程、调用输出与私有 UUID 留在 reports/private。
