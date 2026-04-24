export function memoryStore({
  runId = 'run-1',
  dir = '',
  writeTracking = 'list',
  onWrite,
  writeJson = true,
  valueKey = 'value',
  stringifyWrites = false,
} = {}) {
  const writes = createWriteTracker(writeTracking);
  const store = {
    runId,
    dir,
    async write(name, value) {
      recordWrite(writes, writeTracking, name, value, {
        onWrite,
        stringifyWrites,
        valueKey,
      });
      return memoryStorePath(dir, name);
    },
  };

  if (writeJson) {
    store.writeJson = async (name, value) => {
      recordWrite(writes, writeTracking, name, value, {
        onWrite,
        stringifyWrites,
        valueKey,
      });
      return memoryStorePath(dir, name);
    };
  }

  if (writes !== undefined) {
    store.writes = writes;
  }

  return store;
}

function createWriteTracker(writeTracking) {
  if (writeTracking === 'list') return [];
  if (writeTracking === 'map') return new Map();
  if (writeTracking === false || writeTracking === 'none') return undefined;
  throw new Error(`unsupported memory store write tracking: ${writeTracking}`);
}

function recordWrite(writes, writeTracking, name, value, {
  onWrite,
  stringifyWrites,
  valueKey,
}) {
  const recordedValue = stringifyWrites ? String(value || '') : value;
  const record = { name, [valueKey]: recordedValue };
  if (writes === undefined) {
    onWrite?.(record);
    return;
  }
  if (writeTracking === 'map') {
    writes.set(name, recordedValue);
    onWrite?.(record);
    return;
  }
  writes.push(record);
  onWrite?.(record);
}

function memoryStorePath(dir, name) {
  if (!dir) return name;
  const normalizedDir = String(dir).replace(/\/+$/, '');
  return `${normalizedDir}/${name}`;
}
