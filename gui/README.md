# Tutor GUI

使用 CQU Moe Design theme/UI 1.1.0、Lucide 1.48.0。界面通过设计系统官方生成器建立，组件从 `@cqu-moe/ui` 导入，设计包保存在 `.design/`。

```sh
cd ..
bun install --frozen-lockfile
bun run --filter @cqu-moe/tutor-gui build
bun run check:design
bun run gui
```

GUI 由 Tutor 的本地服务提供。开发和完整操作说明见 [docs/gui.md](../docs/gui.md)。重新构建界面后重启 Tutor。
