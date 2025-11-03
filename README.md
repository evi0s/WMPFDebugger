# WMPFDebugger

[English](README.md) | [中文](README.zh.md)

Yet another WeChat miniapp debugger on Windows (WMPF).

This debugger (tweak) exploits Remote Debug feature provided by wechatdevtools and patches serval restrictions to force miniapp runtime to support full Chrome Debug Protocol, and thus can be directly applied to standard devtools shipped with chromium-based browsers.


## Support Status


Version histories:

* 16815 (latest)
* 16771
* 16467 (credit @51-xinyu)
* 16389 (credit @liding58)
* 16203 (credit @liding58)
* 16133 (credit @liding58)

<details>

<summary>Older versions</summary>

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
* 11581 (unstable, will connect but crash renderer, feel free to test)

</details>

To debug web pages of WeChat embedded browser, please refer to [EXTENSION.md](EXTENSION.md). Note that this feature has many limitations currently and is simply a basic workaround.

To check your installed version, navigate to Task Manager -> WeChatAppEx -> Right click -> Open file location -> Check the number between `RadiumWMPF` and `extracted`.

To adapt to another version, please find the instructions in [ADAPTATION.md](ADAPTATION.md). Alternatively, you can submit an issue for new version adaption and I will try that if I have the binary. Note that only newer version adaption requests will be considered.


To upgrade to the latest WMPF (WeChat version < 4.x), type in `:showcmdwnd` in the search bar (do not hit enter), then the command window should pop up. Type in `/plugin set_grayvalue=202&check_update_force` and hit enter, the latest WMPF plugin should be downloaded, if any updates are available. Restart the WeChat to apply plugin upgrade.

## Prerequisites

* node.js (tested on LTS v22)
    - yarn
* chromium-based browsers (e.g., Chrome, Edge, etc.)

## Quick Start

**Step 1.** Clone this repo and install dependencies.

```bash
git clone https://github.com/evi0s/WMPFDebugger
cd WMPFDebugger
yarn
```

**Step 2.** Run `src/index.ts` to launch debug server and proxy server, and inject hook script to miniapp runtime.

```bash
npx ts-node src/index.ts
```

> Note: After this step, you need to launch the miniapp BEFORE launching the devtools, otherwise you will probably need to kill the server and redo the steps 2 to 4 again.

**Step 3.** Launch any miniapp you would like to debug.

**Step 4.** Open your chromium-based browsers, navigate to `devtools://devtools/bundled/inspector.html?ws=127.0.0.1:62000` and profit. You can change the CDP port `CDP_PORT` (62000 in this example) in `src/index.ts` to any port you like.

## Screenshots

![Console in DevTools](screenshots/console.png)

![Sources in DevTools](screenshots/sources.png)

## Disclaimer

BECAUSE THE PROGRAM IS LICENSED FREE OF CHARGE, THERE IS NO WARRANTY FOR THE PROGRAM, TO THE EXTENT PERMITTED BY APPLICABLE LAW.  EXCEPT WHEN OTHERWISE STATED IN WRITING THE COPYRIGHT HOLDERS AND/OR OTHER PARTIES PROVIDE THE PROGRAM "AS IS" WITHOUT WARRANTY OF ANY KIND, EITHER EXPRESSED OR IMPLIED, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE.  THE ENTIRE RISK AS TO THE QUALITY AND PERFORMANCE OF THE PROGRAM IS WITH YOU.  SHOULD THE PROGRAM PROVE DEFECTIVE, YOU ASSUME THE COST OF ALL NECESSARY SERVICING, REPAIR OR CORRECTION.

IN NO EVENT UNLESS REQUIRED BY APPLICABLE LAW OR AGREED TO IN WRITING WILL ANY COPYRIGHT HOLDER, OR ANY OTHER PARTY WHO MAY MODIFY AND/OR REDISTRIBUTE THE PROGRAM AS PERMITTED ABOVE, BE LIABLE TO YOU FOR DAMAGES, INCLUDING ANY GENERAL, SPECIAL, INCIDENTAL OR CONSEQUENTIAL DAMAGES ARISING OUT OF THE USE OR INABILITY TO USE THE PROGRAM (INCLUDING BUT NOT LIMITED TO LOSS OF DATA OR DATA BEING RENDERED INACCURATE OR LOSSES SUSTAINED BY YOU OR THIRD PARTIES OR A FAILURE OF THE PROGRAM TO OPERATE WITH ANY OTHER PROGRAMS), EVEN IF SUCH HOLDER OR OTHER PARTY HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

The code in the `src/third-party` is extracted from `wechatdevtools` and fully copyrighted by Tencent Holdings Ltd.


