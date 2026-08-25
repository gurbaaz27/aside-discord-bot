import { Layer, ManagedRuntime } from "effect";
import { AsideBridge } from "./aside.ts";
import { AppConfig, loadConfig } from "./config.ts";
import { StateStore } from "./state.ts";
import { TurnRunner } from "./turn.ts";

/**
 * Loaded eagerly so an invalid environment fails at startup rather than on
 * the first Discord interaction.
 */
export const config = loadConfig();

const ConfigLayer = Layer.succeed(AppConfig, config);

/**
 * Every service the Discord layer needs.
 *
 * `provideMerge` keeps the dependencies in the output too, so handlers can
 * reach `StateStore` and `AsideBridge` directly and not only through
 * `TurnRunner`.
 */
export const AppLayer = TurnRunner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(AsideBridge.layer, StateStore.layer)),
  Layer.provideMerge(ConfigLayer),
);

/**
 * Bridges the imperative discord.js callbacks to Effect.
 *
 * Disposing it closes the layer scope, which interrupts any surviving turn
 * fibers and kills their child processes.
 */
export const runtime = ManagedRuntime.make(AppLayer);
