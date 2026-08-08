# FileVisualizer 文件结构可视化工具

一个运行在 Windows 上的轻量级桌面工具。把本地文件夹拖进画布，程序会递归扫描目录，并把文件、文件夹和大小关系显示成一张可以缩放和平移的树形图。

## 功能

- 拖入文件夹、文件，或通过“选择文件夹”按钮加载目录
- 把文件或文件夹拖到 exe 图标上直接打开
- 树形画布支持平移、缩放、小地图和适应画布
- 节点卡片显示名称、大小、占比、子项数量和修改时间
- 文件夹展开时只显示直接子层，收起时会折叠整棵子树
- 支持收起全部、收起一层、展开一级、默认层级
- 搜索覆盖全部已扫描节点，未展开的深层结果也会自动展开并定位
- 支持打开、打开所在位置、重命名、复制到、移动到、删除（回收站）、新建文件或文件夹
- 扫描缓存使用紧凑二进制格式，二次打开同一目录更快
- 空画布提供“示例文件展示”，可载入 10 万节点示例树
- 常驻系统托盘，支持全局快捷键和单实例运行

## 技术栈

- Tauri 2
- Rust
- React 19 + TypeScript
- Vite
- React Flow 12
- Zustand 5
- pnpm

## 项目结构

```text
File visualization/
├── src/                          # React 前端
│   ├── components/
│   │   ├── FileNode.tsx          # 节点卡片
│   │   ├── FlowCanvas.tsx        # React Flow 画布
│   │   └── SmoothEdge.tsx        # 自定义连线动画
│   ├── App.tsx                   # 主界面
│   ├── store.ts                  # Zustand 状态管理
│   ├── layout.ts                 # 树形布局计算
│   ├── types.ts                  # 公共类型
│   ├── format.ts                 # 大小、时间格式化
│   ├── fileTypes.ts              # 新建文件类型清单
│   ├── styles.css                # 全局样式
│   └── main.tsx                  # 前端入口
├── src-tauri/                    # Rust 后端
│   ├── src/
│   │   ├── lib.rs                # Tauri 命令、托盘、快捷键
│   │   ├── scan.rs               # 目录扫描、缓存、排序
│   │   └── main.rs               # 后端入口
│   ├── capabilities/default.json # 权限配置
│   ├── icons/                    # 应用图标
│   ├── Cargo.toml                # Rust 依赖
│   └── tauri.conf.json           # Tauri 窗口和打包配置
├── scripts/
│   └── test-store-collapse.cjs   # 展开/收起状态回归测试
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── vite.config.ts
├── README.md
├── 需求文档.md
├── 操作手册.md
├── 工作交接文档.md
└── 优化点总结.md
```

主要模块说明：

- `src/App.tsx` 负责主界面、事件监听、搜索、设置和右键菜单。
- `src/store.ts` 保存扫描结果、展开状态、动画状态和设置。
- `src/layout.ts` 把树形节点转换成画布坐标。
- `src/components/FlowCanvas.tsx` 负责画布渲染、视口裁剪和节点复用。
- `src-tauri/src/scan.rs` 负责目录扫描、totalSize 汇总、排序和缓存读写。
- `src-tauri/src/lib.rs` 负责注册 Tauri 命令、托盘、全局快捷键和 Windows 右键菜单。
- `scripts/test-store-collapse.cjs` 是前端状态逻辑的自动化回归测试。

`node_modules`、`dist`、`src-tauri/target`、`.toolchain` 和 `.pnpm-store` 属于构建产物或本地环境，不会提交到 Git。

## 使用

安装后程序会常驻托盘。关闭窗口只会隐藏程序，不会退出。

全局快捷键：同时按下 `Z + X + C`，可以显示或隐藏主窗口。

首次使用：

1. 把文件夹拖到画布中央，或点击顶部“选择文件夹”
2. 等待扫描完成
3. 点击文件夹卡片右侧的展开按钮查看子层
4. 在搜索框输入名称，可以查找并定位深层节点

节点操作：

- 双击节点：用系统默认程序打开
- `Enter`：打开当前选中的节点
- `F2`：重命名当前选中的节点
- `Delete`：把当前选中的节点移入回收站
- 右键节点：打开新建、重命名、复制、移动、删除等菜单

## 构建

环境要求：Node.js、pnpm、Rust stable、Windows MSVC 工具链、WebView2 Runtime。

```bash
# 安装前端依赖
pnpm install

# 开发模式
pnpm tauri dev

# 前端类型检查和构建
pnpm build

# Rust 测试
cargo test

# 编译 release 可执行文件
pnpm tauri build --no-bundle

# 生成 NSIS 和 MSI 安装包
pnpm tauri build
```

## 文档

- `需求文档.md`：产品需求与验收标准
- `操作手册.md`：面向新用户的完整操作指南
- `工作交接文档.md`：项目进度与交接说明
- `优化点总结.md`：历次优化记录

## 隐私

所有扫描、大小计算和文件操作都在本机完成。程序不会上传文件路径、文件名或目录内容。

## 版本

当前版本：v1.0.0
