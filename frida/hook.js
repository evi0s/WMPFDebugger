const VERBOSE = false;

const getMainModule = () => {
    return Process.findModuleByName("WeChatAppEx.exe");
}


const patchResourceCachePolicy = (base, offset) => {
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

const patchCDPFilter = (base, offset) => {
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

const onLoadStartHook = (a1, a2) => {
    const passArgs = a1.add(56).readPointer().add(1208).readPointer();
    const passConditionPtr = passArgs.add(8).readPointer().add(1160).readPointer().add(16).readPointer().add(488);
    VERBOSE && console.log("[hook] scene:", passConditionPtr.readInt());
    const sceneNumberArray = [1256];
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

const interceptor = (base, offset) => {
    // xref: AppletIndexContainer::OnLoadStart
    Interceptor.attach(base.add(offset), {
        onEnter(args) {
            console.log("[inteceptor] AppletIndexContainer::OnLoadStart onEnter, indexContainer.this: ", this.context.rcx);
            // write dl to 0x1
            if ((this.context.rdx & 0xFF) !== 1) {
                this.context.rdx = (this.context.rdx & ~0xFF) | 0x1;
            }
            // handle others
            onLoadStartHook(this.context.rcx, this.context.rdx);
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
            Version: 11633,
            LoadStartHookOffset: "0x28F22A0",
            CDPFilterHookOffset: "0x38D41E0",
            ResourceCachePolicyHookOffset: "0x294DA80"
        }
    }
    return JSON.parse(rawConfig);
}

const main = () => {
    const mainModule = getMainModule();
    const config = parseConfig();
    interceptor(mainModule.base, config.LoadStartHookOffset);
    patchResourceCachePolicy(mainModule.base, config.ResourceCachePolicyHookOffset);
    patchCDPFilter(mainModule.base, config.CDPFilterHookOffset);
}

main();
