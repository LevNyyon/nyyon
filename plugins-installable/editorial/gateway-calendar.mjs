// Scheduling into a calendar is a host capability this install does not have.
// The pack declares the gateway so scheduling paths report one honest
// sentence; publishing and drafting are unaffected.
const OFF = {
  ok: false,
  error: 'Calendar scheduling is not available on this install. Publish now, or track dates in the plan.',
};
export const gateway = {
  slug: 'calendar',
  service: 'calendar scheduling (not available on this install)',
  description: 'Reports honestly that calendar scheduling is off.',
  modes: { upsert: async () => OFF, remove: async () => OFF },
};
