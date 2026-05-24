# Browser Compatibility & Loading Guide

Our extension is built on standard **Manifest V3** APIs. This makes it cross-browser compatible out of the box with Chrome, Firefox, Safari, and other Chromium browsers (Brave, Edge, Opera).

---

## 1. Firefox

Firefox fully supports Manifest V3 extensions. To run it locally:

1. Open **Firefox**.
2. Type `about:debugging` in the address bar and press Enter.
3. Click **This Firefox** on the left menu.
4. Click the **Load Temporary Add-on...** button.
5. Navigate to your extension folder and select the `manifest.json` file.
6. The extension is now active. Try visiting any YouTube video watch page.

> [!NOTE]
> Firefox temporary extensions are automatically removed when you restart Firefox. For permanent local usage, you can sign it via the `web-ext` CLI or upload it as a private add-on on the Firefox Add-ons Developer Hub.

---

## 2. Safari

Safari Web Extensions use standard WebExtension APIs wrapped in a native macOS/iOS App.

### Method A: Quick Developer Testing (Safari Technology Preview)
If you use Safari Technology Preview, you can load it directly:
1. Open **Safari Technology Preview**.
2. Go to **Settings** (or Preferences) -> **Advanced** -> check **Show features for web developers**.
3. In the menu bar, go to **Develop** -> check **Allow Unsigned Extensions**.
4. In the menu bar, go to **Develop** -> select **Web Extension Developer Assistant**.
5. Click **Load Extension...** and select the `/Users/paranjay/Developer/Safari:chrome transcript` folder.

### Method B: Convert to Native Safari Extension (Standard Safari)
To make it work in standard Safari, Apple provides a CLI tool that automatically wraps the extension in an Xcode project:

1. Open your terminal and run:
   ```bash
   xcrun safari-web-extension-converter "/Users/paranjay/Developer/Safari:chrome transcript"
   ```
2. This creates a folder containing an Xcode project. Xcode will open automatically.
3. Select a development team or set the build signing to **Sign to Run Locally**.
4. Press the **Run** (Play) button in Xcode. This compiles the wrapper app and registers the extension.
5. Open **Safari**.
6. Go to **Settings** -> **Advanced** -> check **Show features for web developers**.
7. Go to the **Develop** menu -> check **Allow Unsigned Extensions**.
8. Go to **Settings** -> **Extensions** tab, and toggle the checkbox next to **YouTube Auto-Transcript Drawer** to activate it.

---

## 3. Microsoft Edge & Opera & Brave

These browsers use the same Chromium engine as Google Chrome.
1. Open the Extensions page (e.g., `edge://extensions` or `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the extension folder.
