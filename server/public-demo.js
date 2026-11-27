// Shared by all visitors to the open rehearsal. Counters survive service restarts.
const limits = { audioSeconds: 4 * 60 * 60, modelRequests: 3_600 };
const messages = {
  audioSeconds: '今天的公开体验收音额度已用完，仍可手写金句上屏。',
  modelRequests: '今天的公开体验提炼额度已用完，仍可手写金句上屏。',
};
const beijingDay = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

export function demoAllowance(store) {
  function charge(resource, amount) {
    store.transaction(() => {
      const day = beijingDay();
      const previous = store.get('publicDemoUsage');
      const usage = previous?.day === day ? previous : { day, audioSeconds: 0, modelRequests: 0 };
      if (usage[resource] + amount > limits[resource]) {
        throw Object.assign(new Error(messages[resource]), { status: 429 });
      }
      usage[resource] += amount;
      store.set('publicDemoUsage', usage);
    });
  }
  return {
    modelRequest: () => charge('modelRequests', 1),
    startAudio() {
      charge('audioSeconds', 1);
      const start = performance.now();
      let charged = 1;
      return (receivedMs) => {
        const seconds = Math.ceil(Math.max(performance.now() - start, receivedMs) / 1000);
        if (seconds > charged) {
          charge('audioSeconds', seconds - charged);
          charged = seconds;
        }
      };
    },
  };
}
