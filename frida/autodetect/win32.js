"use strict";

const RESULT_MESSAGE = "wmpf-offsets";
const ERROR_MESSAGE = "wmpf-offsets-error";

const asciiPattern = (value) =>
    Array.from(value)
        .map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
        .join(" ");

const toOffset = (module, address) => address.sub(module.base).toUInt32();

const toHex = (value) => `0x${value.toString(16)}`;

const findSection = (module, name) => {
    const section = module.enumerateSections().find((item) => item.name === name);
    if (section === undefined) {
        throw new Error(`${name} section not found in ${module.name}`);
    }
    return section;
};

const loadFunctions = (module) => {
    const section = findSection(module, ".pdata");
    const bytes = section.address.readByteArray(section.size);
    if (bytes === null) {
        throw new Error("unable to read .pdata");
    }

    const view = new DataView(bytes);
    const functions = [];
    for (let offset = 0; offset + 12 <= view.byteLength; offset += 12) {
        const begin = view.getUint32(offset, true);
        const end = view.getUint32(offset + 4, true);
        if (begin !== 0 && begin < end && end <= module.size) {
            functions.push({ begin, end });
        }
    }

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

const findStringMatches = (module, value) => {
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
            // Some PE sections may not be readable after being mapped.
        }
    }

    if (matches.length === 0) {
        throw new Error(`string not found: ${value}`);
    }
    return matches;
};

