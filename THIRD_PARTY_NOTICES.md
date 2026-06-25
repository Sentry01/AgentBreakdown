# Third-Party Notices

This project bundles the **`copilot-webview`** helper (`lib/copilot-webview.js`
and `lib/webview-child.mjs`), which is derived from the
[copilot-webview-creator](https://github.com/SteveSandersonMS/copilot-webview-creator)
plugin by **Steve Sanderson** (@SteveSandersonMS).

That code is licensed under the MIT License:

> MIT License
>
> Copyright (c) Steve Sanderson
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

## Runtime dependencies

Installed via `npm install` (see `package.json`):

- [`@webviewjs/webview`](https://www.npmjs.com/package/@webviewjs/webview) — native webview window host
- [`ws`](https://www.npmjs.com/package/ws) — WebSocket bridge between the extension and the page
