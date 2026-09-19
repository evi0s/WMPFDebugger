"use strict";

const RESULT_MESSAGE = "wmpf-offsets";
const ERROR_MESSAGE = "wmpf-offsets-error";

const asciiPattern = (value) =>
    Array.from(value)
        .map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
        .join(" ");

const toOffset = (module, address) => address.sub(module.base).toUInt32();
const toHex = (value) => `0x${value.toString(16)}`;

const arraysEqual = (left, right) =>
    left.length === right.length && left.every((value, index) => value === right[index]);

const findSection = (module, name) => {
    const section = module.enumerateSections().find((item) => item.name === name);
    if (section === undefined) {
        throw new Error(`${name} section not found in ${module.name}`);
    }
    return section;
};

// x64 PE exception records provide reliable function boundaries even when the
// binary has no symbols. Keep the widest record for duplicate function starts.
const loadFunctions = (module) => {
    const section = findSection(module, ".pdata");
    const bytes = section.address.readByteArray(section.size);
    if (bytes === null) {
        throw new Error("unable to read .pdata");
    }

    const view = new DataView(bytes);
    const byStart = new Map();
    for (let offset = 0; offset + 12 <= view.byteLength; offset += 12) {
        const begin = view.getUint32(offset, true);
        const end = view.getUint32(offset + 4, true);
        if (begin === 0 || begin >= end || end > module.size) {
            continue;
        }
        const previousEnd = byStart.get(begin);
        if (previousEnd === undefined || end > previousEnd) {
            byStart.set(begin, end);
        }
    }

    const functions = Array.from(byStart, ([begin, end]) => ({ begin, end })).sort(
        (left, right) => left.begin - right.begin,
    );
    if (functions.length === 0) {
        throw new Error("no functions found in .pdata");
    }
    return functions;
};

const findFunction = (functions, address) => {
    let low = 0;
    let high = functions.length - 1;
    while (low <= high) {
        const middle = (low + high) >>> 1;
        const candidate = functions[middle];
        if (address < candidate.begin) {
            high = middle - 1;
        } else if (address >= candidate.end) {
            low = middle + 1;
        } else {
            return candidate;
        }
    }
    return null;
};

const requireFunction = (functions, address, name) => {
    const entry = findFunction(functions, address);
    if (entry === null) {
        throw new Error(`${name}: function boundary not found for ${toHex(address)}`);
    }
    return entry;
};

const findStringMatches = (module, value, required = true) => {
    const matches = [];
    const sections = module
        .enumerateSections()
        .filter((section) => section.name !== ".text" && section.name !== ".pdata");

    for (const section of sections) {
        try {
            for (const match of Memory.scanSync(
                section.address,
                section.size,
                asciiPattern(value),
            )) {
                matches.push({ address: match.address, section });
            }
        } catch (_) {
            // A mapped PE may contain sections that are no longer readable.
        }
    }

    if (required && matches.length === 0) {
        throw new Error(`string not found: ${value}`);
    }
    return matches;
};

const exactStringRanges = (module, value, required = true) =>
    findStringMatches(module, value, required).map(({ address }) => {
        const offset = toOffset(module, address);
        return { start: offset, end: offset };
    });

// Compiler string pooling often makes a source path a suffix of a larger
// NUL-terminated string. An LEA may target any address from the beginning of
// that string through the searched fragment.
const containingStringRanges = (module, value, required = true) =>
    findStringMatches(module, value, required).map(({ address, section }) => {
        let start = address;
        for (
            let count = 0;
            count < 4096 && start.compare(section.address) > 0;
            count++
        ) {
            if (start.sub(1).readU8() === 0) {
                break;
            }
            start = start.sub(1);
        }
        return {
            start: toOffset(module, start),
            end: toOffset(module, address.add(value.length - 1)),
        };
    });

const buildStringTargets = (module) => ({
    loadFile: containingStringRanges(module, "applet_index_container.cc"),
    loadName: containingStringRanges(
        module,
        "AppletIndexContainer::OnLoadStart(bool",
    ),
    filterName: exactStringRanges(module, "SendToClientFilter"),
    filterFile: containingStringRanges(
        module,
        "devtools_message_filter_applet_webview.cc",
        false,
    ),
    castName: exactStringRanges(module, "CastToJson", false),
    castFile: containingStringRanges(
        module,
        "devtools_message_filter.cc",
        false,
    ),
    startUrl: exactStringRanges(module, " request.url=", false),
    startFailure: exactStringRanges(
        module,
        "create webview devtools failed.",
        false,
    ),
});

