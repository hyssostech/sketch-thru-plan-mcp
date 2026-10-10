---
id: iframe-embedding
title: iFrame Embedding
sidebar_position: 9
---

# iFrame Embedding

An STP-enabled app can be embedded in an iFrame, in addition to using the SDK directly. This is useful for integrating STP into existing portals or CMS pages.

## Basic Usage

To allow microphone access when the hosting page domain differs from the iframe's, add the `allow="microphone"` attribute:

```html
<iframe
    src="https://server.com/stpapp"
    allow="microphone"
    scrolling="no"
    width="100%"
    height="800">
</iframe>
```

:::warning HTTPS Required
Speech services require **HTTPS**. Ensure both the hosting page and the iframe source use valid SSL certificates. Without HTTPS, browsers will either block microphone access or repeatedly request authorization.
:::

## Troubleshooting Microphone Access

If you see speech recognition errors after placing a stroke on the map:

1. **No microphone**: a physical microphone must be connected and operational
2. **Mixed HTTP/HTTPS**: if the hosting page is HTTP but the iframe source is HTTPS, the speech connection may be blocked
3. **Remote desktop**: if running in a VM via remote desktop, additional configuration may be needed to redirect local audio to the VM
4. **Expired credentials**: verify that the Azure Speech API key is correct and not expired

## Live Example

A working cross-origin iframe sample is available at:

See the [iframe sample](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/samples/iframe) for a working example.

```html
<iframe
    src="https://stp.hyssos.com/gmaps/index.html?lat=31.27&lon=-97.57&zoom=16"
    allow="microphone"
    scrolling="no"
    width="100%"
    height="800">
</iframe>
```

---

:::info Source & Samples
Full iframe embedding sample: [sketch-thru-plan-sdk-js/samples/iframe](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/samples/iframe)
:::
