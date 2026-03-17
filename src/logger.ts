import { CliOptions } from "./cli";

type Logger = {
    info: (...messages: unknown[]) => void;
    error: (...messages: unknown[]) => void;
    main_debug: (...messages: unknown[]) => void;
    frida_debug: (...messages: unknown[]) => void;
};

const create_logger = (options: CliOptions): Logger => ({
    info: (...messages) => {
        console.log(...messages);
    },
    error: (...messages) => {
        console.error(...messages);
    },
    main_debug: (...messages) => {
        if (options.debugMain) {
            console.log(...messages);
        }
    },
    frida_debug: (...messages) => {
        if (options.debugFrida) {
            console.log(...messages);
        }
    },
});

export { Logger, create_logger };