const scan = (address, size, pattern, onMatch) =>
    new Promise((resolve, reject) => {
        Memory.scan(address, size, pattern, {
            onMatch(match) {
                onMatch(match);
            },
            onError(reason) {
                reject(new Error(reason));
            },
            onComplete() {
                resolve();
            },
        });
    });

const targetMatches = (target, ranges) =>
    ranges.some((range) => target >= range.start && target <= range.end);

// Resolve RIP-relative LEAs to their owning .pdata function. This is more
// stable than byte signatures around the function prologue.
const findXrefFunctions = async (module, functions, targets) => {
    const results = Object.fromEntries(
        Object.keys(targets).map((name) => [name, new Set()]),
    );

    for (const range of module.enumerateRanges("r-x")) {
        for (const pattern of ["48 8d", "4c 8d"]) {
            await scan(range.base, range.size, pattern, (address) => {
                try {
                    if (address.add(7).compare(range.base.add(range.size)) > 0) {
                        return;
                    }
                    // mod=00 and r/m=101 is the RIP-relative addressing form.
                    if ((address.add(2).readU8() & 0xc7) !== 0x05) {
                        return;
                    }
                    const instructionOffset = toOffset(module, address);
                    const target = instructionOffset + 7 + address.add(3).readS32();
                    const owner = findFunction(functions, instructionOffset);
                    if (owner === null) {
                        return;
                    }
                    for (const [name, ranges] of Object.entries(targets)) {
                        if (targetMatches(target, ranges)) {
                            results[name].add(owner.begin);
                        }
                    }
                } catch (_) {
                    // Ignore an instruction that races with an unreadable page.
                }
            });
        }
    }
    return results;
};

const intersectSets = (...sets) => {
    if (sets.length === 0) {
        return new Set();
    }
    return new Set(Array.from(sets[0]).filter((value) => sets.every((set) => set.has(value))));
};

const requireUnique = (name, values) => {
    const candidates = Array.from(values);
    if (candidates.length !== 1) {
        throw new Error(
            `${name}: expected one function, found ${candidates.length}` +
                (candidates.length === 0
                    ? ""
                    : ` (${candidates.map(toHex).join(", ")})`),
        );
    }
    return candidates[0];
};

const disassemble = (module, entry, maximumSize = entry.end - entry.begin) => {
    const instructions = [];
    const end = entry.begin + Math.min(entry.end - entry.begin, maximumSize);
    let offset = entry.begin;
    while (offset < end) {
        const instruction = Instruction.parse(module.base.add(offset));
        if (instruction.size <= 0 || offset + instruction.size > end) {
            break;
        }
        instructions.push(instruction);
        offset += instruction.size;
    }
    return instructions;
};

const parseNumber = (value) => {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }
    if (value === null || value === undefined) {
        return null;
    }
    const text = String(value).trim().toLowerCase();
    if (/^-0x[0-9a-f]+$/.test(text)) {
        return -Number.parseInt(text.slice(3), 16);
    }
    if (/^0x[0-9a-f]+$/.test(text)) {
        return Number.parseInt(text.slice(2), 16);
    }
    const result = Number(text);
    return Number.isFinite(result) ? result : null;
};

const operandsOf = (instruction) =>
    Array.isArray(instruction.operands) ? instruction.operands : [];

const registerOperand = (instruction, index) => {
    const operand = operandsOf(instruction)[index];
    return operand !== undefined && operand.type === "reg" ? operand : null;
};

const memoryOperand = (instruction, index) => {
    const operand = operandsOf(instruction)[index];
    return operand !== undefined && operand.type === "mem" ? operand : null;
};

const immediateOperand = (instruction, index) => {
    const operand = operandsOf(instruction)[index];
    return operand !== undefined && operand.type === "imm" ? operand : null;
};

