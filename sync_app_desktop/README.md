# TW Sync Desktop

TiddlyWiki 桌面同步应用：本地 SQLite 缓存 + 后台与远程服务器双向同步。

## 架构

```
Electron 主进程
  ├── Express 本地服务器 (localhost:3000)
  │     ├── Tiddler REST API  →  SQLite 本地缓存
  │     └── 其他请求          →  代理到远程
  ├── BrowserWindow (加载 localhost:3000)
  ├── 后台同步 (每 15s 推脏/拉新)
  └── 系统托盘
```

浏览器访问 `localhost:3000`：
- HTML 骨架、插件 JS、图片 → 直接透传给远程服务器
- Tiddler 的 GET/PUT/DELETE → 本地 SQLite 响应，瞬时完成

后台定时把本地修改推送到远程，并拉取远程新变化。

## 首次使用

```bash
# 1. 安装依赖（自动触发 electron-rebuild 重编译 better-sqlite3）
npm install

# 2. 生成一个默认托盘图标（可选，不跑也能用内置的 fallback）
node gen-icon.js

# 3. 启动
npm start
```

首次启动会弹出设置窗口，填入：
- **远程服务器地址**：`https://yhtiddly.fun` 之类
- **用户名/密码**：如果服务器开了鉴权
- **本地端口**：默认 3000
- **同步间隔**：默认 15 秒

点"测试连接"确认能联通，点"保存"。
然后会出现一个进度窗口，从远程拉取全部 tiddler 到本地 SQLite（首次可能要几十秒到几分钟）。
完成后主窗口打开，显示的就是正常的 TiddlyWiki 界面 —— 但这次是本地响应，秒开。

## 日常使用

- **关闭主窗口** → 最小化到系统托盘，应用继续在后台同步
- **从托盘右键** → 打开主窗口 / 浏览器打开 / 立即同步 / 设置 / 退出
- 编辑 tiddler 后会立即存本地，15 秒内后台推送到远程
- 其他设备在远程更新的 tiddler，15 秒内会同步到本地

## 数据位置

- **配置**：`{userData}/config.json`
- **SQLite 索引 + HTTP 缓存**：`{userData}/tiddlers.db`
- **Tiddler 文件**：`{userData}/tiddlers/`（可在设置里改到任意目录）

`{userData}` 的具体路径：
- Windows: `%APPDATA%\tw-sync-desktop\`
- macOS: `~/Library/Application Support/tw-sync-desktop/`
- Linux: `~/.config/tw-sync-desktop/`

### 单文件存储

每条 tiddler 是目录下一个独立的 `.tid` 文件，格式就是 TiddlyWiki 原生的 `.tid`：

```
title: $:/config/Foo
modified: 20240101000000
tags: mytag [[tag with space]]
type: text/vnd.tiddlywiki

这里是正文内容。
```

文件名映射规则跟 TW 的 `--savewikifolder` 一致：`$:/foo/bar` → `$__foo_bar.tid`，普通 `/` → `_`，Windows 禁用字符 → `_`。

**为什么单文件**：

- 任何编辑器（VSCode、Obsidian、Notepad）都能直接打开改内容，保存后下次启动自动检测并同步推送到远程
- 写个脚本批量处理：`ls tiddlers/*.tid | xargs grep tag:`
- 让 AI 工具（Cursor、Copilot、Claude）直接读写这个目录——比 SQLite blob 友好一万倍
- 直接把这个目录当作 `tiddlywiki --load` 的输入，离线用原生 TW 也能跑

SQLite 只存索引（title → filename、revision、dirty 状态）和代理缓存，不是数据主存。

### 启动时 reconcile

每次启动会扫描一遍 tiddlers 目录：

- 新文件（用户手动添加的）→ 自动注册，标为 dirty，下次同步推送
- 已有文件但 `modified` 比索引新（用户改过了）→ 刷新索引，标为 dirty
- 索引有记录但文件消失 → 保守处理，只记日志不删（可能是用户误删，等你手动恢复）

## 环境变量（覆盖配置文件）

```
REMOTE_URL          远程服务器（覆盖设置中的值）
LOCAL_PORT          本地端口
SYNC_INTERVAL       同步间隔（毫秒）
TW_USERNAME         远程用户名
TW_PASSWORD         远程密码
DB_PATH             数据库路径
TIDDLERS_DIR        Tiddler 文件目录（覆盖默认的 userData/tiddlers）
```

## 打包分发

```bash
npm run build:win    # Windows .exe
npm run build:mac    # macOS .dmg
npm run build:linux  # Linux .AppImage
```

## 冲突解决

采用 **last-write-wins** 策略，以 tiddler 的 `modified` 字段（ISO 时间戳）为准：
- 本地较新 → 推送给远程
- 远程较新 → 拉取覆盖本地
- **本地有未推送的修改时**：保留本地版本（标记为 dirty，下次同步推送）

这意味着如果两端同时编辑同一条 tiddler，后推送的那个会覆盖先推送的。不追求完美冲突合并 —— 实际使用中冲突很少，手动解决即可。

## 常见问题

### better-sqlite3 编译失败

`npm install` 如果卡在 better-sqlite3 阶段，需要：
- Windows：装 Visual Studio Build Tools 或 `npm install --global windows-build-tools`
- macOS：装 Xcode Command Line Tools: `xcode-select --install`
- Linux：装 `build-essential python3`

然后：`npm run rebuild`

### 本地和远程数据出现分歧

如果本地缓存因为什么原因（比如断网很久后远程改了很多）出现奇怪状态：
1. 打开设置 → 点"清空本地缓存"
2. 重启应用
3. 会重新从远程全量拉取

### TiddlyWiki 插件依赖某些请求

某些插件可能访问 TW 内部的特殊路径，如 `$:/core/...`。这些都通过代理透传给远程，应该没问题。如果遇到问题看控制台日志。

## 文件结构

```
sync_app_desktop/
├── package.json        依赖 + 脚本
├── main.js             Electron 主进程
├── server.js           Express API 服务
├── db.js               SQLite 索引（title→filename + sync 状态）
├── tiddlerStore.js     单文件 .tid 存储（读写 + 文件名映射）
├── sync.js             后台同步逻辑
├── config.js           配置管理
├── preload.js          IPC 桥接
├── gen-icon.js         生成托盘图标
├── ui/
│   ├── settings.html   设置窗口
│   ├── loading.html    加载进度窗口
│   └── tray-icon.png   托盘图标（gen-icon.js 生成）
└── README.md
```

## v1 → v2 迁移

旧版把 tiddler 以 JSON blob 存在 SQLite `tiddlers.fields` 列里。v2 启动时会自动检测 v1 的 schema，把每行的 blob 写成 `.tid` 文件，再重建索引表。迁移是幂等的——第二次启动已经是 v2 schema，就不会重做。

如果迁移出了问题，删掉 `{userData}/tiddlers.db` 和 `{userData}/tiddlers/` 重新启动即可全量重拉。
