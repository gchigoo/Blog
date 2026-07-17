const states = new WeakMap();

function stateFor(db) {
  let state = states.get(db);
  if (!state) {
    state = { version: 0, values: new Map() };
    states.set(db, state);
  }
  return state;
}

function markOverviewDirty(db) {
  const state = stateFor(db);
  state.version += 1;
  state.values.clear();
}

function getCachedOverview(db, key) {
  const state = stateFor(db);
  return state.values.get(`${state.version}:${key}`) || null;
}

function setCachedOverview(db, key, value) {
  const state = stateFor(db);
  while (state.values.size >= 8) {
    state.values.delete(state.values.keys().next().value);
  }
  state.values.set(`${state.version}:${key}`, value);
}

module.exports = { getCachedOverview, markOverviewDirty, setCachedOverview };