const REGISTER_ALIASES = {
    rax: "rax", eax: "rax", ax: "rax", al: "rax", ah: "rax",
    rbx: "rbx", ebx: "rbx", bx: "rbx", bl: "rbx", bh: "rbx",
    rcx: "rcx", ecx: "rcx", cx: "rcx", cl: "rcx", ch: "rcx",
    rdx: "rdx", edx: "rdx", dx: "rdx", dl: "rdx", dh: "rdx",
    rsi: "rsi", esi: "rsi", si: "rsi", sil: "rsi",
    rdi: "rdi", edi: "rdi", di: "rdi", dil: "rdi",
    rbp: "rbp", ebp: "rbp", bp: "rbp", bpl: "rbp",
    rsp: "rsp", esp: "rsp", sp: "rsp", spl: "rsp",
    r8: "r8", r8d: "r8", r8w: "r8", r8b: "r8",
    r9: "r9", r9d: "r9", r9w: "r9", r9b: "r9",
    r10: "r10", r10d: "r10", r10w: "r10", r10b: "r10",
    r11: "r11", r11d: "r11", r11w: "r11", r11b: "r11",
    r12: "r12", r12d: "r12", r12w: "r12", r12b: "r12",
    r13: "r13", r13d: "r13", r13w: "r13", r13b: "r13",
    r14: "r14", r14d: "r14", r14w: "r14", r14b: "r14",
    r15: "r15", r15d: "r15", r15w: "r15", r15b: "r15",
};

const canonicalRegister = (name) =>
    typeof name === "string" ? REGISTER_ALIASES[name.toLowerCase()] ?? null : null;

const ARGUMENT_REGISTERS = new Map([
    ["rcx", 0],
    ["rdx", 1],
    ["r8", 2],
    ["r9", 3],
]);

const VOLATILE_REGISTERS = new Set(["rax", "rcx", "rdx", "r8", "r9", "r10", "r11"]);

const argumentExpression = (index) => ({ kind: "arg", index });
const constantExpression = (value) => ({ kind: "constant", value });
const loadExpression = (base, offset) => ({ kind: "load", base, offset });

const addExpression = (base, offset) => {
    if (offset === 0) {
        return base;
    }
    if (base.kind === "add") {
        return { kind: "add", base: base.base, offset: base.offset + offset };
    }
    return { kind: "add", base, offset };
};

const expressionKey = (expression) => {
    if (expression === null) {
        return "unknown";
    }
    if (expression.kind === "arg") {
        return `arg${expression.index}`;
    }
    if (expression.kind === "constant") {
        return `constant:${expression.value}`;
    }
    return `${expression.kind}(${expressionKey(expression.base)},${expression.offset})`;
};

const operandWritesRegister = (operand, register) => {
    if (operand === null || canonicalRegister(operand.value) !== register) {
        return false;
    }
    return typeof operand.access !== "string" || operand.access.includes("w");
};

const hasIndexRegister = (memory) => {
    const index = memory && memory.value ? memory.value.index : null;
    return index !== undefined && index !== null && index !== "invalid";
};

const memoryDisplacement = (memory) => {
    if (memory === null || memory.value === null || memory.value === undefined) {
        return null;
    }
    return parseNumber(memory.value.disp ?? 0);
};

