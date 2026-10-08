/* Merge missing browser-local records into the cloud snapshot without replacing cloud values. */
(function () {
  const MAP_FIELDS = ['answers', 'records', 'starts', 'questionnaires', 'questionnaireDrafts', 'consents'];

  function clone(value) {
    return JSON.parse(JSON.stringify(value ?? {}));
  }

  function stableSerialize(value) {
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function mergeParticipantStates(localState, cloudState, participantId) {
    const local = localState?.participantId === Number(participantId)
      && !(cloudState?.clearedAt && (!localState.lastModified || localState.lastModified <= cloudState.clearedAt))
      ? localState : {};
    const cloud = cloudState || {};
    const merged = { ...clone(cloud), participantId: Number(participantId) };
    const added = {};
    const conflicts = [];

    MAP_FIELDS.forEach((field) => {
      const localMap = local[field] && typeof local[field] === 'object' ? local[field] : {};
      const cloudMap = cloud[field] && typeof cloud[field] === 'object' ? cloud[field] : {};
      const mergedMap = { ...clone(cloudMap) };
      added[field] = 0;

      Object.entries(localMap).forEach(([key, value]) => {
        if (!Object.prototype.hasOwnProperty.call(cloudMap, key)) {
          mergedMap[key] = clone(value);
          added[field] += 1;
        } else if (stableSerialize(cloudMap[key]) !== stableSerialize(value)) {
          conflicts.push({ field, key });
        }
      });
      merged[field] = mergedMap;
    });

    // Cloud owns session progress/scalars; completeness is recalculated from the merged records.
    ['currentStage', 'questionnaireMode', 'activeQuestionnaireType'].forEach((field) => {
      if (cloud[field] === undefined && local[field] !== undefined) merged[field] = local[field];
    });

    return { state: merged, added, conflicts };
  }

  window.ExperimentSync = { mergeParticipantStates };
})();