const findContainingStringRanges = (module, value) =>
    findStringMatches(module, value).map(({ address, section }) => {
        let start = address;
        const lowerBound = section.address;
        for (let count = 0; count < 4096 && start.compare(lowerBound) > 0; count++) {
            if (start.sub(1).readU8() === 0) {
                break;
            }
            start = start.sub(1);
        }
        return { start: toOffset(module, start), end: toOffset(module, address) };
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

const findXrefFunctions = async (module, functions) => {
    const targets = {
        cdp: findStringMatches(module, "SendToClientFilter").map(({ address }) => {
            const offset = toOffset(module, address);
            return { start: offset, end: offset };
        }),
        loadFile: findContainingStringRanges(module, "applet_index_container.cc"),
        loadName: findContainingStringRanges(
            module,
            "AppletIndexContainer::OnLoadStart(bool",
        ),
    };
    const results = {
        cdp: new Set(),
        loadFile: new Set(),
        loadName: new Set(),
    };

    // Scan the opcode prefix because Frida match patterns cannot end in
    // wildcards. Keep only complete x64 RIP-relative LEA instructions below.
    const leaPatterns = ["48 8d", "4c 8d"];
    for (const range of module.enumerateRanges("r-x")) {
        for (const pattern of leaPatterns) {
            await scan(range.base, range.size, pattern, (address) => {
                if (address.add(7).compare(range.base.add(range.size)) > 0) {
                    return;
                }
                if ((address.add(2).readU8() & 0xc7) !== 0x05) {
                    return;
                }
                const instructionOffset = toOffset(module, address);
                const target = instructionOffset + 7 + address.add(3).readS32();
                for (const name of Object.keys(targets)) {
                    if (!targetMatches(target, targets[name])) {
                        continue;
                    }
                    const owner = findFunction(functions, instructionOffset);
                    if (owner !== null) {
                        results[name].add(owner.begin);
                    }
                }
            });
        }
    }
    return results;
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

const directCallTarget = (module, instruction) => {
    if (instruction.mnemonic !== "call") {
        return null;
    }
    const match = instruction.opStr.match(/^(0x[0-9a-f]+)$/i);
    if (match === null) {
        return null;
    }
    const target = ptr(match[1]);
    if (
        target.compare(module.base) < 0 ||
        target.compare(module.base.add(module.size)) >= 0
    ) {
        return null;
    }
    return toOffset(module, target);
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

const hasSceneComparison = (module, offset) => {
    const address = module.base.add(offset);
    for (const pattern of [
        "81 b9 c8 01 00 00",
        "83 b9 c8 01 00 00",
        "83 b8 c8 01 00 00",
    ]) {
        if (Memory.scanSync(address, 0x40, pattern).length !== 0) {
            return true;
        }
    }

    const entry = { begin: offset, end: offset + 0x40 };
    return disassemble(module, entry).some(
        (instruction) =>
            instruction.mnemonic === "cmp" &&
            instruction.opStr.includes("0x1c8") &&
            instruction.opStr.toLowerCase().includes("0x44d"),
    );
};

const findSceneCall = (module, entry) => {
    if (entry.end - entry.begin > 0x8000) {
        throw new Error("OnLoadStart function is unexpectedly large");
    }
    const instructions = disassemble(module, entry);
    const candidates = [];

    for (let index = 0; index < instructions.length; index++) {
        const instruction = instructions[index];
        const firstMatch = instruction.opStr.match(
            /^rax,\s+(?:qword ptr\s+)?\[rsi\s*\+\s*(0x[0-9a-f]+)\]/i,
        );
        if (instruction.mnemonic !== "mov" || firstMatch === null) {
            continue;
        }
        const firstOffset = Number.parseInt(firstMatch[1], 16);
        if (firstOffset === 0 || firstOffset > 0x200 || firstOffset % 8 !== 0) {
            continue;
        }

        let secondOffset = null;
        for (
            let next = index + 1;
            next < Math.min(index + 31, instructions.length);
            next++
        ) {
            const candidate = instructions[next];
            const secondMatch = candidate.opStr.match(
                /^rcx,\s+(?:qword ptr\s+)?\[rax\s*\+\s*(0x[0-9a-f]+)\]/i,
            );
            if (candidate.mnemonic === "mov" && secondMatch !== null) {
                secondOffset = Number.parseInt(secondMatch[1], 16);
                break;
            }
        }
        if (secondOffset === null) {
            continue;
        }

        for (
            let next = index + 1;
            next < Math.min(index + 41, instructions.length);
            next++
        ) {
            const callee = directCallTarget(module, instructions[next]);
            if (callee !== null && hasSceneComparison(module, callee)) {
                candidates.push({ firstOffset, secondOffset, callee });
                break;
            }
        }
    }

    const uniqueCandidates = new Map(
        candidates.map((candidate) => [
            `${candidate.firstOffset}:${candidate.secondOffset}:${candidate.callee}`,
            candidate,
        ]),
    );
    if (uniqueCandidates.size !== 1) {
        const details = Array.from(uniqueCandidates.values())
            .map(
                (candidate) =>
                    `[${candidate.firstOffset}, ${candidate.secondOffset}, ${toHex(candidate.callee)}]`,
            )
            .join(", ");
        throw new Error(
            `expected one OnLoadStart scene call, found ${uniqueCandidates.size}` +
                (details ? ` (${details})` : ""),
        );
    }
    return Array.from(uniqueCandidates.values())[0];
};

const findSceneOffsets = (module, loadStart) => {
    const sceneCall = findSceneCall(module, loadStart);
    const address = module.base.add(sceneCall.callee);
    const size = Math.min(0x200, module.size - sceneCall.callee);

    const third = Memory.scanSync(address, size, "48 8b 41 08").length
        ? 8
        : null;
    const fourthMatch = Memory.scanSync(
        address,
        size,
        "48 8b 88",
    )[0];
    const fourth = fourthMatch
        ? fourthMatch.address.add(3).readU32()
        : null;
    const fifth = Memory.scanSync(address, size, "48 8b 49 10").length
        ? 0x10
        : null;

    let sixthMatch = Memory.scanSync(
        address,
        size,
        "81 b9 ?? ?? ?? ?? 4d 04 00 00",
    )[0];
    if (sixthMatch === undefined) {
        sixthMatch = Memory.scanSync(
            address,
            size,
            "83 b9 ?? ?? ?? ?? 4d",
        )[0];
    }
    const sixth = sixthMatch ? sixthMatch.address.add(2).readU32() : null;

    if ([third, fourth, fifth, sixth].some((value) => value === null)) {
        throw new Error(
            `incomplete scene pointer chain in ${toHex(sceneCall.callee)}`,
        );
    }
    return [
        sceneCall.firstOffset,
        sceneCall.secondOffset,
        third,
        fourth,
        fifth,
        sixth,
    ];
};

const detect = async () => {
    if (Process.platform !== "windows" || Process.arch !== "x64") {
        throw new Error("automatic offset detection currently requires Windows x64");
    }
    const module = Process.findModuleByName("flue.dll");
    if (module === null) {
        throw new Error("flue.dll is not loaded");
    }

    const functions = loadFunctions(module);
    const xrefs = await findXrefFunctions(module, functions);
    const loadFunctionsWithBothStrings = new Set(
        Array.from(xrefs.loadFile).filter((address) => xrefs.loadName.has(address)),
    );
    const loadStartOffset = requireUnique(
        "AppletIndexContainer::OnLoadStart",
        loadFunctionsWithBothStrings,
    );
    const cdpParentOffset = requireUnique("SendToClientFilter", xrefs.cdp);
    const loadStart = findFunction(functions, loadStartOffset);
    const cdpParent = findFunction(functions, cdpParentOffset);
    if (loadStart === null || cdpParent === null) {
        throw new Error("unable to resolve detected function boundaries");
    }

    return {
        LoadStartHookOffset: toHex(loadStart.begin),
        CDPFilterHookOffset: toHex(findFirstCall(module, cdpParent)),
        SceneOffsets: findSceneOffsets(module, loadStart),
    };
};

detect().then(
    (config) => send({ type: RESULT_MESSAGE, config }),
    (error) =>
        send({
            type: ERROR_MESSAGE,
            error: error && error.stack ? error.stack : String(error),
        }),
);