// Recover pointer provenance by walking backwards through register moves and
// loads. It intentionally stops at calls for volatile registers and rejects
// indexed addressing, so ambiguous data flow fails closed.
const resolveRegister = (instructions, beforeIndex, requestedRegister, depth = 0) => {
    const register = canonicalRegister(requestedRegister);
    if (register === null || depth > 48) {
        return null;
    }

    for (let index = beforeIndex - 1; index >= 0; index--) {
        const instruction = instructions[index];
        if (instruction.mnemonic === "call" && VOLATILE_REGISTERS.has(register)) {
            return null;
        }

        const destination = registerOperand(instruction, 0);
        if (!operandWritesRegister(destination, register)) {
            continue;
        }

        const sourceRegister = registerOperand(instruction, 1);
        const sourceMemory = memoryOperand(instruction, 1);
        const sourceImmediate = immediateOperand(instruction, 1);

        if (instruction.mnemonic === "mov" || instruction.mnemonic === "movabs") {
            if (sourceRegister !== null) {
                return resolveRegister(
                    instructions,
                    index,
                    sourceRegister.value,
                    depth + 1,
                );
            }
            if (
                sourceMemory !== null &&
                sourceMemory.size === Process.pointerSize &&
                !hasIndexRegister(sourceMemory)
            ) {
                const baseRegister = canonicalRegister(sourceMemory.value.base);
                const displacement = memoryDisplacement(sourceMemory);
                if (baseRegister === null || displacement === null) {
                    return null;
                }
                const base = resolveRegister(instructions, index, baseRegister, depth + 1);
                return base === null ? null : loadExpression(base, displacement);
            }
            if (sourceImmediate !== null) {
                const value = parseNumber(sourceImmediate.value);
                return value === null ? null : constantExpression(value);
            }
            return null;
        }

        if (instruction.mnemonic === "lea" && sourceMemory !== null) {
            if (hasIndexRegister(sourceMemory)) {
                return null;
            }
            const baseRegister = canonicalRegister(sourceMemory.value.base);
            const displacement = memoryDisplacement(sourceMemory);
            if (baseRegister === null || displacement === null) {
                return null;
            }
            const base = resolveRegister(instructions, index, baseRegister, depth + 1);
            return base === null ? null : addExpression(base, displacement);
        }

        if (
            (instruction.mnemonic === "add" || instruction.mnemonic === "sub") &&
            sourceImmediate !== null
        ) {
            const value = parseNumber(sourceImmediate.value);
            const base = resolveRegister(instructions, index, register, depth + 1);
            if (value === null || base === null) {
                return null;
            }
            return addExpression(base, instruction.mnemonic === "sub" ? -value : value);
        }

        return null;
    }

    const argumentIndex = ARGUMENT_REGISTERS.get(register);
    return argumentIndex === undefined ? null : argumentExpression(argumentIndex);
};

const unwrapLoadChain = (expression) => {
    if (expression === null) {
        return null;
    }
    if (expression.kind === "arg") {
        return { argumentIndex: expression.index, offsets: [] };
    }
    if (expression.kind !== "load") {
        return null;
    }
    const parent = unwrapLoadChain(expression.base);
    if (parent === null) {
        return null;
    }
    parent.offsets.push(expression.offset);
    return parent;
};

const directCallTarget = (module, instruction) => {
    if (instruction.mnemonic !== "call") {
        return null;
    }

    let target = null;
    const immediate = immediateOperand(instruction, 0);
    if (immediate !== null) {
        try {
            target = ptr(String(immediate.value));
        } catch (_) {
            target = null;
        }
    }
    if (target === null) {
        const match = instruction.opStr.match(/^(0x[0-9a-f]+)$/i);
        if (match !== null) {
            target = ptr(match[1]);
        }
    }
    if (
        target === null ||
        target.compare(module.base) < 0 ||
        target.compare(module.base.add(module.size)) >= 0
    ) {
        return null;
    }
    return toOffset(module, target);
};

const comparisonMemoryAndImmediate = (instruction) => {
    if (instruction.mnemonic !== "cmp") {
        return null;
    }
    const leftMemory = memoryOperand(instruction, 0);
    const rightMemory = memoryOperand(instruction, 1);
    const leftImmediate = immediateOperand(instruction, 0);
    const rightImmediate = immediateOperand(instruction, 1);

    const memory = leftMemory ?? rightMemory;
    const immediate = rightImmediate ?? leftImmediate;
    if (memory === null || immediate === null || hasIndexRegister(memory)) {
        return null;
    }
    const value = parseNumber(immediate.value);
    const displacement = memoryDisplacement(memory);
    const baseRegister = canonicalRegister(memory.value.base);
    if (value === null || displacement === null || baseRegister === null) {
        return null;
    }
    return { memory, immediate: value, displacement, baseRegister };
};

const recoverRemoteGuard = (instructions, name) => {
    const comparisons = [];
    for (let index = 0; index < instructions.length; index++) {
        const comparison = comparisonMemoryAndImmediate(instructions[index]);
        if (comparison === null || (comparison.immediate !== 1101 && comparison.immediate !== 1)) {
            continue;
        }
        const base = resolveRegister(
            instructions,
            index,
            comparison.baseRegister,
        );
        const chain = unwrapLoadChain(base);
        if (base === null || chain === null || chain.argumentIndex !== 0) {
            continue;
        }
        comparisons.push({
            immediate: comparison.immediate,
            fieldOffset: comparison.displacement,
            base,
            baseKey: expressionKey(base),
            rootOffsets: chain.offsets,
        });
    }

    const candidates = [];
    for (const scene of comparisons.filter((item) => item.immediate === 1101)) {
        for (const mode of comparisons.filter(
            (item) => item.immediate === 1 && item.baseKey === scene.baseKey,
        )) {
            candidates.push({
                rootOffsets: scene.rootOffsets,
                sceneOffset: scene.fieldOffset,
                modeOffset: mode.fieldOffset,
            });
        }
    }

    const unique = new Map(
        candidates.map((candidate) => [
            `${candidate.rootOffsets.join(":")}:${candidate.sceneOffset}:${candidate.modeOffset}`,
            candidate,
        ]),
    );
    if (unique.size !== 1) {
        throw new Error(`${name}: expected one scene/mode guard, found ${unique.size}`);
    }
    return Array.from(unique.values())[0];
};

