// Centralized lazy access to @tauri-apps/* modules. Each getter returns a
// cached Promise so the dynamic chunk is fetched at most once per module,
// and call sites read like `const { invoke } = await tauriCore()`.

import type * as App from "@tauri-apps/api/app";
import type * as Core from "@tauri-apps/api/core";
import type * as Webview from "@tauri-apps/api/webview";
import type * as WebviewWindow from "@tauri-apps/api/webviewWindow";
import type * as Dialog from "@tauri-apps/plugin-dialog";
import type * as Updater from "@tauri-apps/plugin-updater";
import type * as Process from "@tauri-apps/plugin-process";

let _app: Promise<typeof App> | null = null;
let _core: Promise<typeof Core> | null = null;
let _webview: Promise<typeof Webview> | null = null;
let _webviewWindow: Promise<typeof WebviewWindow> | null = null;
let _dialog: Promise<typeof Dialog> | null = null;
let _updater: Promise<typeof Updater> | null = null;
let _process: Promise<typeof Process> | null = null;

export function tauriApp(): Promise<typeof App> {
    if (!_app) {
        _app = import(
            /* webpackChunkName: "tauri-app" */ "@tauri-apps/api/app"
        );
    }
    return _app;
}

export function tauriCore(): Promise<typeof Core> {
    if (!_core) {
        _core = import(
            /* webpackChunkName: "tauri-core" */ "@tauri-apps/api/core"
        );
    }
    return _core;
}

export function tauriWebview(): Promise<typeof Webview> {
    if (!_webview) {
        _webview = import(
            /* webpackChunkName: "tauri-webview" */ "@tauri-apps/api/webview"
        );
    }
    return _webview;
}

export function tauriWebviewWindow(): Promise<typeof WebviewWindow> {
    if (!_webviewWindow) {
        _webviewWindow = import(
            /* webpackChunkName: "tauri-webview-window" */ "@tauri-apps/api/webviewWindow"
        );
    }
    return _webviewWindow;
}

export function tauriDialog(): Promise<typeof Dialog> {
    if (!_dialog) {
        _dialog = import(
            /* webpackChunkName: "tauri-dialog" */ "@tauri-apps/plugin-dialog"
        );
    }
    return _dialog;
}

export function tauriUpdater(): Promise<typeof Updater> {
    if (!_updater) {
        _updater = import(
            /* webpackChunkName: "tauri-updater" */ "@tauri-apps/plugin-updater"
        );
    }
    return _updater;
}

export function tauriProcess(): Promise<typeof Process> {
    if (!_process) {
        _process = import(
            /* webpackChunkName: "tauri-process" */ "@tauri-apps/plugin-process"
        );
    }
    return _process;
}
