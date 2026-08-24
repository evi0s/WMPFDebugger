const getPlatform = () => {
    // retval: "windows" | "linux" | "darwin"
    return Process.platform;
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
    // xref: SendToClientFilter OR devtools_message_filter_applet_webview.cc
    const offset = config.CDPFilterHookOffset;
    Interceptor.attach(base.add(offset), {
        onLeave(retval) {
            // see https://github.com/evi0s/WMPFDebugger/pull/262
            if (getPlatform() == 'windows') {
                retval = retval.readPointer()
            }
            if (retval.isNull()) return;
            try {
                const val = retval.add(8).readU32();
                send(`[patch] CDP filter on leave, retval+8 = ${val}`);
                if (val === 6) {
                    retval.add(8).writeU32(0x0);
                    send("[patch] CDP filter patched");
                }
            } catch (e) {
                send(`[patch] CDP filter error: ${e}`);
            }
        }
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
            send(
                `[inteceptor] AppletIndexContainer::OnLoadStart onEnter, ` +
                    `indexContainer.this: ${args[0]}`,
            );
            // write debug_flag to 0x1
            if (args[1].and(0xff).toInt32() !== 1) {
                args[1] = args[1].and(ptr("0xffffffffffffff00")).or(1);
            }
            // handle onLoad scene
            hookOnLoadScene(args[0], config.SceneOffsets);
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