const recoverCallArgumentChain = (module, instructions, target, name) => {
    const candidates = [];
    for (let index = 0; index < instructions.length; index++) {
        if (directCallTarget(module, instructions[index]) !== target) {
            continue;
        }
        const expression = resolveRegister(instructions, index, "rcx");
        const chain = unwrapLoadChain(expression);
        if (chain !== null && chain.argumentIndex === 0) {
            candidates.push(chain.offsets);
        }
    }

    const unique = new Map(candidates.map((offsets) => [offsets.join(":"), offsets]));
    if (unique.size !== 1) {
        throw new Error(`${name}: expected one call argument chain, found ${unique.size}`);
    }
    return Array.from(unique.values())[0];
};

const memoryAccesses = (instructions) => {
    const accesses = [];
    for (let index = 0; index < instructions.length; index++) {
        for (const operand of operandsOf(instructions[index])) {
            if (operand.type !== "mem" || hasIndexRegister(operand)) {
                continue;
            }
            const baseRegister = canonicalRegister(operand.value.base);
            const displacement = memoryDisplacement(operand);
            if (baseRegister === null || displacement === null) {
                continue;
            }
            const base = resolveRegister(instructions, index, baseRegister);
            if (base !== null) {
                accesses.push({
                    index,
                    instruction: instructions[index],
                    operand,
                    base,
                    baseKey: expressionKey(base),
                    displacement,
                });
            }
        }
    }
    return accesses;
};

const recoverWebSocketUrlOffset = (instructions, launchExpression) => {
    const launchKey = expressionKey(launchExpression);
    const accesses = memoryAccesses(instructions).filter(
        (access) => access.baseKey === launchKey,
    );
    const launchDisplacements = new Set(accesses.map((access) => access.displacement));
    const candidates = [];

    for (const instruction of instructions) {
        const comparison = comparisonMemoryAndImmediate(instruction);
        if (
            comparison === null ||
            comparison.immediate !== 0 ||
            comparison.memory.size !== 1
        ) {
            continue;
        }
        const stringOffset = comparison.displacement - 23;
        if (stringOffset < 0) {
            continue;
        }
        // MSVC may place the long-string branch (which contains a call) before
        // the short-string marker test in address order. In that case a linear
        // backward slice cannot safely carry the volatile base register to the
        // marker. The data and length loads are still proven to originate at
        // launchExpression, so correlate the marker with that pair and require
        // the same raw base register as an additional check.
        const sameBase = accesses.some(
            (access) =>
                (access.displacement === stringOffset ||
                    access.displacement === stringOffset + 8) &&
                canonicalRegister(access.operand.value.base) ===
                    comparison.baseRegister,
        );
        if (
            sameBase &&
            launchDisplacements.has(stringOffset) &&
            launchDisplacements.has(stringOffset + 8)
        ) {
            candidates.push(stringOffset);
        }
    }

    const unique = new Set(candidates);
    if (unique.size !== 1) {
        throw new Error(`websocket URL string: expected one offset, found ${unique.size}`);
    }
    return Array.from(unique)[0];
};

const findFirstCall = (module, entry) => {
    for (const instruction of disassemble(module, entry, 0x600)) {
        const target = directCallTarget(module, instruction);
        if (target !== null) {
            return target;
        }
    }
    throw new Error(`no direct call found in function ${toHex(entry.begin)}`);
};

const assertPointerOffsets = (name, offsets) => {
    if (
        offsets.length === 0 ||
        offsets.some(
            (offset) =>
                !Number.isInteger(offset) || offset < 0 || offset > 0x10000 || offset % 8 !== 0,
        )
    ) {
        throw new Error(`${name}: implausible pointer chain [${offsets.join(", ")}]`);
    }
};

