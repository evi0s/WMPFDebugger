const getMainModule = (version) => {
    if (version >= 13331) {
        return Process.findModuleByName("flue.dll");
    }
    return Process.findModuleByName("WeChatAppEx.exe");
};

const patchCDPFilter = (base, config) => {
    // xref: SendToClientFilter OR devtools_message_filter_applet_webview.cc
    const offset = config.CDPFilterHookOffset;
    Interceptor.attach(base.add(offset), {
        onEnter(args) {
            send(
                `[patch] CDP filter on enter, original value of input:`,
                args[0].readPointer(),
            );
            this.inputValue = args[0];
        },
        onLeave(retval) {
            const inputValue = this.inputValue.readPointer();
            if (inputValue.isNull() || inputValue.add(8).isNull()) {
                // there's a chance the value could be null
                // return here to avoid crash
                return;
            }

            send(
                `[patch] CDP filter on leave, patch input, now value:`,
                inputValue,
                "; *(input + 8) =",
                inputValue.add(8).readU32(),
            );
            if (inputValue.add(8).readU32() == 6) {
                inputValue.add(8).writeU32(0x0);
            }
        },
    });
};

const hookOnLoadScene = (a1, sceneOffsets) => {
    const miniappConfigPtr = a1
        .add(56)
        .readPointer()
        .add(sceneOffsets[0])
        .readPointer();
    const miniappScenePtr = miniappConfigPtr
        .add(8)
        .readPointer()
        .add(sceneOffsets[1])
        .readPointer()
        .add(16)
        .readPointer()
        .add(488);
    send("[hook] scene:", miniappScenePtr.readInt());

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
                "[inteceptor] AppletIndexContainer::OnLoadStart onEnter, indexContainer.this: ",
                this.context.rcx,
            );
            // write dl to 0x1
            if ((this.context.rdx & 0xff) !== 1) {
                this.context.rdx = (this.context.rdx & ~0xff) | 0x1;
            }
            // handle onLoad scene
            hookOnLoadScene(this.context.rcx, config.SceneOffsets);
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
            SceneOffsets: [1408, 1344],
        };
    }
    return JSON.parse(rawConfig);
};

const main = () => {
    const config = parseConfig();
    const mainModule = getMainModule(config.Version);
    patchOnLoadStart(mainModule.base, config);
    patchCDPFilter(mainModule.base, config.CDPFilterHookOffset, config.Version);
};

main();
