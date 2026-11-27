/**
 * Application-wide providers, passed to `bootstrapApplication` in `main.ts`.
 *
 * | Provider | Effect |
 * | --- | --- |
 * | `provideZonelessChangeDetection()` | No zone.js: views update from signals only. The frame loop runs at 60 fps outside Angular and only the signals it sets, such as the statistics four times per second, cause change detection. |
 * | `provideBrowserGlobalErrorListeners()` | Uncaught errors and unhandled promise rejections are reported to Angular's `ErrorHandler`. |
 *
 * The terrain configuration is not provided here: {@link terrain/terrain.config!TERRAIN_CONFIG | TERRAIN_CONFIG} has a root default. Add a provider for it to change the configuration application-wide.
 *
 * @module
 */
import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core';

/**
 * Application providers: zoneless change detection and global error listeners.
 */
export const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners(), provideZonelessChangeDetection()],
};
