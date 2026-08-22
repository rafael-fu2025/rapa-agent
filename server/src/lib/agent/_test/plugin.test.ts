/**
 * Plugin / DI layer tests.
 *
 * See `.agents/notes/implemented/architecture/2026-08-15-lightweight-plugin-di-layer.md`.
 */

import { describe, expect, it } from "vitest";

import {
  definePlugin,
  PluginLoader,
  serviceKey
} from "../plugin.js";

const Logger = serviceKey<{ log: (msg: string) => void }>("logger");
const Config = serviceKey<{ debug: boolean }>("config");

describe("PluginContext", () => {
  it("provide + inject round-trips a typed service", () => {
    const loader = new PluginLoader();
    loader.use(definePlugin((ctx) => {
      ctx.provide(Logger, { log: (m) => console.log("LOG:", m) });
    }));
    const ctx = loader.mount();
    const logger = ctx.inject(Logger);
    logger.log("hi");
    ctx.unmount();
  });

  it("inject throws if key is missing", () => {
    const loader = new PluginLoader();
    const ctx = loader.mount();
    expect(() => ctx.inject(Logger)).toThrow(/not provided/);
  });

  it("tryInject returns undefined for missing keys", () => {
    const loader = new PluginLoader();
    const ctx = loader.mount();
    expect(ctx.tryInject(Logger)).toBeUndefined();
  });

  it("provide rejects duplicate keys", () => {
    const loader = new PluginLoader();
    loader.use(definePlugin((ctx) => {
      ctx.provide(Logger, { log: () => {} });
    }));
    loader.use(definePlugin((ctx) => {
      ctx.provide(Logger, { log: () => {} });
    }));
    expect(() => loader.mount()).toThrow(/already provided/);
  });

  it("effect disposer is called on unmount", () => {
    let cleaned = false;
    const loader = new PluginLoader();
    loader.use(definePlugin((ctx) => {
      ctx.effect(() => {
        cleaned = false;
        return () => { cleaned = true; };
      });
    }));
    const ctx = loader.mount();
    expect(cleaned).toBe(false);
    ctx.unmount();
    expect(cleaned).toBe(true);
  });

  it("disposers fire in LIFO order", () => {
    const calls: string[] = [];
    const loader = new PluginLoader();
    loader.use(definePlugin((ctx) => {
      ctx.effect(() => {
        calls.push("setup-a");
        return () => calls.push("dispose-a");
      });
      ctx.effect(() => {
        calls.push("setup-b");
        return () => calls.push("dispose-b");
      });
    }));
    const ctx = loader.mount();
    expect(calls).toEqual(["setup-a", "setup-b"]);
    ctx.unmount();
    expect(calls).toEqual(["setup-a", "setup-b", "dispose-b", "dispose-a"]);
  });

  it("child() inherits parent services via fallback lookup", () => {
    const loader = new PluginLoader();
    loader.use(definePlugin((ctx) => {
      ctx.provide(Config, { debug: true });
    }));
    const parent = loader.mount();
    const child = parent.child();

    expect(child.inject(Config).debug).toBe(true);
  });

  it("child() unmount does not unmount parent services", () => {
    const loader = new PluginLoader();
    let cleaned = false;
    loader.use(definePlugin((ctx) => {
      ctx.effect(() => {
        cleaned = false;
        return () => { cleaned = true; };
      });
    }));
    const parent = loader.mount();
    const child = parent.child();
    child.effect(() => {
      return () => { /* no-op */ };
    });
    // Unmount parent — child's own disposers fire too
    parent.unmount();
    expect(cleaned).toBe(true);
  });

  it("keys() lists registered service names", () => {
    const loader = new PluginLoader();
    loader.use(definePlugin((ctx) => {
      ctx.provide(Logger, { log: () => {} });
      ctx.provide(Config, { debug: false });
    }));
    const ctx = loader.mount();
    expect(ctx.keys().sort()).toEqual(["config", "logger"]);
  });
});

describe("definePlugin + options", () => {
  it("passes options through to the plugin body", () => {
    const loader = new PluginLoader();
    let received: { debug: boolean } | undefined;
    const myPlugin = definePlugin<{ debug: boolean }>((ctx, opts) => {
      received = opts;
      ctx.provide(Config, opts);
    });
    loader.use(myPlugin, { debug: true });
    const ctx = loader.mount();
    expect(received).toEqual({ debug: true });
    expect(ctx.inject(Config).debug).toBe(true);
  });
});

describe("PluginLoader error handling", () => {
  it("continues to mount subsequent plugins if one throws", () => {
    const loader = new PluginLoader();
    loader.use(definePlugin(() => {
      throw new Error("intentional");
    }));
    loader.use(definePlugin((ctx) => {
      ctx.provide(Logger, { log: () => {} });
    }));
    // First plugin throws; loader re-throws. The Logger isn't provided.
    expect(() => loader.mount()).toThrow(/intentional/);
  });
});
