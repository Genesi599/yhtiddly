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
- **数据库**：`{userData}/tiddlers.db`

`{userData}` 的具体路径：
- Windows: `%APPDATA%\tw-sync-desktop\`
- macOS: `~/Library/Application Support/tw-sync-desktop/`
- Linux: `~/.config/tw-sync-desktop/`

数据库可以直接用 SQLite 工具打开查看。

## 环境变量（覆盖配置文件）

```
REMOTE_URL          远程服务器（覆盖设置中的值）
LOCAL_PORT          本地端口
SYNC_INTERVAL       同步间隔（毫秒）
TW_USERNAME         远程用户名
TW_PASSWORD         远程密码
DB_PATH             数据库路径
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
├── db.js               SQLite 封装
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