const assertFieldOffset = (name, offset, alignment) => {
    if (!Number.isInteger(offset) || offset < 0 || offset > 0x10000 || offset % alignment !== 0) {
        throw new Error(`${name}: implausible field offset ${offset}`);
    }
};

const containsDirectCall = (module, instructions, target) =>
    instructions.some((instruction) => directCallTarget(module, instruction) === target);

const validateCastToJsonAbi = (instructions) => {
    const inputOffsets = new Set(
        memoryAccesses(instructions)
            .filter((access) => access.baseKey === expressionKey(argumentExpression(1)))
            .map((access) => access.displacement),
    );
    if (!inputOffsets.has(0) || !inputOffsets.has(8)) {
        throw new Error("CastToJson candidate does not read the input pointer/length pair");
    }
};

const detectModern = (module, functions, xrefs, loadStart) => {
    const startOffset = requireUnique(
        "DevToolsWebSocketServer::Start",
        intersectSets(xrefs.startUrl, xrefs.startFailure),
    );
    const filterOffset = requireUnique(
        "applet-webview SendToClientFilter",
        intersectSets(xrefs.filterName, xrefs.filterFile),
    );
    const castOffset = requireUnique(
        "CastToJson",
        intersectSets(xrefs.castName, xrefs.castFile),
    );

    const start = requireFunction(functions, startOffset, "DevToolsWebSocketServer::Start");
    const filter = requireFunction(functions, filterOffset, "SendToClientFilter");
    const cast = requireFunction(functions, castOffset, "CastToJson");

    const loadInstructions = disassemble(module, loadStart);
    const startInstructions = disassemble(module, start, 0x1200);
    const filterInstructions = disassemble(module, filter);
    const castPrefix = disassemble(module, cast, 0x100);

    const serverChain = recoverCallArgumentChain(
        module,
        loadInstructions,
        start.begin,
        "OnLoadStart -> DevToolsWebSocketServer::Start",
    );
    const loadGuard = recoverRemoteGuard(loadInstructions, "OnLoadStart");
    const startGuard = recoverRemoteGuard(startInstructions, "DevToolsWebSocketServer::Start");

    assertPointerOffsets("server pointer chain", serverChain);
    assertPointerOffsets("OnLoadStart remote config chain", loadGuard.rootOffsets);
    assertPointerOffsets("Start remote config chain", startGuard.rootOffsets);
    if (serverChain.length !== 2 || loadGuard.rootOffsets.length !== 3 || startGuard.rootOffsets.length !== 3) {
        throw new Error("unexpected modern WMPF pointer-chain depth");
    }
    if (serverChain[0] !== loadGuard.rootOffsets[0]) {
        throw new Error("OnLoadStart server and remote-config roots disagree");
    }
    if (!arraysEqual(loadGuard.rootOffsets.slice(1), startGuard.rootOffsets.slice(1))) {
        throw new Error("OnLoadStart and Start remote-config chains disagree");
    }
    if (
        loadGuard.sceneOffset !== startGuard.sceneOffset ||
        loadGuard.modeOffset !== startGuard.modeOffset
    ) {
        throw new Error("OnLoadStart and Start remote-debug fields disagree");
    }

    const launchExpression = loadExpression(argumentExpression(0), startGuard.rootOffsets[0]);
    const websocketUrlOffset = recoverWebSocketUrlOffset(startInstructions, launchExpression);
    assertFieldOffset("scene", startGuard.sceneOffset, 4);
    assertFieldOffset("remote debug mode", startGuard.modeOffset, 4);
    assertFieldOffset("websocket URL string", websocketUrlOffset, 8);

    if (!containsDirectCall(module, filterInstructions, cast.begin)) {
        throw new Error("SendToClientFilter does not call the detected CastToJson");
    }
    validateCastToJsonAbi(castPrefix);

    return {
        LoadStartHookOffset: toHex(loadStart.begin),
        CDPFilterHookOffset: toHex(filter.begin),
        CastToJsonHookOffset: toHex(cast.begin),
        MiniAppConfigStructOffsets: {
            LaunchConfigOffsets: [...serverChain, startGuard.rootOffsets[0]],
            RemoteDebugConfigOffsets: startGuard.rootOffsets.slice(1),
            SceneOffset: startGuard.sceneOffset,
            WebSocketURLStringOffset: websocketUrlOffset,
            RemoteDebugModeOffset: startGuard.modeOffset,
        },
    };
};

