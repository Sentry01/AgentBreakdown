// Bootstrapper. Copilot CLI loads this file. The webview helper needs npm
// deps (@webviewjs/webview, ws); bootstrap installs them if missing, then we
// load the real extension logic from main.mjs.
import { bootstrap } from "./lib/copilot-webview.js";

await bootstrap(import.meta.dirname);
await import("./main.mjs");
