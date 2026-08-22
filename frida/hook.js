const getPlatform = () => {
    // retval: "windows" | "linux" | "darwin"
    return Process.platform;
}

const isArmDarwin = () => {
    return Process.platform === "darwin" && Process.arch === "arm64";
}

const getMainModule = (version) => {
    const osPlatform = getPlatform();
    if (osPlatform === 'windows') {
        if (version >= 13331) {
            return Process.findModuleByName("flue.dll");
        }
        return Process.findModuleByName("WeChatAppEx.exe");
    } else if (osPlatform === 'linux') {
        return Process.findModuleByName("WeChatAppEx");
    } else if (osPlatform === 'darwin') {
        return Process.findModuleByName("WeChatAppEx Framework");
    }
};

const patchCDPFilter = (base, config) => {
    if (config.CastToJsonOffset) {
        const castToJson = new NativeFunction(
            base.add(config.CastToJsonOffset),
            "pointer",
            ["pointer", "pointer", "pointer"]
        );
        const callback = new NativeCallback(function (out, thiz, data, len) {
            castToJson(out, data, len)
            return out
        }, "pointer", ["pointer", "pointer", "pointer", "pointer"]);
        Interceptor.replace(base.add(config.CDPFilterHookOffset), callback);
        return;
    }
    // xref: SendToClientFilter OR devtools_message_filter_applet_webview.cc
    const offset = config.CDPFilterHookOffset;
    Interceptor.attach(base.add(offset), {
        onEnter(args) {
            if (!isArmDarwin()) {
                // x64 windows/linux: save args[0] for use in onLeave
                send(
                    `[patch] CDP filter on enter, original value of input: ${args[0].readPointer()}`,
                );
                this.inputValue = args[0];
            }
        },
        onLeave(retval) {
            if (!isArmDarwin()) {
                // x64 windows/linux
                const inputValue = this.inputValue.readPointer();
                if (inputValue.isNull() || inputValue.add(8).isNull()) {
                    // there's a chance the value could be null
                    // return here to avoid crash
                    return;
                }

                send(
                    `[patch] CDP filter on leave, patch input, now value: ${inputValue}; ` +
                        `*(input + 8) = ${inputValue.add(8).readU32()}`,
                );
                if (inputValue.add(8).readU32() == 6) {
                    inputValue.add(8).writeU32(0x0);
                }
            } else {
                // arm64 darwin, caller checks retval+8 == 6, patch it to 0
                if (retval.isNull()) return;
                try {
                    const val = retval.add(8).readU32();
                    send(`[patch] CDP filter on leave (mac), retval+8 = ${val}`);
                    if (val === 6) {
                        retval.add(8).writeU32(0x0);
                        send("[patch] CDP filter patched (mac)");
                    }
                } catch (e) {
                    send(`[patch] CDP filter error: ${e}`);
                }
            }
        },
    });
};

const hookOnLoadScene = (a1, sceneOffsets) => {
    const miniappConfigPtr = a1
        .add(sceneOffsets[0])
        .readPointer()
        .add(sceneOffsets[1])
        .readPointer();
    const miniappScenePtr = miniappConfigPtr
        .add(sceneOffsets[2])
        .readPointer()
        .add(sceneOffsets[3])
        .readPointer()
        .add(sceneOffsets[4])
        .readPointer()
        .add(sceneOffsets[5]);
    send(`[hook] scene: ${miniappScenePtr.readInt()}`);

    // 1000: from issue #83 <-- will crash the process
    // 1007: from issue #80
    // 1008: from issue #53
    // 1027: from issue #78
    // 1035: from issue #78
    // 1053: from issue #25
    // 1074: from issue #32
    // 1145: from search
    // 1178: from phone (issue #117)
    // 1256: from recent
    // 1260: from frequently used
    // 1302: from services
    // 1308: minigame?
    const sceneNumberArray = [
        1005, 1007, 1008, 1027, 1035, 1053, 1074, 1145, 1178, 1256, 1260, 1302,
        1308,
    ];
    if (!sceneNumberArray.includes(miniappScenePtr.readInt())) {
        return;
    }
    send("[hook] hook scene condition -> 1101");
    miniappScenePtr.writeInt(1101);

    // TODO: customize debugging endpoint
    // const websocketServerStringPtr = passArgs.add(8).readPointer().add(520);
    // VERBOSE && console.log("[hook] hook websocket server, original: ", websocketServerStringPtr.readUtf8String());
    // websocketServerStringPtr.writeUtf8String("ws://127.0.0.1:8189/");
};

const patchOnLoadStart = (base, config) => {
    // xref: AppletIndexContainer::OnLoadStart
    Interceptor.attach(base.add(config.LoadStartHookOffset), {
        onEnter(args) {
            // arm64 (darwin): x0=this, x1=debug_flag
            // x64 (windows/linux): rcx=this, rdx=debug_flag
            const thisPtr = isArmDarwin() ? this.context.x0 : this.context.rcx;
            send(
                `[inteceptor] AppletIndexContainer::OnLoadStart onEnter, ` +
                    `indexContainer.this: ${thisPtr}`,
            );
            if (isArmDarwin()) {
                // arm64 darwin: set x1 to 1
                if ((this.context.x1.toInt32() & 0xff) !== 1) {
                    this.context.x1 = ptr(1);
                }
            } else {
                // x64 windows/linux: set dl to 1
                if ((this.context.rdx & 0xff) !== 1) {
                    this.context.rdx = (this.context.rdx & ~0xff) | 0x1;
                }
            }
            // handle onLoad scene
            hookOnLoadScene(thisPtr, config.SceneOffsets);
        },
        onLeave(retval) {
            // do nothing
        },
    });
};

const parseConfig = () => {
    const rawConfig = `@@CONFIG@@`;
    if (rawConfig.includes("@@")) {
        // test addresses
        return {
            Version: 18955,
            LoadStartHookOffset: "0x25B52C0",
            CDPFilterHookOffset: "0x30248B0",
            SceneOffsets: [1408, 1344, 488],
        };
    }
    return JSON.parse(rawConfig);
};

const main = () => {
    const config = parseConfig();
    const mainModule = getMainModule(config.Version);
    patchOnLoadStart(mainModule.base, config);
    patchCDPFilter(mainModule.base, config);
};

main();