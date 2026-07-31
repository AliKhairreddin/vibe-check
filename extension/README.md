# Vibe Check Live Scanner

This unpacked Chrome extension observes Meta Ads Manager automatically. It submits live ad metadata to Vibe Check, sends every unique primary-text variant as a text-only review, and uploads media only when Vibe Check has not already reviewed that creative name.

## Install internally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `extension` directory.
4. Open the extension’s **Settings** and confirm the Vibe Check URL.
5. Enter the Vibe Check app password if the deployment uses one.

No scan button is required. The content script activates when Ads Manager opens, when the selected ad account changes, when the tab regains focus, and periodically while the page remains open.

## Data and identity rules

- The Ads Manager ad name is treated as the creative name and the primary creative deduplication key.
- Common media extensions, punctuation, whitespace, and letter case are normalized before matching.
- Different primary texts never cause the media creative to be processed again. Each exact normalized primary text receives its own text-only review.
- Facebook cookies, passwords, and session tokens are never transmitted to Vibe Check.
- The extension only uploads media URLs hosted by Facebook, Instagram, or Facebook CDN domains.

## Operational limitation

The collector depends on Ads Manager’s frontend response shapes. Meta can change those responses without notice. The Live Scans page will show `Capturing media` when the extension can identify a live creative by name but cannot recover an accessible image or video URL from the current page data.
