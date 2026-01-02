import type { Agent } from '@atproto/api'
import { createStore, produce } from 'solid-js/store'
import type { AudioEffect, Project, Track } from '~/lib/lexicons'
import { getProjectByRkey, getStemBlob } from '../atproto/records'

// Local state extensions (not persisted to PDS)
interface LocalClipState {
  // The actual blob for playback (not serialized)
  blob?: Blob
  // Duration in ms
  duration?: number
}

export interface ProjectStore {
  project: Project
  local: {
    clips: Record<string, LocalClipState>
  }
  loading: boolean
  remoteUri: string | null
}

function createDefaultProject(): Project {
  return {
    schemaVersion: 1,
    title: 'Untitled Project',
    canvas: {
      width: 640,
      height: 360,
    },
    groups: [
      {
        type: 'grid',
        id: 'main-grid',
        columns: 2,
        rows: 2,
        members: [
          { id: 'track-0', column: 1, row: 1 },
          { id: 'track-1', column: 2, row: 1 },
          { id: 'track-2', column: 1, row: 2 },
          { id: 'track-3', column: 2, row: 2 },
        ],
      },
    ],
    // Values are scaled integers (100 = 1.0, 50 = 0.5)
    tracks: [
      {
        id: 'track-0',
        name: 'Track 1',
        clips: [],
        audioPipeline: [
          { type: 'audio.gain', value: { value: 100 } },
          { type: 'audio.pan', value: { value: 50 } },
        ],
      },
      {
        id: 'track-1',
        name: 'Track 2',
        clips: [],
        audioPipeline: [
          { type: 'audio.gain', value: { value: 100 } },
          { type: 'audio.pan', value: { value: 50 } },
        ],
      },
      {
        id: 'track-2',
        name: 'Track 3',
        clips: [],
        audioPipeline: [
          { type: 'audio.gain', value: { value: 100 } },
          { type: 'audio.pan', value: { value: 50 } },
        ],
      },
      {
        id: 'track-3',
        name: 'Track 4',
        clips: [],
        audioPipeline: [
          { type: 'audio.gain', value: { value: 100 } },
          { type: 'audio.pan', value: { value: 50 } },
        ],
      },
    ],
    createdAt: new Date().toISOString(),
  }
}

export function createProjectStore() {
  const [store, setStore] = createStore<ProjectStore>({
    project: createDefaultProject(),
    local: {
      clips: {},
    },
    loading: false,
    remoteUri: null,
  })

  const actions = {
    setTitle(title: string) {
      setStore('project', 'title', title)
      setStore('project', 'updatedAt', new Date().toISOString())
    },

    // Set effect value by index in the pipeline
    // Accepts float (0.0-1.0), stores as scaled integer
    setEffectValue(trackId: string, effectIndex: number, value: number) {
      setStore(
        'project',
        'tracks',
        (t) => t.id === trackId,
        'audioPipeline',
        effectIndex,
        (effect) => {
          if ('value' in effect && effect.value && 'value' in effect.value) {
            return { ...effect, value: { ...effect.value, value: Math.round(value * 100) } }
          }
          return effect
        }
      )
    },

    // Get effect value as float (0.0-1.0)
    getEffectValue(trackId: string, effectIndex: number): number {
      const track = store.project.tracks.find((t) => t.id === trackId)
      const effect = track?.audioPipeline?.[effectIndex]
      if (effect && 'value' in effect && effect.value && 'value' in effect.value) {
        return effect.value.value / 100
      }
      return 1 // default
    },

    // Get track's audio pipeline
    getTrackPipeline(trackId: string): AudioEffect[] {
      const track = store.project.tracks.find((t) => t.id === trackId)
      return track?.audioPipeline ?? []
    },

    addRecording(trackIndex: number, blob: Blob, duration: number) {
      const trackId = `track-${trackIndex}`
      const clipId = `clip-${trackIndex}-${Date.now()}`

      // Add clip to track (stem will be set when publishing)
      setStore(
        'project',
        'tracks',
        (t) => t.id === trackId,
        produce((track: Track) => {
          track.clips = [
            {
              id: clipId,
              offset: 0,
              duration: Math.round(duration),
            },
          ]
        })
      )

      // Store local blob reference by clipId
      setStore('local', 'clips', clipId, {
        blob,
        duration,
      })

      setStore('project', 'updatedAt', new Date().toISOString())
    },

    clearTrack(trackIndex: number) {
      const trackId = `track-${trackIndex}`
      const track = store.project.tracks.find((t) => t.id === trackId)

      // Clear local blobs for all clips on this track
      if (track) {
        for (const clip of track.clips) {
          setStore('local', 'clips', clip.id, undefined!)
        }
      }

      setStore(
        'project',
        'tracks',
        (t) => t.id === trackId,
        produce((track: Track) => {
          track.clips = []
        })
      )

      setStore('project', 'updatedAt', new Date().toISOString())
    },

    // Get clip blob by clipId
    getClipBlob(clipId: string): Blob | undefined {
      return store.local.clips[clipId]?.blob
    },

    getClipDuration(clipId: string): number | undefined {
      return store.local.clips[clipId]?.duration
    },

    hasRecording(trackIndex: number): boolean {
      const trackId = `track-${trackIndex}`
      const track = store.project.tracks.find((t) => t.id === trackId)
      return (track?.clips.length ?? 0) > 0
    },


    // Get project ready for publishing (without local state)
    getProject(): Project {
      return store.project
    },

    // Load a project by rkey (and optional handle)
    async loadProject(agent: Agent, handle: string | undefined, rkey: string) {
      setStore('loading', true)
      try {
        const record = await getProjectByRkey(agent, rkey, handle)
        setStore('project', record.value)
        setStore('remoteUri', record.uri)

        // Fetch stem blobs in parallel
        const clipsWithStems = record.value.tracks
          .flatMap((track) => track.clips)
          .filter((clip): clip is typeof clip & { stem: NonNullable<typeof clip.stem> } => !!clip.stem)

        await Promise.all(
          clipsWithStems.map(async (clip) => {
            try {
              const blob = await getStemBlob(agent, clip.stem.uri)
              setStore('local', 'clips', clip.id, {
                blob,
                duration: clip.duration,
              })
            } catch (err) {
              console.error(`Failed to fetch stem for clip ${clip.id}:`, err)
            }
          })
        )
      } finally {
        setStore('loading', false)
      }
    },

    isLoading(): boolean {
      return store.loading
    },
  }

  return { store, ...actions }
}


export type ProjectStoreActions = ReturnType<typeof createProjectStore>
