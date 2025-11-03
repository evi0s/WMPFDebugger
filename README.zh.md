# WMPFDebugger

又一个 Windows 微信小程序调试工具

这个工具通过 patch 一些 Chrome 调试协议（CDP）的过滤器和其他的条件判断来强制小程序连接到外部调试器（也就是远程调试，LanDebug 模式）。这个调试协议是基于 protobuf 实现的私有协议，通过逆向开发者工具提取相应的协议实现，该工具实现了一个简单的小程序调试协议转换为标准 Chrome 调试协议，从而允许我们使用标准基于 chromium 浏览器的内嵌开发者工具来调试任意小程序


## 支持状态

支持的 WMPF 版本：

* 16815 (最新)
* 16771
* 16467 (credit @51-xinyu)
* 16389 (credit @liding58)
* 16203 (credit @liding58)
* 16133 (credit @liding58)

<details>

<summary>更早版本</summary>

* 14315 (credit @liding58)
* 14199
* 14161
* 13909
* 13871
* 13655
* 13639
* 13487
* 13341
* 13331
* 11633
* 11581 (成功连接但会随后渲染进程 crash，请自行测试)

</details>

如何调试微信内置浏览器页面：参见 [EXTENSION.md](EXTENSION.md)。注意，目前该方法仅有基础调试功能

如何检查版本：打开任务管理器，找到 WeChatAppEx 进程，右键，打开文件所在的位置，检查在 `RadiumWMPF` 和 `extracted` 之间的数字

如何适配到其他版本：参见 [ADAPTATION.md](ADAPTATION.md)。另外，你也可以提交版本适配的 Issue，我会尝试适配该版本如果我有相应的版本的 binary。仅更新版本的适配请求会被考虑

如何更新到最新的 WMPF 版本（微信版本 < 4.x）：搜索框输入 `:showcmdwnd`（不要按回车触发搜索）弹出命令窗口，输入 `/plugin set_grayvalue=202&check_update_force` 并回车等待更新（如果有新版本）。重启微信以生效。


## 准备

* node.js (已在 LTS v22 上测试)
    - yarn 包管理器
* 基于的 chromium 浏览器，例如 Chrome, Edge, 等等

## 使用

**第 1 步** 克隆并安装依赖

```bash
git clone https://github.com/evi0s/WMPFDebugger
cd WMPFDebugger
yarn
```

**第 2 步** 运行 `src/index.ts`。该命令会启动调试服务器和 CDP 代理服务器，同时相关 hook 代码也会被自动注入到小程序运行时中

```bash
npx ts-node src/index.ts
```

> 注意: 在这个步骤之后，你需要先启动小程序（第三步），再打开开发者工具（第四步）。如果操作顺序反了你可能需要从重新第二步开始

**第 3 步** 打开任意你想调试的小程序

**第 4 步** 打开浏览器，访问 `devtools://devtools/bundled/inspector.html?ws=127.0.0.1:62000` 即可。你也可以将 CDP 端口（在例子中为 62000）修改到任意其他端口。相关代码定义在 `src/index.ts` 中

## 截图

![Console in DevTools](screenshots/console.png)

![Sources in DevTools](screenshots/sources.png)

## 免责声明

**本库只能作为学习用途，造成的任何问题与本库开发者无关，如侵犯到你的权益，请联系删除**

该程序以 GPLv2 许可证开源，参考许可证第十一及十二条：

本程序为免费授权，故在适用法律范围内不提供品质担保。除非另作书面声明，版权持有人及其他程式提供者“概”不提供任何显式或隐式的品质担保，品质担保所指包括而不仅限于有经济价值和适合特定用途的保证。全部风险，如程序的质量和性能问题，皆由你承担。若程序出现缺陷，你将承担所有必要的修复和更正服务的费用

除非适用法律或书面协议要求，任何版权持有人或本程序按本协议可能存在的第三方修改和再发布者，都不对你的损失负有责任，包括由于使用或者不能使用本程序造成的任何一般的、特殊的、偶发的或重大的损失（包括而不仅限于数据丢失、数据失真、你或第三方的后续损失、其他程序无法与本程序协同运作），即使那些人声称会对此负责


此外，在 `src/third-party` 中，所有代码从微信开发者工具提取，因此腾讯控股有限公司拥有对该代码的所有版权


