const increment = value => Math.min(1000000000, value + 1);
/** Fixed-size counters. Disabled state keeps no activity history. */
export function createDiagnosticCounters() {
  let enabled = false, previous = 'idle', counters;
  const reset = () => { counters = { routines: { observe: 0, play: 0, rest: 0, greeting: 0 }, invitationsShown: 0, invitationsExpired: 0, invitationsAccepted: 0, invitationsLater: 0, invitationsQuiet: 0 }; };
  reset();
  return {
    configure(value) { if (enabled !== value) { enabled = value; previous = 'idle'; reset(); } },
    activity(kind) { if (!enabled) return; if (kind !== previous && Object.hasOwn(counters.routines, kind)) counters.routines[kind] = increment(counters.routines[kind]); previous = kind; },
    event(name) { if (enabled && Object.hasOwn(counters, name) && typeof counters[name] === 'number') counters[name] = increment(counters[name]); },
    snapshot() { return enabled ? structuredClone(counters) : null; },
  };
}
