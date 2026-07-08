(() => {
    const root = typeof globalThis !== "undefined" ? globalThis : (typeof global !== "undefined" ? global : this);
    root["__helloWorld"] = "Hello, World!";
})();