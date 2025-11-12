import EventEmitter from "eventemitter3";

/**
 * Central event emitter to break circular dependencies between services.
 */
export const serviceEvents = new EventEmitter();
