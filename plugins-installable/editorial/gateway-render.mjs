// Image rendering is a HOST capability (resvg WASM plus bundled fonts) that
// this install does not carry. The pack still declares the gateway so every
// call gets one honest sentence instead of a crash, and the text side of
// Editorial keeps working. If a host ever ships render again, the binding
// prefers the host and these stubs disappear.
const OFF = {
  ok: false,
  error: 'Image rendering is not available on this install. Editorial writes and publishes text; covers, figures and social cards are off.',
};
export const gateway = {
  slug: 'render',
  service: 'image rendering (not available on this install)',
  description: 'Reports honestly that covers, figures, cards and images cannot be rendered here.',
  modes: { card: async () => OFF, cover: async () => OFF, figures: async () => OFF, images: async () => OFF },
};
