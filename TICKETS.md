# Tickets

Post-MVP refactoring and improvements.

## Refactoring

### T1: Record = Data (no transformation layer)

**Status**: Open

The AT Protocol record should BE the project state directly. No transformation between record format and internal types.

**Current**:
```typescript
// store.ts - converts record to internal Project type
const project: Project = {
  schemaVersion: record.value.schemaVersion ?? 1,
  title: record.value.title,
  // ... lots of mapping
  audioPipeline: t.audioPipeline?.map((e) => ({
    type: e.type as 'audio.gain' | 'audio.pan',
    value: { value: e.value.value / 100 }, // Convert from scaled integer
  }))
}
```

**Target**:
- Store holds the record directly
- UI interprets values at render time (e.g., `value / 100` for display)
- Types match AT Protocol schema exactly
- Simplifies load/save significantly

---

### T2: Use action/submission for loadProject

**Status**: Open

Replace manual `loading` state with SolidJS Router's action/submission pattern.

**Current**:
```typescript
setStore('loading', true)
try {
  // ... fetch
} finally {
  setStore('loading', false)
}
```

**Target**:
```typescript
const loadProjectAction = action(async (agent, handle, rkey) => {
  return await getProjectByRkey(agent, rkey, handle)
})

// In component:
const submission = useSubmission(loadProjectAction)
// submission.pending for loading state
```

---

### T3: Rename getTrackBlob to getClipBlob(trackId, clipId)

**Status**: Open

Current naming implies one blob per track. A track can have multiple clips, each referencing a stem.

**Current**:
```typescript
getTrackBlob(trackIndex: number): Blob | undefined
```

**Target**:
```typescript
getClipBlob(trackId: string, clipId: string): Blob | undefined
```

Also update local state structure to support multiple clips per track.

---

### T4: Dynamic effect chain UI

**Status**: Open

Replace hardcoded `getTrackGain`/`setTrackGain`/`getTrackPan`/`setTrackPan` with generic effect chain rendering.

**Current**:
```typescript
// Hardcoded getters/setters
getTrackGain(trackIndex: number): number
setTrackGain(trackId: string, value: number)
```

**Target**:
```tsx
// Track renders its pipeline dynamically
<For each={track.audioPipeline}>
  {(effect, index) => (
    <EffectControl
      effect={effect}
      onChange={(value) => setEffectValue(track.id, index(), value)}
    />
  )}
</For>

// EffectControl switches on effect.type
function EffectControl(props: { effect: AudioEffect; onChange: (v: number) => void }) {
  switch (props.effect.type) {
    case 'audio.gain':
      return <GainSlider value={props.effect.value.value} onChange={props.onChange} />
    case 'audio.pan':
      return <PanKnob value={props.effect.value.value} onChange={props.onChange} />
    // Future effects handled automatically
  }
}
```

Benefits:
- New effects added to lexicon automatically get UI
- No hardcoded getters/setters per effect type
- Matches the data-driven architecture
