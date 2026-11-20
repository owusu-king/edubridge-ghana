import { describe, expect, it } from "vitest";
import { INSTALL_HELP, menuInstallKind } from "@/components/shell/install";

/** How real browsers identify themselves (synthetic version numbers). */
const UA = {
  firefoxAndroid: "Mozilla/5.0 (Android 14; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0",
  firefoxWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  chromeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  chromeIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
  edgeIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/131.0.2903.68 Mobile/15E148 Safari/605.1.15",
  firefoxIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/133.0 Mobile/15E148 Safari/605.1.15",
  chromeOldIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/110.0.5481.83 Mobile/15E148 Safari/604.1",
  inAppIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 357.0.0.25.101",
  safariMac17:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  safariMac16:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15",
};

describe("installing from the browser's own menu", () => {
  it("points Firefox on Android to its menu", () => {
    expect(menuInstallKind(UA.firefoxAndroid, 5)).toBe("firefox-android");
    expect(INSTALL_HELP["firefox-android"]).toMatch(/Firefox's menu/);
  });

  it("offers nothing where the page cannot help: Firefox on a computer, old iOS, in-app browsers", () => {
    expect(menuInstallKind(UA.firefoxWindows, 0)).toBeNull();
    expect(menuInstallKind(UA.chromeOldIphone, 5)).toBeNull();
    expect(menuInstallKind(UA.inAppIphone, 5)).toBeNull();
  });

  it("points Chrome, Edge and Firefox on iPhone (iOS 16.4 and later) to their Share menu", () => {
    expect(menuInstallKind(UA.chromeIphone, 5)).toBe("ios-browser");
    expect(menuInstallKind(UA.edgeIphone, 5)).toBe("ios-browser");
    expect(menuInstallKind(UA.firefoxIphone, 5)).toBe("ios-browser");
    expect(INSTALL_HELP["ios-browser"]).toMatch(/Add to Home Screen/);
  });

  it("leaves Chrome and Edge to their own announcement", () => {
    expect(menuInstallKind(UA.chromeWindows, 0)).toBeNull();
    expect(menuInstallKind(UA.edgeWindows, 0)).toBeNull();
    expect(menuInstallKind(UA.chromeAndroid, 5)).toBeNull();
  });

  it("points Safari to Add to Home Screen on iPhone and iPad, and to the Dock on a recent Mac", () => {
    expect(menuInstallKind(UA.safariIphone, 5)).toBe("safari-ios");
    // An iPad asking for the desktop site looks like a Mac, but has a touch screen.
    expect(menuInstallKind(UA.safariMac17, 5)).toBe("safari-ios");
    expect(menuInstallKind(UA.safariMac17, 0)).toBe("safari-mac");
    expect(menuInstallKind(UA.safariMac16, 0)).toBeNull();
  });
});
