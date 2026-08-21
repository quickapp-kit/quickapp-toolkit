# QuickApp Toolkit

[QuickApp Kit](https://github.com/quickapp-kit) 的 CLI 与构建工具链。负责工作区解析、编译、静态分析和运行时调用。

## 功能

```
quickapp build    → 编译 .ux → Page IR → RPK 包
quickapp inspect  → 静态分析、依赖图、诊断
quickapp run      → 在本地 Runtime 中启动 RPK
```

当前已实现（TK-S01）：
- CLI 命令注册（`build`、`inspect`、`run`）
- 工作区发现与 `quickapp.config.json` 解析
- 有界 `SourceAccess`，路径收敛与变更检测
- 编译器前端：UX/模板/样式/脚本解析 → Page IR 模型
- 结构化 Result/Diagnostic 输出（人类可读 + JSON）、退出码、取消机制
- 构建观测标记

尚未实现：
- 完整 Bundle 生成、运行时产物打包
- `inspect` / `run` 业务逻辑
- MCP 集成、运行时追踪

## 环境要求

- Node.js >= 22
- npm

## 使用

```bash
npm install
npm run build
node dist/cli/bin.js --help
```

## 开发

```bash
npm run typecheck    # 类型检查
npm run lint         # 边界检查
npm test             # 全部测试
npm run test:cli     # CLI 集成测试
```

## 目录结构

```
├── src/
│   ├── cli/            # CLI 入口、命令分发
│   ├── application/    # 应用服务层
│   ├── compiler/       # UX → Page IR 编译器
│   ├── workspace/      # 工作区发现、配置解析
│   ├── diagnostics/    # 结构化错误与警告
│   ├── observation/    # 构建标记、观测端口
│   └── types/          # 共享类型定义
├── test/               # 单元 + 集成测试
├── scripts/            # 构建和检查脚本
└── evidence/           # TK-S01 验证
```

## 相关仓库

- [quickapp-runtime-core](https://github.com/quickapp-kit/quickapp-runtime-core) — C++ 运行时内核
- [quickapp-runtime-lvgl](https://github.com/quickapp-kit/quickapp-runtime-lvgl) — LVGL 适配层
- [quickapp-runtime-android](https://github.com/quickapp-kit/quickapp-runtime-android) — Android 适配层

## 许可证

[MIT](LICENSE)