const findLegacyScenePath = (module, functions, loadStart) => {
    const instructions = disassemble(module, loadStart);
    const candidates = [];

    for (let index = 0; index < instructions.length; index++) {
        const target = directCallTarget(module, instructions[index]);
        if (target === null) {
            continue;
        }
        const expression = resolveRegister(instructions, index, "rcx");
        const callChain = unwrapLoadChain(expression);
        if (
            callChain === null ||
            callChain.argumentIndex !== 0 ||
            callChain.offsets.length !== 2
        ) {
            continue;
        }

        const callee = findFunction(functions, target);
        if (callee === null) {
            continue;
        }
        try {
            const guard = recoverRemoteGuard(
                disassemble(module, callee, 0x500),
                `legacy scene helper ${toHex(callee.begin)}`,
            );
            if (guard.rootOffsets.length === 3) {
                candidates.push({ callChain: callChain.offsets, guard });
            }
        } catch (_) {
            // Most OnLoadStart callees are unrelated to the scene guard.
        }
    }

    const unique = new Map(
        candidates.map((candidate) => [
            `${candidate.callChain.join(":")}:${candidate.guard.rootOffsets.join(":")}:${candidate.guard.sceneOffset}`,
            candidate,
        ]),
    );
    if (unique.size !== 1) {
        throw new Error(`legacy scene path: expected one candidate, found ${unique.size}`);
    }
    return Array.from(unique.values())[0];
};

const detectLegacy = (module, functions, xrefs, loadStart) => {
    const filterOwnerOffset = requireUnique("SendToClientFilter", xrefs.filterName);
    const filterOwner = requireFunction(functions, filterOwnerOffset, "SendToClientFilter owner");
    const scenePath = findLegacyScenePath(module, functions, loadStart);
    const sceneOffsets = [
        ...scenePath.callChain,
        ...scenePath.guard.rootOffsets,
        scenePath.guard.sceneOffset,
    ];

    assertPointerOffsets("legacy launch pointer chain", scenePath.callChain);
    assertPointerOffsets("legacy remote config chain", scenePath.guard.rootOffsets);
    assertFieldOffset("legacy scene", scenePath.guard.sceneOffset, 4);

    return {
        LoadStartHookOffset: toHex(loadStart.begin),
        CDPFilterHookOffset: toHex(findFirstCall(module, filterOwner)),
        SceneOffsets: sceneOffsets,
    };
};

const detect = async () => {
    if (Process.platform !== "windows" || Process.arch !== "x64") {
        throw new Error("automatic offset detection requires Windows x64");
    }
    const module = Process.findModuleByName("flue.dll");
    if (module === null) {
        throw new Error("flue.dll is not loaded");
    }

    const functions = loadFunctions(module);
    const targets = buildStringTargets(module);
    const xrefs = await findXrefFunctions(module, functions, targets);
    const loadStartOffset = requireUnique(
        "AppletIndexContainer::OnLoadStart",
        intersectSets(xrefs.loadFile, xrefs.loadName),
    );
    const loadStart = requireFunction(
        functions,
        loadStartOffset,
        "AppletIndexContainer::OnLoadStart",
    );

    const modernAnchorsPresent = [
        xrefs.filterFile,
        xrefs.castName,
        xrefs.castFile,
        xrefs.startUrl,
        xrefs.startFailure,
    ].every((values) => values.size !== 0);

    if (modernAnchorsPresent) {
        try {
            return detectModern(module, functions, xrefs, loadStart);
        } catch (error) {
            // Old builds have one SendToClientFilter owner and use the legacy
            // first-call hook. New builds have multiple owners, so silently
            // falling back there could select the wrong filter.
            if (xrefs.filterName.size !== 1) {
                throw new Error(
                    `modern WMPF layout validation failed: ${
                        error && error.message ? error.message : String(error)
                    }`,
                );
            }
        }
    }

    return detectLegacy(module, functions, xrefs, loadStart);
};

detect().then(
    (config) => send({ type: RESULT_MESSAGE, config }),
    (error) =>
        send({
            type: ERROR_MESSAGE,
            error: error && error.stack ? error.stack : String(error),
        }),
);
