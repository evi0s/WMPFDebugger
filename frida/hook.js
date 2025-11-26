const VERBOSE = false;

const getMainModule = (version) => {
    if (version >= 13331) {
        return Process.findModuleByName("flue.dll");
    }
    return Process.findModuleByName("WeChatAppEx.exe");
}


const patchResourceCachePolicy = (base, offset, version) => {
    // xref: WAPCAdapterAppIndex.js
    Interceptor.attach(base.add(offset), {
        onEnter(args) {
            console.log(`[patch] lib cache policy ${offset} on enter`);
        },
        onLeave(retval) {
            console.log(`[patch] lib cache policy ${offset} onLeave with retval:`, retval.toInt32(), "; patch to 0x0");
            retval.replace(0x0);
        }
    });
}

const patchCDPFilter = (base, offset, version) => {
    // filter function: sub_14342D970
    // xref: SendToClientFilter OR devtools_message_filter_applet_webview.cc
    Interceptor.attach(base.add(offset), {
        onEnter(args) {
            !VERBOSE ? console.log(`[patch] patch CDP filter ${offset}`) : console.log(`[patch] CDP filter ${offset} on enter, original value of v216:`, args[0].readPointer());
            this.v216 = args[0];
        },
        onLeave(retval) {
            const v216Value = this.v216.readPointer();
            VERBOSE && console.log(`[patch] CDP filter ${offset} on leave, patch v216, now value:`, v216Value, "; *(v216 + 8) =", v216Value.add(8).readU32());
            if (v216Value.add(8).readU32() == 6) {
                v216Value.add(8).writeU32(0x0);
            }
        }
    });
}

const onLoadStartHook = (a1, a2, version) => {
    let structOffset = [1208, 1160, 16, 488];
    switch (version) {
        case 13331:
        case 13341:
        case 13487:
        case 13639:
        case 14315:
            structOffset = [1272, 1224, 16, 488];
            break;
        case 13655:
            structOffset = [1280, 1232, 16, 488];
            break;
        case 13871:
        case 13909:
        case 14161:
        case 14199:
        case 16133:
        case 16203:
        case 16389:
        case 16467:
        case 16771:
            structOffset = [1360, 1312, 16, 488];
            break;
        case 16815:
        case 16965:
            structOffset = [1416, 1360, 16, 488];
            break;
        case 17037:
        case 17071:
            structOffset = [1408, 1352, 16, 488]
            break
    }
    const passArgs = a1.add(56).readPointer().add(structOffset[0]).readPointer();
    const passConditionPtr = passArgs.add(8).readPointer().add(structOffset[1]).readPointer().add(structOffset[2]).readPointer().add(structOffset[3]);
    console.log("[hook] scene:", passConditionPtr.readInt());

    // 1000: from issue #83 <-- will crash the process
    // 1007: from issue #80
    // 1008: from issue #53
    // 1027: from issue #78
    // 1035: from issue #78
    // 1053: from issue #25
    // 1074: from issue #32
    // 1145: from search
    // 1256: from recent
    // 1260: from frequently used
    // 1302: from services
    // 1308: minigame?
    const sceneNumberArray = [1005, 1007, 1008, 1027, 1035, 1053, 1074, 1145, 1256, 1260, 1302, 1308];
    if (!sceneNumberArray.includes(passConditionPtr.readInt())) {
        return;
    }
    console.log("[hook] hook scene condition -> 1101");
    passConditionPtr.writeInt(1101);

    // TODO: customize debugging endpoint
    // const websocketServerStringPtr = passArgs.add(8).readPointer().add(520);
    // VERBOSE && console.log("[hook] hook websocket server, original: ", websocketServerStringPtr.readUtf8String());
    // websocketServerStringPtr.writeUtf8String("ws://127.0.0.1:8189/");
}

const interceptor = (base, offset, version) => {
    // xref: AppletIndexContainer::OnLoadStart
    Interceptor.attach(base.add(offset), {
        onEnter(args) {
            console.log("[inteceptor] AppletIndexContainer::OnLoadStart onEnter, indexContainer.this: ", this.context.rcx);
            // write dl to 0x1
            if ((this.context.rdx & 0xFF) !== 1) {
                this.context.rdx = (this.context.rdx & ~0xFF) | 0x1;
            }
            // handle others
            onLoadStartHook(this.context.rcx, this.context.rdx, version);
        },
        onLeave(retval) {
            // do nothing
        }
    })
}

const parseConfig = () => {
    const rawConfig = `@@CONFIG@@`;
    if (rawConfig.includes("@@")) {
        // test addresses
        return {
            Version: 13341,
            LoadStartHookOffset: "0x10009E0",
            CDPFilterHookOffset: "0x242E8E0",
            ResourceCachePolicyHookOffset: "0x1053730"
        }
    }
    return JSON.parse(rawConfig);
}

const main = () => {
    const config = parseConfig();
    const mainModule = getMainModule(config.Version);
    interceptor(mainModule.base, config.LoadStartHookOffset, config.Version);
    patchResourceCachePolicy(mainModule.base, config.ResourceCachePolicyHookOffset, config.Version);
    patchCDPFilter(mainModule.base, config.CDPFilterHookOffset, config.Version);
}

main();
