# New Version Adaptation

Please follow the guidelines to find the offset values if you wish to support a new WMPF
version on your own.

Also, PR welcome!

## Prerequisites

You need to locate the folder which contains `WeChatAppEx.exe`, for newer versions, it will be something like 

```
%appdata%\Tencent\xwechat\xplugin\Plugins\RadiumWMPF\19339\extracted\runtime
```

where the 19339 indicates the version number.

Use IDA to open `flue.dll` inside this folder (for much older versions, open `WeChatAppEx.exe`)

**Please wait for the loading patiently, or the strings/cross reference views will be incomplete and you cannot locate the offset.**

## LoadStartHookOffset

**(Starting from version 18891)** Please search `OnLoadStart` (camel-case) and find the x-ref function that references a string contains `applet_index_container.cc`. Possibly `sub_18xxxxxxx+E6`

![OnLoadStartHook.Extra.1](./screenshots/adaptation/onload_start_hook.extra.1.png)

> If you cannot find something similar to the picture below, and you can only see something like `.rdata:000000018AB7A3E4                 db  4Fh ; O` , this means the loading is not complete, please wait.

![OnLoadStartHook.Extra.2](./screenshots/adaptation/onload_start_hook.extra.2.png)

> To show the Pseudocode like below, press F5

![OnLoadStartHook.Extra.3](./screenshots/adaptation/onload_start_hook.extra.3.png)

If you found `sub_1825B50C0` (as shown in the above example) matches the pattern in the picture above, then you can fill in 

```
{
    "Version": xxx,
    "LoadStartHookOffset": "0x25B50C0",
}
```

Scroll down to the bottom of the pseudocode of this function and you will find something like

(version 19339 example)

```cpp
 if ( (_BYTE)a2 )
    result = sub_182B02350(*(_QWORD *)(*(_QWORD *)(a1 + 56) + 1376LL), *(_QWORD *)(*(_QWORD *)(a1 + 80) + 56LL));
  if ( ((unsigned __int64)v19 ^ v27) != _security_cookie )
  {
    ((void (*)(void))unk_184AD7B40)();
    __debugbreak();
  }
  return result;
```

You will find the magic number `1376LL`, this is the first param of the SceneOffsets

```json
"SceneOffsets": [1376, ?, ?]
```

Double click and navigate to the function which contains that number ( `sub_182B02350` in the example above)

You will find something like 

```cpp
result = *(_QWORD *)(a1 + 8);
  if ( *(_DWORD *)(*(_QWORD *)(*(_QWORD *)(result + 1312) + 16LL) + 456LL) != 1101 && *(_BYTE *)(a1 + 41) != 1 )
    goto LABEL_32;
  v34 = 0xAAAAAAAAAAAAAAAAuLL;
  ws:__localhost:9421_1 = 0;
  v30 = 0;
  v31 = 0;
  memset(v33, 0, sizeof(v33));
  v32 = v33;
  ws:__localhost:9421 = (char *)&ws:__localhost:9421_1;
```

The number `1312`  and `456` is what we need for the rest of SceneOffsets

```json
"SceneOffsets": [1376, 1312, 456]
```

> **(For old version 14199 as an example)** Locate the `AppletIndexContainer::OnLoadStart` function by searching `[perf] AppletIndexContainer::OnLoadStart`
in strings.
>
> ![OnLoadStartHook.1](./screenshots/adaptation/onload_start_hook.1.png)
>
> Hit `x`, the only x-ref function address is the offset.
>
> ![OnLoadStartHook.2](./screenshots/adaptation/onload_start_hook.2.png)**Note: 
>
> Also, check the struct offset in these two marked functions.
> These offsets are being used in the `onLoadStartHook` function in [frida/hook.js](frida/hook.js)
>
> ![OnLoadStartHook.3](./screenshots/adaptation/onload_start_hook.3.png)

## CDPFilterHookOffset

Locate the filter by searching `SendToClientFilter` in
strings.

![CDPFilterHook.1](./screenshots/adaptation/cdp_filter_hook.1.png)

Hit `x`, go to the only function that references this string.

![CDPFilterHook.2](./screenshots/adaptation/cdp_filter_hook.2.png)

The hook target function `sub_1824839E0` is the very first
function called in the x-refed function `sub_181DB82D0`.

![CDPFilterHook.3](./screenshots/adaptation/cdp_filter_hook.3.png)

```
"CDPFilterHookOffset": "0x24839E0",
```

## Save the config

Save `addresses.xxxxx.json` in frida/config with the params you found above where `xxxxx` is the new version

```
{
    "Version": xxxxx,
    "LoadStartHookOffset": "0x25B5DD0",
    "CDPFilterHookOffset": "0x301B3C0",
    "SceneOffsets": [1376, 1312, 456]
}
```

## (Legacy) ResourceCachePolicyHookOffset

> We don't need this in the latest version

Not sure if this function affects the sources shown in the
devtools, keep hooking this just in case.

Locate the resource cache policy function by searching
`WAPCAdapterAppIndex.js` in strings, select the second
search result.

![ResourceCacheHook.1](./screenshots/adaptation/resource_cache_hook.1.png)

Hit `x`, the only function that references this string
is the target function.


![ResourceCacheHook.2](./screenshots/adaptation/resource_cache_hook.2.png)



