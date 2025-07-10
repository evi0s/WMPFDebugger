# New Version Adaptation

Please follow the guidelines (version 14199 as an example)
to find the offset values if you wish to support a new WMPF
version on your own.

Also, PR welcome!

## LoadStartHookOffset

Locate the `AppletIndexContainer::OnLoadStart` function
by searching `[perf] AppletIndexContainer::OnLoadStart`
in strings.

![OnLoadStartHook.1](./screenshots/adaptation/onload_start_hook.1.png)

Hit `x`, the only x-ref function address is the offset.

![OnLoadStartHook.2](./screenshots/adaptation/onload_start_hook.2.png)

Also, check the struct offset in these two marked functions.
These offsets are being used in the `onLoadStartHook` function
in [frida/hook.js](frida/hook.js)

![OnLoadStartHook.3](./screenshots/adaptation/onload_start_hook.3.png)

## CDPFilterHookOffset

Locate the filter by searching `SendToClientFilter` in
strings.

![CDPFilterHook.1](./screenshots/adaptation/cdp_filter_hook.1.png)

Hit `x`, go to the only function that references this string.

![CDPFilterHook.2](./screenshots/adaptation/cdp_filter_hook.2.png)

The hook target function `sub_1824839E0` is the very first
function called in the x-refed function `sub_181DB82D0`.

![CDPFilterHook.3](./screenshots/adaptation/cdp_filter_hook.3.png)

## ResourceCachePolicyHookOffset

Not sure if this function affects the sources shown in the
devtools, keep hooking this just in case.

Locate the resource cache policy function by searching
`WAPCAdapterAppIndex.js` in strings, select the second
search result.

![ResourceCacheHook.1](./screenshots/adaptation/resource_cache_hook.1.png)

Hit `x`, the only function that references this string
is the target function.


![ResourceCacheHook.2](./screenshots/adaptation/resource_cache_hook.2.png)



