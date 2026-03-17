import { parseArgs } from "node:util";

type CliOptions = {
    debugPort: number;
    cdpPort: number;
    debugMain: boolean;
    debugFrida: boolean;
};

// default debugging port, do not change
const DEBUG_PORT = 9421;
// CDP port, change to whatever you like
// use this port by navigating to devtools://devtools/bundled/inspector.html?ws=127.0.0.1:${CDP_PORT}
const CDP_PORT = 62000;

const print_help = () => {
    console.log(`Usage: npx ts-node src/index.ts [options]

Options:
  --debug-port <port>  Remote debug server port (default: ${DEBUG_PORT})
  --cdp-port <port>    CDP proxy server port (default: ${CDP_PORT})
  --debug-main         Output main process debug messages
  --debug-frida        Output Frida client messages
  -h, --help           Show this help message`);
};

const parse_port = (
    name: string,
    value: string | undefined,
    defaultValue: number,
) => {
    if (value === undefined) {
        return defaultValue;
    }

    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`[main] invalid ${name}: ${value}`);
    }

    return port;
};

const parse_cli_options = (): CliOptions => {
    const { values } = parseArgs({
        options: {
            "debug-port": { type: "string" },
            "cdp-port": { type: "string" },
            "debug-main": { type: "boolean" },
            "debug-frida": { type: "boolean" },
            help: { type: "boolean", short: "h" },
        },
        allowPositionals: false,
    });

    if (values.help) {
        print_help();
        process.exit(0);
    }

    return {
        debugPort: parse_port("--debug-port", values["debug-port"], DEBUG_PORT),
        cdpPort: parse_port("--cdp-port", values["cdp-port"], CDP_PORT),
        debugMain: values["debug-main"] ?? false,
        debugFrida: values["debug-frida"] ?? false,
    };
};

export { CliOptions, parse_cli_options };
