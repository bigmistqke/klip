import { Agent } from '@atproto/api'
import type { Project, StemRef } from '../project/types'

export interface RecordRef {
  uri: string
  cid: string
}

export interface ProjectListItem {
  uri: string
  cid: string
  title: string
  createdAt: string
  trackCount: number
}

export async function listProjects(agent: Agent): Promise<ProjectListItem[]> {
  const response = await agent.com.atproto.repo.listRecords({
    repo: agent.assertDid,
    collection: 'app.klip.project',
    limit: 50,
  })

  return response.data.records.map((record) => {
    const value = record.value as {
      title?: string
      createdAt?: string
      tracks?: unknown[]
    }
    return {
      uri: record.uri,
      cid: record.cid,
      title: value.title ?? 'Untitled',
      createdAt: value.createdAt ?? '',
      trackCount: value.tracks?.length ?? 0,
    }
  })
}

export async function uploadBlob(
  agent: Agent,
  blob: Blob
) {
  const response = await agent.uploadBlob(blob, {
    encoding: blob.type,
  })
  return response.data.blob
}

export async function createStemRecord(
  agent: Agent,
  blob: Blob,
  duration: number
): Promise<RecordRef> {
  const uploadedBlob = await uploadBlob(agent, blob)

  const record = {
    $type: 'app.klip.stem',
    schemaVersion: 1,
    blob: uploadedBlob,
    type: 'video',
    mimeType: blob.type,
    duration: Math.round(duration),
    video: {
      hasAudio: true,
    },
    createdAt: new Date().toISOString(),
  }

  const response = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: 'app.klip.stem',
    record,
  })

  return {
    uri: response.data.uri,
    cid: response.data.cid,
  }
}

export async function publishProject(
  agent: Agent,
  project: Project,
  trackBlobs: Map<string, { blob: Blob; duration: number }>
): Promise<RecordRef> {
  // Upload stems for tracks that have local blobs
  const stemRefs = new Map<string, StemRef>()

  for (const [trackId, { blob, duration }] of trackBlobs) {
    const stemRecord = await createStemRecord(agent, blob, duration)
    stemRefs.set(trackId, {
      uri: stemRecord.uri,
      cid: stemRecord.cid,
    })
  }

  // Build tracks with audioPipeline using full $type paths for union discrimination
  // AT Protocol requires $type with "lexiconId#localRef" format for unions
  const tracks = project.tracks
    .filter((track) => stemRefs.has(track.id))
    .map((track) => {
      const gainEffect = track.audioPipeline?.find(e => e.type === 'audio.gain')
      const panEffect = track.audioPipeline?.find(e => e.type === 'audio.pan')
      return {
        id: track.id,
        clips: track.clips.map((clip) => ({
          id: clip.id,
          offset: clip.offset,
          duration: clip.duration,
        })),
        stem: stemRefs.get(track.id),
        // Use integers scaled by 100 since AT Protocol doesn't support floats
        // (e.g., 100 = 1.0, 50 = 0.5)
        audioPipeline: [
          {
            type: 'audio.gain',
            value: {
              value: Math.round((gainEffect?.value.value ?? 1) * 100),
            },
          },
          {
            type: 'audio.pan',
            value: {
              value: Math.round((panEffect?.value.value ?? 0.5) * 100),
            },
          },
        ],
      }
    })

  // Build project record
  const record = {
    $type: 'app.klip.project',
    schemaVersion: 1,
    title: project.title,
    canvas: {
      width: project.canvas.width,
      height: project.canvas.height,
    },
    groups: project.groups.map((group) => ({
      type: group.type,
      id: group.id,
      columns: group.columns,
      rows: group.rows,
      members: group.members.map((m) => ({ id: m.id })),
    })),
    tracks,
    createdAt: project.createdAt,
  }

  console.log('Creating project record:', JSON.stringify(record, null, 2))

  // Note: Local validation with @atproto/lexicon doesn't support union types
  // The PDS will validate the record server-side

  const response = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: 'app.klip.project',
    record,
  })

  return {
    uri: response.data.uri,
    cid: response.data.cid,
  }
}
