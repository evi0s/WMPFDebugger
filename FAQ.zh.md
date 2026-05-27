# 常见问题 (FAQ)

## 目录

1. [安装相关](#安装相关)
2. [版本兼容性](#版本兼容性)
3. [运行与连接问题](#运行与连接问题)

---

## 安装相关

> [!WARNING]
> 绝大多数安装问题都与网络和包管理器依赖相关，
> 请仔细阅读 README.zh.md 和已有 Issues。
> 
> 描述不清晰/没有日志/无效提问的 Issue 会被直接关闭！
> 
> [提问的智慧](https://github.com/ryanhanwu/How-To-Ask-Questions-The-Smart-Way/blob/main/README-zh_CN.md)

> [!CAUTION]
> **不要使用 NPM 包管理器！** 此项目使用 `yarn` 包管理器。
> 
> **不要删除 `yarn.lock`！** frida API 更新很快，需要锁依赖版本。

### Q: `yarn install` 卡 `Building fresh packages` 或需要安装 SDK 等相似问题

安装过程中需要下载 `frida` 的预编译二进制文件，由于网络原因可能非常慢或超时 (Issue #58)

**解决方案：** 使用代理加速下载（见下一条）

### Q: 安装依赖

`frida` 等依赖需要从国外服务器下载预编译文件

**解决方案：**

```bash
set HTTP_PROXY=<YOUR_PROXY_ADDR>
set HTTPS_PROXY=<YOUR_PROXY_ADDR>
set npm_config_fetch_retries=5
set npm_config_fetch_retry_msec_timeout=120000
yarn
```

请将 `<YOUR_PROXY_ADDR>` 替换为你自己的代理地址

本项目维护者不会对「如何使用代理」等类似网络/代理问题给出任何相关解决办法

### Q: 报错 `Cannot read properties of undefined (reading 'parameters')`

1. `frida` 版本不兼容，请使用 `yarn` 包管理器重新安装
2. 微信进程权限比 `node` 的执行权限高。将 `node` 提权执行或微信降权执行

---

## 版本兼容性

### Q: `Error: [frida] version config not found: XXXXX`

当前的 WMPF 版本尚未被本工具适配。每次微信更新可能会附带新版本的 WMPF 运行时。

**解决方案：**
- 查看 README 中的支持版本列表，确认当前版本是否已支持
- 如果未支持，可以在 GitHub 提交 Issue 请求适配
- 也可以参照 [ADAPTATION.md](ADAPTATION.md) 自行寻找偏移量进行适配

### Q: 如何检查我的 WMPF 版本

打开任务管理器，找到 `WeChatAppEx` 进程，右键点击「打开文件所在的位置」，查看路径中 `RadiumWMPF` 和 `extracted` 之间的数字即为版本号。

例如路径为：`%APPDATA%\Tencent\xwechat\xplugin\Plugins\RadiumWMPF\19871\extracted\runtime`，则版本号为 `19871`。

### Q: 如何更新到最新的 WMPF 版本

**微信 4.x 及以上：** 从官网 `pc.weixin.qq.com` 下载最新版微信，最新版 WMPF 会随安装包一同安装。

**微信 4.x 以下：** 在微信搜索框输入 `:showcmdwnd`（不要按回车触发搜索），弹出命令窗口后输入 `/plugin set_grayvalue=202&check_update_force` 并回车等待更新，重启微信生效。


---

## 运行与连接问题

### Q: 启动后小程序闪退怎么办？

小程序闪退可能有以下原因：

1. **WebSocket 帧错误**（`Invalid WebSocket frame: invalid opcode 0`）：不要使用全局代理 (例如 `yakit`, Issue #119)
2. **操作顺序错误**：必须先运行 `npx ts-node src/index.ts`，然后打开小程序，最后打开开发者工具。顺序不对可能导致闪退
3. **版本不匹配**：确保你的 WMPF 版本在支持列表中

**解决方案：**
- 严格按照 README 中的步骤顺序操作
- 确认 WMPF 版本已被适配
- 如果问题持续，尝试重启微信后再运行

---

## 调试问题

### Q: 打开 `devtools://devtools/bundled/inspector.html?ws=127.0.0.1:62000` 后页面空白

**可能原因及解决方案：**

1. **操作顺序错误**：确保先打开小程序，再打开此链接
2. **连接已断开**：检查终端中是否有报错信息，必要时重新从第二步开始

### Q: 启动成功但没有 Network 流量

检查小程序是否内嵌 WebView。WebView 为独立进程，不属于小程序进程，需要单独调试 (Issue #60)

### Q: 微信内置浏览器 / 公众号页面调试

基础支持已有，请参见 [EXTENSION.md](EXTENSION.md)。注意目前仅有基础调试功能，不如小程序调试完善


